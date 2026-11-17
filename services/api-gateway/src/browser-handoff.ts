/**
 * ブラウザの引き継ぎ（本人の方針 2026-10-30「仮想ブラウザがつまずいたら、画面を見せて本人が操作できるように」）。
 *
 *   端末（Genie 専用のブラウザ）がログインの壁に当たる
 *     → POST /v1/browser-handoffs（その step を取っている端末だけ）→ 本人に LINE でリンク（15 分・本人だけ）
 *   本人が LIFF のページを開く → WebSocket で画面の流れを見て、押す・スクロール・文字を送る
 *   端末は画面を POST で送り、本人の操作を取りに来る（長く待つ問い合わせ。gateway から端末へは繋がない）
 *   ログインが済んだ（端末が画面で確かめる）か「Genie に戻す」→ 端末が続きを読む
 *
 * 画面の画像と入力（文字）は**残さない**。このプロセスのメモリで取り次ぐだけ（記録・ログにも書かない）。
 * DB に残すのは、いつ・どのサイト（ホスト名）で・どうなったか（browser_handoffs）。
 * Genie と本人が同時に操作することは無い（Genie は引き継ぎの間、自分では入力しない。端末側で守る）。
 */
import { createHash, randomBytes } from 'node:crypto';
import { sql } from 'kysely';
import { z } from 'zod';
import { uuidv7 } from '@genie/contracts';
import { withIdentity, withTenant, type DbHandle } from '@genie/db';

export const HANDOFF_MINUTES = 15;
const hash = (token: string) => createHash('sha256').update(token).digest('hex');
const LIFF_ID = /^\d+-[A-Za-z0-9]+$/;

export type HandoffEnd = 'resumed' | 'timed_out' | 'cancelled' | 'failed';

export interface HandoffRow {
  readonly id: string;
  readonly tenantId: string;
  readonly userId: string;
  readonly taskId: string;
  readonly hostId: string;
  readonly site: string;
  readonly state: 'waiting' | HandoffEnd;
  readonly expiresAt: Date;
}

export class HandoffStore {
  constructor(private readonly db: DbHandle) {}

  /** 平文のリンクは返すだけ。残すのはハッシュ。 */
  async create(input: {
    readonly tenantId: string;
    readonly userId: string;
    readonly taskId: string;
    readonly requestId: string;
    readonly hostId: string;
    readonly site: string;
    readonly now: Date;
  }): Promise<{ id: string; token: string; expiresAt: Date }> {
    const token = randomBytes(24).toString('base64url');
    const id = uuidv7();
    const expiresAt = new Date(input.now.getTime() + HANDOFF_MINUTES * 60_000);
    await withTenant(this.db, input.tenantId, (tx) =>
      tx
        .insertInto('browser_handoffs')
        .values({
          id,
          tenant_id: input.tenantId,
          user_id: input.userId,
          task_id: input.taskId,
          request_id: input.requestId,
          host_id: input.hostId,
          reason: 'login_required',
          site: input.site,
          token_hash: hash(token),
          expires_at: expiresAt,
        })
        .execute(),
    );
    return { id, token, expiresAt };
  }

  /** リンクから引き継ぎを引く（ページはサインインしない）。終わった・切れたものは null。 */
  async byToken(token: string): Promise<{ id: string; tenantId: string; userId: string } | null> {
    const row = await withIdentity(this.db, (tx) =>
      tx
        .selectFrom('browser_handoffs')
        .select(['id', 'tenant_id', 'user_id'])
        .where('token_hash', '=', hash(token))
        .where('state', '=', 'waiting')
        .where('expires_at', '>', sql<Date>`now()`)
        .executeTakeFirst(),
    );
    return row ? { id: row.id, tenantId: row.tenant_id, userId: row.user_id } : null;
  }

  async get(tenantId: string, id: string): Promise<HandoffRow | null> {
    const row = await withTenant(this.db, tenantId, (tx) =>
      tx.selectFrom('browser_handoffs').selectAll().where('id', '=', id).executeTakeFirst(),
    );
    return row
      ? {
          id: row.id,
          tenantId: row.tenant_id,
          userId: row.user_id,
          taskId: row.task_id,
          hostId: row.host_id,
          site: row.site,
          state: row.state as HandoffRow['state'],
          expiresAt: new Date(row.expires_at),
        }
      : null;
  }

  /** 終わりを記録する（待っている間のものだけ。二度目は何もしない）。 */
  async end(tenantId: string, id: string, state: HandoffEnd): Promise<boolean> {
    const done = await withTenant(this.db, tenantId, (tx) =>
      tx
        .updateTable('browser_handoffs')
        .set({ state, ended_at: sql<Date>`now()` })
        .where('id', '=', id)
        .where('state', '=', 'waiting')
        .executeTakeFirst(),
    );
    return Number(done.numUpdatedRows) > 0;
  }
}

/** 本人の操作（LIFF のページから）。座標は端末の画面（CSS の画素）。 */
export const HandoffInput = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('tap'),
      x: z.number().min(0).max(4000),
      y: z.number().min(0).max(8000),
    })
    .strict(),
  z
    .object({
      type: z.literal('scroll'),
      x: z.number().min(0).max(4000),
      y: z.number().min(0).max(8000),
      dx: z.number().min(-8000).max(8000),
      dy: z.number().min(-8000).max(8000),
    })
    .strict(),
  z.object({ type: z.literal('text'), text: z.string().min(1).max(200) }).strict(),
  z
    .object({
      type: z.literal('key'),
      name: z.enum([
        'Enter',
        'Backspace',
        'Tab',
        'Escape',
        'ArrowUp',
        'ArrowDown',
        'ArrowLeft',
        'ArrowRight',
      ]),
    })
    .strict(),
  // 「Genie に戻す」「やめる」
  z.object({ type: z.literal('done') }).strict(),
  z.object({ type: z.literal('cancel') }).strict(),
]);
export type HandoffInput = z.infer<typeof HandoffInput>;

export interface HandoffFrame {
  readonly jpeg: string;
  readonly width: number;
  readonly height: number;
  /** 端末のブラウザでパスワードの欄が選ばれている（ページの入力欄を伏せ字にする）。 */
  readonly password: boolean;
}

type ViewerMessage =
  | ({ readonly type: 'frame' } & HandoffFrame)
  | { readonly type: 'ended'; readonly state: HandoffEnd };

interface Live {
  frame: HandoffFrame | null;
  inputs: HandoffInput[];
  waiters: (() => void)[];
  viewers: Set<(message: ViewerMessage) => void>;
  ended: HandoffEnd | null;
  timer: NodeJS.Timeout;
}

const MAX_QUEUE = 100;

/**
 * 画面と入力の取り次ぎ（このプロセスのメモリだけ。保存しない）。
 * 終わったら（または期限で）画面も入力も捨てる。
 */
export class HandoffHub {
  readonly #live = new Map<string, Live>();

  open(id: string, expiresAt: Date): void {
    if (this.#live.has(id)) return;
    const timer = setTimeout(
      () => this.end(id, 'timed_out'),
      Math.max(0, expiresAt.getTime() - Date.now()),
    );
    timer.unref?.();
    this.#live.set(id, {
      frame: null,
      inputs: [],
      waiters: [],
      viewers: new Set(),
      ended: null,
      timer,
    });
  }

  isOpen(id: string): boolean {
    const live = this.#live.get(id);
    return Boolean(live && !live.ended);
  }

  frame(id: string, frame: HandoffFrame): boolean {
    const live = this.#live.get(id);
    if (!live || live.ended) return false;
    live.frame = frame;
    for (const viewer of live.viewers) viewer({ type: 'frame', ...frame });
    return true;
  }

  push(id: string, input: HandoffInput): boolean {
    const live = this.#live.get(id);
    if (!live || live.ended) return false;
    if (live.inputs.length >= MAX_QUEUE) live.inputs.shift();
    live.inputs.push(input);
    for (const wake of live.waiters.splice(0)) wake();
    return true;
  }

  /** 端末が本人の操作を取りに来る。無ければ waitMs まで待つ。終わっていれば ended を返す。 */
  async take(
    id: string,
    waitMs: number,
  ): Promise<{ inputs: HandoffInput[]; ended: HandoffEnd | null } | null> {
    const live = this.#live.get(id);
    if (!live) return null;
    if (live.inputs.length === 0 && !live.ended)
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, waitMs);
        live.waiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    return { inputs: live.inputs.splice(0), ended: live.ended };
  }

  /** 本人のページ。最新の画面をすぐに渡し、以後の画面を流す。 */
  watch(id: string, viewer: (message: ViewerMessage) => void): (() => void) | null {
    const live = this.#live.get(id);
    if (!live || live.ended) return null;
    live.viewers.add(viewer);
    if (live.frame) viewer({ type: 'frame', ...live.frame });
    return () => live.viewers.delete(viewer);
  }

  end(id: string, state: HandoffEnd): void {
    const live = this.#live.get(id);
    if (!live || live.ended) return;
    live.ended = state;
    live.frame = null;
    clearTimeout(live.timer);
    for (const viewer of live.viewers) viewer({ type: 'ended', state });
    live.viewers.clear();
    for (const wake of live.waiters.splice(0)) wake();
    // 端末が終わりを受け取れるよう少し残してから捨てる
    setTimeout(() => this.#live.delete(id), 60_000).unref?.();
  }
}

/**
 * 引き継ぎのリンク。LIFF の ID があれば、計画ボードと同じ LIFF の入口を `/h/<リンク>` で開く（LINE の中で開く）。
 * 無ければ公開の先頭の直のリンク。どちらも無ければ null（引き継げない）。
 */
export function handoffUrlFor(config: {
  readonly publicUrl: string | null;
  readonly liffId: string | null;
}): (token: string) => string | null {
  const liffId = config.liffId?.trim() || null;
  if (liffId && LIFF_ID.test(liffId)) return (token) => `https://liff.line.me/${liffId}/h/${token}`;
  return (token) => (config.publicUrl ? `${config.publicUrl}/v1/channels/handoff/${token}` : null);
}

/** 本人への知らせ（LINE）。何が起きて、何をすれば Genie が続けるかを言う。 */
export function handoffNotice(site: string, url: string): string {
  return [
    `${site} のページはログインが要るため、Genie が読めずに止まっています。`,
    `下のリンクから画面を開いて、ログインだけお願いします（${String(HANDOFF_MINUTES)} 分使えるあなた専用のリンクです）。終わったら、残りは Genie が続けます。`,
    url,
    'ログインの情報は Genie の記録には残しません。決済や送信が出てきても、Genie はあなたの承認なしには進めません。',
  ].join('\n');
}
