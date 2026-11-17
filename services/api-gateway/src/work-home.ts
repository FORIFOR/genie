/**
 * 仕事のホーム（本人の方針 2026-10-29「タスク管理を意識させない。確認が必要なものだけ目立たせる」）。
 * LINE から開くページ（work-page.ts）。ふだんは開かず、確かめたいときにだけ開く。
 *
 *   「仕事のホームを開いて」「マイページ」 → 本人だけが開けるリンク（30 日・読むだけ）を返す
 *   ページ → /state（あなたの確認が必要なもの → 件数 → 進行中・終わったもの・保留・続き）
 *         → 行を開くと /item/s/<id>・/item/t/<id>（仕事の台帳: 次に要ること・完了条件・経過・判断）
 *
 * ページは公開の場所（トンネル）を通るので、計画ボードと同じく中身を絞る:
 *   - Claude Code の頼みの頭は出さない（フォルダ名と状態だけ）。台帳の request も落とす
 *   - 変える道は無い（変えるのは LINE の会話で）
 */
import { createHash, randomBytes } from 'node:crypto';
import { sql } from 'kysely';
import { isTerminal, type TaskListItem, type TaskStatus } from '@genie/contracts';
import { withIdentity, withTenant, type DbHandle } from '@genie/db';
import { attentionFor, type AgentSession, type Attention } from './agent-sessions.js';
import { composeOverview, type OverviewInput } from './work-desk.js';
import { STATUS_TEXT, type Ledger } from './work-ledger.js';
import { describeDate } from './work-holds.js';

const LINK_DAYS = 30;
const hash = (token: string) => createHash('sha256').update(token).digest('hex');
const LIFF_ID = /^\d+-[A-Za-z0-9]+$/;

export class WorkLinkStore {
  constructor(private readonly db: DbHandle) {}

  /** 平文は返すだけ。残すのはハッシュ。 */
  async issue(tenantId: string, userId: string, now: Date): Promise<string> {
    const token = randomBytes(24).toString('base64url');
    await withTenant(this.db, tenantId, (tx) =>
      tx
        .insertInto('work_links')
        .values({
          token_hash: hash(token),
          tenant_id: tenantId,
          user_id: userId,
          expires_at: new Date(now.getTime() + LINK_DAYS * 86_400_000),
        })
        .execute(),
    );
    return token;
  }

  /** リンクから本人を引く（ページはサインインしない。切れていれば null）。 */
  async byToken(token: string): Promise<{ tenantId: string; userId: string } | null> {
    const link = await withIdentity(this.db, (tx) =>
      tx
        .selectFrom('work_links')
        .select(['tenant_id', 'user_id'])
        .where('token_hash', '=', hash(token))
        .where('expires_at', '>', sql<Date>`now()`)
        .executeTakeFirst(),
    );
    return link ? { tenantId: link.tenant_id, userId: link.user_id } : null;
  }
}

/**
 * ホームのリンク。LIFF の ID があれば、計画ボードと同じ LIFF の入口を `/w/<リンク>` で開く
 * （LIFF を 2 つ登録しなくてよい。入口が仕事のホームへ移す）。無ければ公開の先頭の直のリンク。
 */
export function workUrlFor(config: {
  readonly publicUrl: string | null;
  readonly liffId: string | null;
}): (token: string) => string | null {
  const liffId = config.liffId?.trim() || null;
  if (liffId && LIFF_ID.test(liffId)) return (token) => `https://liff.line.me/${liffId}/w/${token}`;
  return (token) => (config.publicUrl ? `${config.publicUrl}/v1/channels/work/${token}` : null);
}

export interface HomeItem {
  readonly kind: 'session' | 'task';
  readonly id: string;
  readonly name: string;
  /** 「確認が必要」「作業中」「止まっているかも（推測）」… */
  readonly state: string;
  readonly tone: 'needs' | 'moving' | 'quiet' | 'done';
  readonly at: string;
}

export interface HomeView {
  readonly counts: {
    readonly running: number;
    readonly needsUser: number;
    readonly doneToday: number;
  };
  readonly attention: readonly string[];
  readonly items: readonly HomeItem[];
  readonly holds: readonly string[];
  readonly followups: readonly string[];
  readonly updatedAt: string;
}

const SESSION_STATE: Record<Attention, { state: string; tone: HomeItem['tone'] }> = {
  needs_user: { state: '確認が必要', tone: 'needs' },
  working: { state: '作業中', tone: 'moving' },
  stalled_suspected: { state: '止まっているかも（推測）', tone: 'quiet' },
  unknown: { state: '状態が分かりません', tone: 'quiet' },
  idle: { state: '応答を終えました', tone: 'done' },
  held: { state: '保留中', tone: 'quiet' },
  paused: { state: '見守りを止めています', tone: 'quiet' },
  ended: { state: '終わりました', tone: 'done' },
};

function sessionItem(s: AgentSession, now: number): HomeItem {
  const a = attentionFor(s, now);
  const base = SESSION_STATE[a];
  const check =
    a === 'idle' || a === 'ended'
      ? s.checkState === 'passed'
        ? '・テストが通っています'
        : s.checkState === 'failed'
          ? '・最後のテストが失敗'
          : s.checkState === 'changed'
            ? '・変更をまだテストしていません'
            : ''
      : '';
  return {
    kind: 'session',
    id: s.id,
    // 頼みの頭は出さない（公開の場所を通るページ）
    name: s.project ? `Claude Code（${s.project}）` : 'Claude Code',
    state: base.state + check,
    tone: s.checkState === 'failed' && (a === 'idle' || a === 'ended') ? 'needs' : base.tone,
    at: s.lastActivityAt.toISOString(),
  };
}

function taskItem(t: TaskListItem): HomeItem {
  const status = t.status as TaskStatus;
  return {
    kind: 'task',
    id: t.id,
    name: t.title ?? '名前のない仕事',
    state: STATUS_TEXT[status],
    tone:
      status === 'WAITING_APPROVAL' || status === 'FAILED'
        ? 'needs'
        : isTerminal(status)
          ? 'done'
          : 'moving',
    at: t.updated_at,
  };
}

const TONE_ORDER: Record<HomeItem['tone'], number> = { needs: 0, moving: 1, quiet: 2, done: 3 };

/** ホームの中身。確認が必要なもの → 動いているもの → 静かなもの → 終わったもの（それぞれ新しい順）。 */
export function composeHome(input: OverviewInput): HomeView {
  const overview = composeOverview(input);
  const items = [
    ...input.sessions.map((s) => sessionItem(s, input.now)),
    ...input.tasks.map(taskItem),
  ].sort((a, b) => TONE_ORDER[a.tone] - TONE_ORDER[b.tone] || b.at.localeCompare(a.at));
  return {
    counts: {
      running: overview.counts.running,
      needsUser: overview.attention.length,
      doneToday: overview.counts.doneToday,
    },
    attention: overview.attention,
    items: items.slice(0, 30),
    holds: input.holds.map(
      (h) =>
        `${h.subject}${h.untilDate ? `（${describeDate(h.untilDate)}まで）` : ''}${h.reason ? ` — ${h.reason}` : ''}`,
    ),
    followups: input.followups.map(
      (f) => `「${f.request}」${f.afterTitle ? `（「${f.afterTitle}」が終わったら）` : ''}`,
    ),
    updatedAt: new Date(input.now).toISOString(),
  };
}

/**
 * 「今の作業どうなってる？」の LINE のカード（channels の cards.ts が描く）。ホームと同じ並び:
 * 確認が必要なもの（3 件まで）→ 件数 → 仕事（5 件まで）→ ホームを開くボタン。
 */
export function workCardBody(home: HomeView, text: string, homeUrl: string | null) {
  return {
    schema: 'genie.work/v1',
    text: text.split('\n')[0] ?? '',
    counts: home.counts,
    attention: home.attention.slice(0, 3),
    items: home.items.slice(0, 5).map((i) => ({ name: i.name, state: i.state, tone: i.tone })),
    homeUrl,
  };
}

/** ページに出す台帳。Claude Code の頼みの頭は落とす。 */
export function ledgerForPage(l: Ledger): Ledger {
  return l.subject.kind === 'agent_session' ? { ...l, request: null } : l;
}

/** ホームのリンク（終わりの知らせに付ける）。公開の場所が無ければ作らずに null。 */
export async function homeLinkFor(deps: {
  readonly links: WorkLinkStore;
  readonly urlFor: (token: string) => string | null;
  readonly principal: { readonly tenantId: string; readonly userId: string };
  readonly now: Date;
}): Promise<string | null> {
  if (!deps.urlFor('x'.repeat(32))) return null;
  return deps.urlFor(
    await deps.links.issue(deps.principal.tenantId, deps.principal.userId, deps.now),
  );
}

/** 「仕事のホームを開いて」への答え。リンクを作れないときはそう言う。 */
export async function openHomeAnswer(deps: {
  readonly links: WorkLinkStore;
  readonly urlFor: (token: string) => string | null;
  readonly principal: { readonly tenantId: string; readonly userId: string };
  readonly now: Date;
}): Promise<string> {
  // 公開の場所が無ければ、リンクを作っても開けない（作らない）
  const url = await homeLinkFor(deps);
  if (!url)
    return '仕事のホームを LINE から開くための公開の場所が、まだ設定されていません。いまの状況は「今の作業どうなってる？」と聞いてください。';
  return [
    '仕事のホームです。確認が必要なものを先頭に出しています（30 日使えるあなた専用のリンクです。読むだけ）。',
    `[仕事のホームを開く](${url})`,
  ].join('\n');
}
