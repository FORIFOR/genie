/**
 * ほかの AI に頼んだ仕事の知らせ（Agent Orchestration の第 3 段、2026-10-29）。
 *
 *   返事が要る（承認・質問・失敗）状態が 1 分続いた … 「Claude Code が承認を待っています」
 *   作業中のまま 15 分届かない                    … 「止まっているかもしれません」（推した状態だと言い分ける）
 *
 * 知らせる先は Mac の通知（user_notices → NoticeInbox）と、つないでいれば本人のチャット（LINE）。
 * 同じ待ちは 1 回だけ。本人が止めたセッションは知らせない。
 *
 * **ここから Claude Code には何も送らない。**ターミナルに文字を打ち込むこともしない（本人の画面を操作しない）。
 * 承認だけは、本人が LINE のカードで答えたものを hooks（PermissionRequest）が取りに来て返す（agent-approvals.ts）。
 * そのカードを出しているあいだは、チャットへ「ターミナルで確かめて」を重ねて送らない。
 *
 * チャットへは頼みの頭を載せない（外のサービスを通るので、フォルダの名前と状態だけ）。Mac の通知には載せる。
 */
import { uuidv7 } from '@genie/contracts';
import { withIdentity, withTenant, type DbHandle } from '@genie/db';
import {
  attentionFor,
  type AgentSession,
  type AgentState,
  type UserPolicy,
} from './agent-sessions.js';

export interface AgentSessionWatchDeps {
  readonly db: DbHandle;
  /** 本人のチャットへ知らせる（つないでいなければ何もしない）。 */
  readonly notifyChat?: (tenantId: string, userId: string, text: string) => Promise<void>;
  /** その承認を LINE のカードで待っているか（待っていれば、チャットへは重ねて知らせない）。 */
  readonly approvalOnChat?: (tenantId: string, externalSessionId: string) => boolean;
  readonly now?: () => Date;
  readonly log?: (event: string, detail: Record<string, unknown>) => void;
}

export interface AgentSessionNotice {
  /** 同じ待ちを二度知らせないための印。 */
  readonly key: string;
  readonly title: string;
  /** Mac の通知の本文（頼みの頭を含む）。 */
  readonly body: string;
  /** チャットへの文（頼みの頭を含まない）。 */
  readonly chat: string;
}

/** いま知らせることがあるか。無ければ null（作業中・待機・止めた・終わった）。 */
export function noticeFor(s: AgentSession, now: number): AgentSessionNotice | null {
  const attention = attentionFor(s, now);
  const tool = s.source === 'claude_code' ? 'Claude Code' : s.source;
  // 「Claude Code が」/「Claude Code（genie）が」
  const subject = s.project ? `${tool}（${s.project}）が` : `${tool} が`;
  const name = s.title ?? s.project ?? '名前のないセッション';
  if (attention === 'needs_user') {
    const what =
      s.state === 'error'
        ? 'うまくいかずに止まりました'
        : s.waitingReason === 'permission'
          ? '承認を待っています'
          : 'あなたの返事を待っています';
    return {
      key: `needs_user:${s.state}:${s.waitingReason ?? ''}:${s.stateSince.toISOString()}`.slice(
        0,
        80,
      ),
      title: `${tool} が${what}`,
      body: `${name}${s.project && s.title ? `（${s.project}）` : ''}。ターミナルで確かめてください。`,
      chat: `🔔 ${subject}${what}。Mac のターミナルで確かめてください。`,
    };
  }
  if (attention === 'stalled_suspected') {
    return {
      key: `stalled:${s.lastActivityAt.toISOString()}`,
      title: `${tool} が止まっているかもしれません`,
      body: `${name}${s.project && s.title ? `（${s.project}）` : ''}。15 分以上動きがありません。`,
      chat: `🔔 ${subject} 15 分以上動いていません。止まっているかもしれません。`,
    };
  }
  return null;
}

export class AgentSessionWatch {
  #timer: NodeJS.Timeout | null = null;
  #running = false;

  constructor(private readonly deps: AgentSessionWatchDeps) {}

  #now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  start(intervalMs = 15_000): void {
    if (this.#timer) return;
    this.#timer = setInterval(() => void this.tick(), intervalMs);
    this.#timer.unref?.();
    void this.tick();
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
  }

  /** 見る時刻が来たセッションを見る。返すのは知らせた数。 */
  async tick(): Promise<number> {
    if (this.#running) return 0;
    this.#running = true;
    try {
      const now = this.#now();
      const due = await withIdentity(this.deps.db, (tx) =>
        tx
          .selectFrom('agent_sessions')
          .select(['id', 'tenant_id'])
          .where('check_after', '<=', now)
          .orderBy('check_after')
          .limit(20)
          .execute(),
      );
      let sent = 0;
      for (const row of due) {
        const done = await this.#check(row.tenant_id, row.id).catch((error: unknown) => {
          this.deps.log?.('agent_session_watch.check_failed', {
            id: row.id,
            error: (error as Error).message,
          });
          return false;
        });
        if (done) sent += 1;
      }
      return sent;
    } finally {
      this.#running = false;
    }
  }

  async #check(tenantId: string, id: string): Promise<boolean> {
    const now = this.#now();
    const found = await withTenant(this.deps.db, tenantId, async (tx) => {
      const row = await tx
        .selectFrom('agent_sessions')
        .selectAll()
        .where('id', '=', id)
        .forUpdate()
        .executeTakeFirst();
      // 見ている間に出来事が届いて、見る時刻が先へ延びていたら何もしない
      if (!row?.check_after || new Date(row.check_after).getTime() > now.getTime()) return null;
      const session: AgentSession = {
        id: row.id,
        source: row.source as AgentSession['source'],
        externalSessionId: row.external_session_id,
        project: row.project,
        title: row.title,
        state: row.state as AgentState,
        waitingReason: row.waiting_reason,
        userPolicy: row.user_policy as UserPolicy,
        lastEvent: row.last_event,
        lastActivityAt: new Date(row.last_activity_at),
        stateSince: new Date(row.state_since),
        heldBy: row.held_by,
        checkState: row.check_state as AgentSession['checkState'],
        endedAt: row.ended_at ? new Date(row.ended_at) : null,
        endReason: row.end_reason,
        createdAt: new Date(row.created_at),
      };
      const notice = noticeFor(session, now.getTime());
      const fresh = notice && notice.key !== row.notified_key ? notice : null;
      // 知らせたら、次の出来事が来るまで見ない（出来事が見る時刻を決め直す）
      await tx
        .updateTable('agent_sessions')
        .set({ check_after: null, ...(fresh ? { notified_key: fresh.key } : {}) })
        .where('id', '=', id)
        .execute();
      if (!fresh) return null;
      await tx
        .insertInto('user_notices')
        .values({
          id: uuidv7(),
          tenant_id: tenantId,
          user_id: row.user_id,
          kind: 'agent_session',
          title: fresh.title.slice(0, 200),
          body: fresh.body.slice(0, 2000),
        })
        .execute();
      return { userId: row.user_id, notice: fresh, session };
    });
    if (!found) return false;
    // 承認のカードを LINE に出してあれば、そのカードが知らせ（「ターミナルで確かめて」は送らない）
    if (
      found.session.waitingReason === 'permission' &&
      this.deps.approvalOnChat?.(tenantId, found.session.externalSessionId)
    )
      return true;
    this.deps.log?.('agent_session_watch.notified', { id, key: found.notice.key.split(':')[0] });
    await this.deps
      .notifyChat?.(tenantId, found.userId, found.notice.chat)
      .catch((error: unknown) =>
        this.deps.log?.('agent_session_watch.chat_failed', {
          id,
          error: (error as Error).message,
        }),
      );
    return true;
  }
}
