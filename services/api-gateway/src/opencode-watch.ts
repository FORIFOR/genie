/**
 * opencode のセッションの見守り。
 *
 * 本人が「このセッションを10分ごとに見て、止まっていたら続けさせて <URL>」と頼むと、決まった間隔で
 * opencode の API を見て、止まっていて終わっていなければ「続けて」を送る。画面は見ない（承認も画面読みのモデルも要らない）。
 *
 *   作業中（busy・retry）で進んでいる … 何もしない（進んでいる間は期限も延ばす。最長 7 日）
 *   作業中のまま 30 分進まない       … 本人に 1 回知らせる
 *   作業中のまま 60 分進まない       … 固まった実行を止めて（abort）、次の確認で「続けて」を送る。3 回で止めて知らせる
 *   承認・質問を待っている           … 促さない。本人に 1 回知らせて、見続ける
 *   最後の返答に【完了】がある・TODO が全部済み … 終わり。知らせて止める
 *   止まっていて、前に促してから進んだ … 「続けて」を送る
 *   促しても 3 回続けて進まない       … 止めて知らせる
 *   3 回続けてつながらない・期限（12 時間） … 止めて知らせる
 *
 * 見に行く先は、手元・社内・Tailscale のアドレスだけ（URL に書かれた先へ、外のどこへでも送らない）。
 * 残すのは、どこを見るか・最後の返答の印・回数だけ。セッションの本文は残さない。
 */
import { uuidv7 } from '@genie/contracts';
import { withIdentity, withTenant, type DbHandle } from '@genie/db';

export interface WatchTarget {
  readonly baseUrl: string;
  readonly sessionId: string;
}

const SESSION = /\/session\/(ses_[A-Za-z0-9]{1,64})(?:[/?#]|$)/;

/** 手元・社内・Tailscale のアドレスか（見守りで「続けて」を送ってよい先）。 */
export function isPrivateHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost' || host === '::1' || host.endsWith('.local') || host.endsWith('.ts.net'))
    return true;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!v4) return false;
  const [a, b] = [Number(v4[1]), Number(v4[2])];
  return (
    a === 127 ||
    a === 10 ||
    (a === 192 && b === 168) ||
    (a === 172 && b >= 16 && b <= 31) ||
    // Tailscale（CGNAT の範囲）
    (a === 100 && b >= 64 && b <= 127)
  );
}

/**
 * 文の中の opencode のセッションの URL。Web の画面の URL（/server/<base64 のサーバ>/session/ses_…）でも、
 * API の URL（http://host:4096/session/ses_…）でもよい。見つからない・外のアドレスなら null。
 */
export function parseOpencodeUrl(text: string): WatchTarget | null {
  for (const raw of text.match(/https?:\/\/[^\s<>「」"']+/g) ?? []) {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      continue;
    }
    const session = SESSION.exec(url.pathname)?.[1];
    if (!session) continue;
    let base = url.origin;
    // Web の画面は、つないでいるサーバを base64url で道に入れている
    const server = /\/server\/([A-Za-z0-9_-]+)\//.exec(url.pathname)?.[1];
    if (server) {
      try {
        const decoded = new URL(Buffer.from(server, 'base64url').toString('utf8'));
        if (decoded.protocol === 'http:' || decoded.protocol === 'https:') base = decoded.origin;
      } catch {
        /* 読めなければ画面と同じサーバとみなす */
      }
    }
    const host = new URL(base);
    if (!isPrivateHost(host.hostname) || host.username || host.password) return null;
    return { baseUrl: base, sessionId: session };
  }
  return null;
}

export const WATCH_START = /(見守|監視|見張|止まったら|続けさせ|続けるように|放置しないで)/;
export const WATCH_STOP = /(見守り|監視|見張り)\s*を?\s*(やめ|止め|とめ|終わ|終了|解除|ストップ)/;
/** 見守っているセッションの様子を聞いている（「opencode の実装は終わった？」「見守りはどう？」）。 */
export const WATCH_STATUS =
  /(?:opencode|オープンコード).*(?:終わ|おわ|完了|どう|状況|進み|進捗|止まって)|(?:見守り|監視).*(?:どう|状況|様子|進捗)/i;

/** 「15分ごと」などの間隔（秒）。無ければ 10 分。5 分〜2 時間に収める。 */
export function intervalFrom(text: string): number {
  const m = /(\d{1,3})\s*分\s*(?:ごと|おき|毎|に1回|に一回)/.exec(text);
  const h = /(\d{1,2})\s*時間\s*(?:ごと|おき|毎)/.exec(text);
  const seconds = m ? Number(m[1]) * 60 : h ? Number(h[1]) * 3600 : 600;
  return Math.min(7200, Math.max(300, seconds));
}

export interface SessionSnapshot {
  readonly busy: boolean;
  readonly waitingForUser: 'permission' | 'question' | null;
  /** 最後の返答の印（id と終わった時刻）。返答が無ければ null。 */
  readonly signature: string | null;
  /** 進み具合の印（最後の返答の id・部品の数・最後の部品の状態）。作業中に変わらなければ進んでいない。 */
  readonly activity?: string | null;
  readonly lastAssistantText: string;
  readonly todos: readonly { readonly content: string; readonly status: string }[];
}

type Fetch = typeof fetch;

/** opencode のサーバの API（opencode serve）。 */
export class OpencodeClient {
  constructor(
    private readonly baseUrl: string,
    private readonly fetchImpl: Fetch = fetch,
  ) {}

  async #get<T>(path: string): Promise<T> {
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`opencode_http_${String(res.status)}`);
    return (await res.json()) as T;
  }

  async snapshot(sessionId: string): Promise<SessionSnapshot> {
    const id = encodeURIComponent(sessionId);
    const [status, permissions, questions, messages, todos] = await Promise.all([
      this.#get<Record<string, { type?: string }>>('/session/status'),
      this.#get<{ sessionID?: string }[]>('/permission').catch(() => []),
      this.#get<{ sessionID?: string }[]>('/question').catch(() => []),
      this.#get<
        {
          info?: { id?: string; role?: string; time?: { completed?: number }; finish?: string };
          parts?: { type?: string; text?: string; state?: { status?: string } }[];
        }[]
      >(`/session/${id}/message?limit=10`),
      this.#get<{ content?: string; status?: string }[]>(`/session/${id}/todo`).catch(() => []),
    ]);
    const state = status[sessionId]?.type ?? 'idle';
    const last = [...messages].reverse().find((m) => m.info?.role === 'assistant');
    const lastAssistantText = (last?.parts ?? [])
      .filter((p) => p.type === 'text' && typeof p.text === 'string')
      .map((p) => p.text!)
      .join('\n');
    return {
      busy: state !== 'idle',
      waitingForUser: permissions.some((p) => p.sessionID === sessionId)
        ? 'permission'
        : questions.some((q) => q.sessionID === sessionId)
          ? 'question'
          : null,
      signature: last?.info?.id
        ? `${last.info.id}:${String(last.info.time?.completed ?? 'open')}`
        : null,
      activity: last?.info?.id
        ? `${last.info.id}:${String(last.parts?.length ?? 0)}:${String(last.parts?.at(-1)?.type)}:${String(last.parts?.at(-1)?.state?.status)}`
        : null,
      lastAssistantText,
      todos: todos.map((t) => ({
        content: String(t.content ?? ''),
        status: String(t.status ?? ''),
      })),
    };
  }

  /** 固まった実行を止める。 */
  async abort(sessionId: string): Promise<void> {
    const res = await this.fetchImpl(
      `${this.baseUrl}/session/${encodeURIComponent(sessionId)}/abort`,
      { method: 'POST', signal: AbortSignal.timeout(15_000) },
    );
    if (!res.ok) throw new Error(`opencode_http_${String(res.status)}`);
  }

  async nudge(sessionId: string, text: string): Promise<void> {
    const res = await this.fetchImpl(
      `${this.baseUrl}/session/${encodeURIComponent(sessionId)}/prompt_async`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ parts: [{ type: 'text', text }] }),
        signal: AbortSignal.timeout(15_000),
      },
    );
    if (!res.ok) throw new Error(`opencode_http_${String(res.status)}`);
  }
}

export const DONE_MARK = '【完了】';

export function nudgeText(count: number): string {
  return [
    '続けてください。まだ終わっていない作業を、テストや動作確認で確かめながら最後まで進めてください。',
    `すべて終わって確かめられたら、最後に「${DONE_MARK}」とだけ書いた行を入れてください。`,
    `（Genie の見守りから・${String(count)} 回目）`,
  ].join('\n');
}

/** 促しても進まなかった回数がこれに達したら止める。 */
export const MAX_IDLE_NUDGES = 3;
/** つながらなかった回数がこれに達したら止める。 */
export const MAX_FAILURES = 3;

export type WatchDecision =
  | { readonly kind: 'working' }
  | { readonly kind: 'waiting_user'; readonly what: 'permission' | 'question' }
  | { readonly kind: 'done' }
  | { readonly kind: 'stalled' }
  | { readonly kind: 'nudge'; readonly idleNudges: number };

/** 見たものから、次にすること。純粋関数。 */
export function decide(
  snapshot: SessionSnapshot,
  state: { readonly lastSignature: string | null; readonly idleNudges: number },
): WatchDecision {
  if (snapshot.busy) return { kind: 'working' };
  if (snapshot.waitingForUser) return { kind: 'waiting_user', what: snapshot.waitingForUser };
  const lines = snapshot.lastAssistantText.split('\n').map((l) => l.trim());
  const marked = lines.some((l) => l === DONE_MARK || l.startsWith(DONE_MARK));
  const todosDone =
    snapshot.todos.length > 0 &&
    snapshot.todos.every((t) => t.status === 'completed' || t.status === 'cancelled');
  if (marked || (todosDone && state.lastSignature !== null)) return { kind: 'done' };
  // 前に促したときと同じ返答のまま = 促しても進んでいない
  const progressed = snapshot.signature !== state.lastSignature;
  const idleNudges = progressed ? 0 : state.idleNudges + 1;
  if (idleNudges >= MAX_IDLE_NUDGES) return { kind: 'stalled' };
  return { kind: 'nudge', idleNudges };
}

export interface OpencodeWatchDeps {
  readonly db: DbHandle;
  /** 本人へ知らせる（その会話のチャット。無ければ本人の LINE）。 */
  readonly notify: (
    tenantId: string,
    userId: string,
    conversationId: string,
    text: string,
  ) => Promise<void>;
  readonly fetchImpl?: Fetch;
  readonly now?: () => Date;
  readonly log?: (event: string, detail: Record<string, unknown>) => void;
}

/** 見守りの期限。 */
const WATCH_HOURS = 12;
/** 進んでいる間は期限を延ばすが、これを超えない。 */
const WATCH_MAX_DAYS = 7;
const STUCK_NOTIFY_MS = 30 * 60_000;
const STUCK_ABORT_MS = 60 * 60_000;
const MAX_STUCK_ABORTS = 3;
/** 促したことを知らせる間隔（毎回は知らせない。最初と、その後は 6 回ごと）。 */
const NOTIFY_EVERY = 6;

export class OpencodeWatchService {
  #timer: NodeJS.Timeout | null = null;
  #running = false;

  constructor(private readonly deps: OpencodeWatchDeps) {}

  #now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  /** 決まった言い方なら見守りを始める・やめる。それ以外は null（いつもどおり）。 */
  async command(
    principal: { tenantId: string; userId: string },
    conversationId: string,
    text: string,
  ): Promise<string | null> {
    if (WATCH_STOP.test(text)) {
      const stopped = await withTenant(this.deps.db, principal.tenantId, (tx) =>
        tx
          .updateTable('opencode_watches')
          .set({ status: 'stopped', ended_reason: 'user', updated_at: this.#now() })
          .where('user_id', '=', principal.userId)
          .where('status', '=', 'active')
          .executeTakeFirst(),
      );
      return Number(stopped.numUpdatedRows) > 0
        ? '承知しました。opencode の見守りをやめました。'
        : 'いま見守っている opencode のセッションはありません。';
    }
    const mentions = /opencode|オープンコード|\/session\/ses_/i.test(text);
    if (mentions && WATCH_STATUS.test(text) && !WATCH_START.test(text))
      return this.#report(principal);
    if (!WATCH_START.test(text) || !mentions) return null;
    let target = parseOpencodeUrl(text);
    if (!target) {
      if (/https?:\/\//.test(text))
        return '見守れるのは、手元・社内・Tailscale のアドレスの opencode のセッションだけです（URL に /session/ses_… が要ります）。';
      // URL が無い（「もう一度 opencode を見守って」）: 前に見守ったセッションで始め直す
      target = await this.#latestTarget(principal);
      if (!target)
        return 'どの opencode のセッションを見守るか分かりません。セッションの URL（…/session/ses_…）を添えて、もう一度送ってください。';
    }
    const interval = intervalFrom(text);
    const now = this.#now();
    await withTenant(this.deps.db, principal.tenantId, async (tx) => {
      // 同じセッションの見守りは 1 つ（前のものは止めて、新しい間隔で始め直す）
      await tx
        .updateTable('opencode_watches')
        .set({ status: 'stopped', ended_reason: 'replaced', updated_at: now })
        .where('user_id', '=', principal.userId)
        .where('base_url', '=', target.baseUrl)
        .where('session_id', '=', target.sessionId)
        .where('status', '=', 'active')
        .execute();
      await tx
        .insertInto('opencode_watches')
        .values({
          id: uuidv7(),
          tenant_id: principal.tenantId,
          user_id: principal.userId,
          conversation_id: conversationId,
          base_url: target.baseUrl,
          session_id: target.sessionId,
          interval_seconds: interval,
          // 頼まれたらすぐ 1 回見る（止まっていればすぐ促す）
          next_check_at: now,
          expires_at: new Date(now.getTime() + WATCH_HOURS * 3600_000),
        })
        .execute();
    });
    this.deps.log?.('opencode_watch.started', { session: target.sessionId, interval });
    return [
      `承知しました。${String(Math.round(interval / 60))} 分ごとに opencode のセッション（${target.sessionId}）を見て、止まっていたら「続けてください」と送ります。`,
      `終わったら（返答に${DONE_MARK}）・承認や質問を待っていたら・進まなくなったら知らせます。${String(WATCH_HOURS)} 時間で終えます。やめるときは「見守りをやめて」。`,
    ].join('\n');
  }

  /** 本人が最後に見守ったセッション（状態は問わない）。 */
  async #latestTarget(principal: {
    tenantId: string;
    userId: string;
  }): Promise<WatchTarget | null> {
    const row = await withTenant(this.deps.db, principal.tenantId, (tx) =>
      tx
        .selectFrom('opencode_watches')
        .select(['base_url', 'session_id'])
        .where('user_id', '=', principal.userId)
        .orderBy('created_at', 'desc')
        .limit(1)
        .executeTakeFirst(),
    );
    return row ? { baseUrl: row.base_url, sessionId: row.session_id } : null;
  }

  /** 最後に見守ったセッションの様子（見守りの状態と、いまのセッション）。 */
  async #report(principal: { tenantId: string; userId: string }): Promise<string> {
    const watch = await withTenant(this.deps.db, principal.tenantId, (tx) =>
      tx
        .selectFrom('opencode_watches')
        .selectAll()
        .where('user_id', '=', principal.userId)
        .orderBy('created_at', 'desc')
        .limit(1)
        .executeTakeFirst(),
    );
    if (!watch)
      return 'まだ opencode のセッションを見守っていません。セッションの URL を添えて「見守って」と送ってください。';
    const state =
      {
        active: '見守っています',
        done: '終わったので見守りを終えました',
        stalled: '促しても進まなかったので止めました',
        unreachable: 'つながらなかったので止めました',
        expired: `${String(WATCH_HOURS)} 時間たったので終えました`,
        stopped: 'やめました',
      }[watch.status as 'active'] ?? watch.status;
    const lines = [
      `opencode のセッション（${watch.session_id}）の見守りは、${state}（「続けて」を送った回数: ${String(watch.nudges)}）。`,
    ];
    try {
      const now = await new OpencodeClient(watch.base_url, this.deps.fetchImpl).snapshot(
        watch.session_id,
      );
      const left = now.todos.filter((t) => t.status !== 'completed' && t.status !== 'cancelled');
      const finished = decide(now, { lastSignature: 'x', idleNudges: 0 }).kind === 'done';
      lines.push(
        `いまのセッション: ${now.busy ? '作業中です' : now.waitingForUser ? `${now.waitingForUser === 'permission' ? '承認' : '質問への答え'}を待っています` : finished ? '終わったと書いています' : '止まっています'}。${now.todos.length ? `TODO は残り ${String(left.length)} / ${String(now.todos.length)}。` : ''}`,
      );
      const last = now.lastAssistantText.replace(/\s+/g, ' ').trim();
      if (last) lines.push(`最後の返答: ${last.slice(0, 200)}${last.length > 200 ? '…' : ''}`);
    } catch {
      lines.push('いまのセッションには、つながりませんでした。');
    }
    if (watch.status !== 'active')
      lines.push('続けて見守るなら「もう一度 opencode を見守って」と送ってください。');
    return lines.join('\n');
  }

  start(intervalMs = 30_000): void {
    if (this.#timer) return;
    this.#timer = setInterval(() => void this.tick(), intervalMs);
    this.#timer.unref?.();
    void this.tick();
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
  }

  /** 時間が来た見守りを 1 回ずつ見る。返すのは見た数。 */
  async tick(): Promise<number> {
    if (this.#running) return 0;
    this.#running = true;
    try {
      const now = this.#now();
      const due = await withIdentity(this.deps.db, (tx) =>
        tx
          .selectFrom('opencode_watches')
          .select(['id', 'tenant_id'])
          .where('status', '=', 'active')
          .where('next_check_at', '<=', now)
          .orderBy('next_check_at')
          .limit(10)
          .execute(),
      );
      for (const row of due) {
        await this.#check(row.tenant_id, row.id).catch((error: unknown) =>
          this.deps.log?.('opencode_watch.check_failed', {
            id: row.id,
            error: (error as Error).message,
          }),
        );
      }
      return due.length;
    } finally {
      this.#running = false;
    }
  }

  async #check(tenantId: string, id: string): Promise<void> {
    const now = this.#now();
    const watch = await withTenant(this.deps.db, tenantId, (tx) =>
      tx
        .selectFrom('opencode_watches')
        .selectAll()
        .where('id', '=', id)
        .where('status', '=', 'active')
        .executeTakeFirst(),
    );
    if (!watch) return;
    const next = new Date(now.getTime() + watch.interval_seconds * 1000);
    const save = (patch: Record<string, unknown>) =>
      withTenant(this.deps.db, tenantId, (tx) =>
        tx
          .updateTable('opencode_watches')
          .set({ ...patch, updated_at: now })
          .where('id', '=', id)
          .execute(),
      );
    const tell = (text: string) =>
      this.deps
        .notify(tenantId, watch.user_id, watch.conversation_id, text)
        .catch((error: unknown) =>
          this.deps.log?.('opencode_watch.notify_failed', { id, error: (error as Error).message }),
        );
    const label = `opencode（${watch.session_id}）`;

    if (watch.expires_at.getTime() <= now.getTime()) {
      await save({ status: 'expired', ended_reason: 'expired' });
      await tell(
        `⏹ ${String(WATCH_HOURS)} 時間たったので、${label}の見守りを終えました（「続けて」を送った回数: ${String(watch.nudges)}）。まだ続けるなら「もう一度 opencode を見守って」と送ってください。`,
      );
      return;
    }

    const client = new OpencodeClient(watch.base_url, this.deps.fetchImpl);
    let snapshot: SessionSnapshot;
    try {
      snapshot = await client.snapshot(watch.session_id);
    } catch (error) {
      const failures = watch.failures + 1;
      this.deps.log?.('opencode_watch.unreachable', {
        id,
        failures,
        error: (error as Error).message,
      });
      if (failures >= MAX_FAILURES) {
        await save({ status: 'unreachable', ended_reason: (error as Error).message, failures });
        await tell(
          `⚠️ ${label}に ${String(failures)} 回続けてつながりませんでした。見守りを止めました。サーバが動いているか確かめてください。`,
        );
      } else await save({ failures, next_check_at: next });
      return;
    }

    const decision = decide(snapshot, {
      lastSignature: watch.last_signature,
      idleNudges: watch.idle_nudges,
    });
    this.deps.log?.('opencode_watch.checked', { id, decision: decision.kind });
    switch (decision.kind) {
      case 'working': {
        const activity = snapshot.activity ?? null;
        const base = { failures: 0, waiting_notified: false, next_check_at: next };
        if (activity !== watch.last_activity || !watch.last_activity_at) {
          // 進んでいる。見張りを途中で切らないよう期限を延ばす
          const limit = watch.created_at.getTime() + WATCH_MAX_DAYS * 24 * 3600_000;
          const extended = Math.min(now.getTime() + WATCH_HOURS * 3600_000, limit);
          await save({
            ...base,
            last_activity: activity,
            last_activity_at: now,
            stuck_notified: false,
            expires_at: new Date(Math.max(extended, watch.expires_at.getTime())),
          });
          return;
        }
        const quiet = now.getTime() - watch.last_activity_at.getTime();
        if (quiet >= STUCK_ABORT_MS) {
          if (watch.stuck_aborts >= MAX_STUCK_ABORTS) {
            await save({ status: 'stalled', ended_reason: 'stuck', failures: 0 });
            await tell(
              `⚠️ ${label}は止めて促しても、${String(MAX_STUCK_ABORTS)} 回固まりました。見守りを止めました。画面で様子を確かめてください。`,
            );
            return;
          }
          try {
            await client.abort(watch.session_id);
          } catch (error) {
            await save({ failures: watch.failures + 1, next_check_at: next });
            this.deps.log?.('opencode_watch.abort_failed', {
              id,
              error: (error as Error).message,
            });
            return;
          }
          // すぐ次の確認で「続けて」を送る
          await save({
            failures: 0,
            stuck_aborts: watch.stuck_aborts + 1,
            stuck_notified: false,
            last_activity: null,
            last_activity_at: null,
            next_check_at: now,
          });
          await tell(
            `🔁 ${label}が ${String(Math.round(quiet / 60_000))} 分進まなかったので、固まった実行を止めました。このあと「続けてください」と送ります。`,
          );
          return;
        }
        await save({ ...base, stuck_notified: quiet >= STUCK_NOTIFY_MS || watch.stuck_notified });
        if (quiet >= STUCK_NOTIFY_MS && !watch.stuck_notified)
          await tell(
            `⚠️ ${label}は「作業中」のまま ${String(Math.round(quiet / 60_000))} 分進んでいません。60 分進まなければ、固まった実行を止めて続けさせます。`,
          );
        return;
      }
      case 'waiting_user':
        await save({ failures: 0, waiting_notified: true, next_check_at: next });
        if (!watch.waiting_notified)
          await tell(
            `⏸ ${label}が${decision.what === 'permission' ? '承認' : '質問への答え'}を待っています。答えるまで「続けて」は送りません（見守りは続けます）。`,
          );
        return;
      case 'done': {
        await save({ status: 'done', ended_reason: 'done', failures: 0 });
        const last = snapshot.lastAssistantText.replace(/\s+/g, ' ').trim();
        await tell(
          `✅ ${label}が終わったようです。見守りを終えました（「続けて」を送った回数: ${String(watch.nudges)}）。${last ? `\n最後の返答: ${last.slice(0, 200)}${last.length > 200 ? '…' : ''}` : ''}`,
        );
        return;
      }
      case 'stalled':
        await save({ status: 'stalled', ended_reason: 'no_progress', failures: 0 });
        await tell(
          `⚠️ ${label}に「続けて」を送っても、${String(MAX_IDLE_NUDGES)} 回続けて進みませんでした。見守りを止めました。画面で様子を確かめてください。`,
        );
        return;
      case 'nudge': {
        const count = watch.nudges + 1;
        try {
          await client.nudge(watch.session_id, nudgeText(count));
        } catch (error) {
          await save({ failures: watch.failures + 1, next_check_at: next });
          this.deps.log?.('opencode_watch.nudge_failed', { id, error: (error as Error).message });
          return;
        }
        await save({
          nudges: count,
          idle_nudges: decision.idleNudges,
          last_signature: snapshot.signature,
          failures: 0,
          waiting_notified: false,
          next_check_at: next,
        });
        if (count === 1 || count % NOTIFY_EVERY === 0)
          await tell(
            `🔁 ${label}が止まっていたので「続けてください」と送りました（${String(count)} 回目）。${count === 1 ? `この後は ${String(NOTIFY_EVERY)} 回ごとに知らせます。` : ''}`,
          );
        return;
      }
    }
  }
}
