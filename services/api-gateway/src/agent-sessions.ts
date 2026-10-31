/**
 * ほかの AI に頼んだ仕事の見守り（Agent Orchestration の第 1 段。本人の方針 2026-10-28）。まず Claude Code。
 *
 *   Claude Code の hooks → POST /v1/agent-events/claude-code（鍵で名乗る）→ セッションごとに 1 行へ畳む
 *   → Task Dock が一覧で見る（GET /v1/agent-sessions）
 *
 * 出来事 → 状態:
 *   SessionStart                         … idle（頼みを待っている）
 *   UserPromptSubmit・道具の出来事        … working
 *   PermissionRequest・承認の Notification … waiting_user（permission）
 *   入力待ちの Notification                … waiting_user（input）
 *   Stop                                 … idle。**「仕事が終わった」ではない。**応答が終わっただけ
 *   StopFailure                          … error
 *   SessionEnd                           … ended
 *
 * hooks は裏で走るので、Stop の直後に道具の出来事が遅れて届くことがある。Stop から TURN_SETTLE_MS 以内の
 * 道具の出来事では working に戻さない（時刻だけ進める）。
 *
 * 残すのは、どのセッションか・フォルダの名前・頼みの頭（短く）・状態・時刻だけ。
 * 道具の入出力・応答の本文・会話の記録の場所は残さない。
 *
 * 知らせ（第 3 段）: 出来事が届くたびに、見回り（agent-session-watch.ts）が次に見る時刻 check_after を決め直す。
 *   返事が要る（waiting_user・error）… その状態になってから NEEDS_USER_NOTIFY_MS 後
 *   作業中                          … 最後の出来事から STALL_AFTER_MS 後（「止まっているかも」）
 *   待機・終わり・本人が止めた・保留  … 見ない（null）
 *
 * 確かめ（check_state）: 応答を終えただけでは「完了」と言わない。ファイルを変えたか、そのあとテストが通ったかを覚える。
 *   Edit・Write などが通った               … changed（変えたが、まだ確かめていない）
 *   テストらしいコマンドが通った / 失敗した … passed / failed
 * コマンドの文は種類を見るためだけに読み、残さない。
 *
 * 保留（work-holds.ts）: 本人が保留にした名前のフォルダ・頼みのセッションは held_by を持ち、知らせない。
 *
 * 台帳（work-ledger.ts）: 依頼・追加の指示・承認待ち・変更・テスト・応答の終わりを agent_session_marks に
 * 種類と時刻だけ残す（marksFor）。文は残さない。
 */
import { createHash, randomBytes } from 'node:crypto';
import { sql } from 'kysely';
import { uuidv7 } from '@genie/contracts';
import { withIdentity, withTenant, type DbHandle, type ScopedDb } from '@genie/db';

export type AgentSource = 'claude_code' | 'codex' | 'opencode';
export type AgentState = 'working' | 'waiting_user' | 'idle' | 'error' | 'ended';
export type UserPolicy = 'watch' | 'paused_by_user';
/** Dock に何として出すか（読むときに決める。残さない）。 */
export type Attention =
  'needs_user' | 'stalled_suspected' | 'working' | 'idle' | 'paused' | 'held' | 'unknown' | 'ended';
export type CheckState = 'none' | 'changed' | 'passed' | 'failed';

/** 作業中にこれだけ静かなら「止まっているかも」。仮の値（仕事の種類ごとに見直す）。 */
export const STALL_AFTER_MS = 15 * 60_000;
export const TURN_SETTLE_MS = 3_000;
/** 返事が要る状態がこれだけ続いたら知らせる（ターミナルの前ですぐ答えた承認は知らせない）。 */
export const NEEDS_USER_NOTIFY_MS = 60_000;
/**
 * 作業中のまま、これだけ何も届かなければ「いまの状態は分からない」（ターミナルを閉じた・Mac が眠った）。
 * 推して「止まった」「終わった」とは言わない。
 */
export const UNKNOWN_AFTER_MS = 2 * 3600_000;

const TOKEN_PREFIX = 'gac_';
const TOKEN = /^gac_[A-Za-z0-9_-]{43}$/;
const hash = (token: string) => createHash('sha256').update(token).digest('hex');

export interface AgentSession {
  readonly id: string;
  readonly source: AgentSource;
  readonly externalSessionId: string;
  readonly project: string | null;
  readonly title: string | null;
  readonly state: AgentState;
  readonly waitingReason: string | null;
  readonly userPolicy: UserPolicy;
  readonly lastEvent: string;
  readonly lastActivityAt: Date;
  /** いまの state（と待ちの理由）になった時刻。 */
  readonly stateSince: Date;
  /** 保留（work_holds）で静かにしているとき、その保留。 */
  readonly heldBy: string | null;
  readonly checkState: CheckState;
  readonly endedAt: Date | null;
  readonly endReason: string | null;
  readonly createdAt: Date;
}

export interface AgentConnection {
  readonly id: string;
  readonly tenantId: string;
  readonly userId: string;
  readonly source: AgentSource;
}

/** hooks の出来事。残す項目だけに絞ったもの。 */
export interface HookEvent {
  readonly event: string;
  readonly sessionId: string;
  readonly cwd?: string;
  readonly prompt?: string;
  readonly notificationType?: string;
  readonly message?: string;
  readonly reason?: string;
  readonly error?: string;
  /** 道具の名前（Edit・Bash など）。確かめの判定にだけ使う。 */
  readonly toolName?: string;
  /** Bash のコマンド。テストかどうかを見るだけで、残さない。 */
  readonly command?: string;
}

/** フォルダの名前だけ（フルパスは残さない）。 */
export function projectName(cwd: string | undefined): string | null {
  if (!cwd) return null;
  const name =
    cwd
      .replace(/[\\/]+$/, '')
      .split(/[\\/]/)
      .pop() ?? '';
  return name ? name.slice(0, 120) : null;
}

/**
 * 頼みの頭を名前にする。空でない最初の 1 行・80 字まで・鍵らしい文字列は伏せる。頼みの全文は残さない。
 */
export function titleFrom(prompt: string | undefined): string | null {
  const line = prompt
    ?.split('\n')
    .map((l) => l.trim())
    // Claude Code が頼みとして渡す機械の知らせ（<task-notification> など）は名前にしない（2026-10-29 の実物）
    .find((l) => l.length > 0 && !/^<.*>$/.test(l));
  if (!line) return null;
  const hidden = line
    // 長いトークン・API キー・JWT・ハッシュ
    .replace(/[A-Za-z0-9_\-.+/=]{32,}/g, '…')
    .replace(/\b(?:sk|pk|ghp|gho|xox[abp]|AKIA)[A-Za-z0-9_-]{8,}/g, '…');
  return hidden.length > 80 ? `${hidden.slice(0, 79)}…` : hidden;
}

const short = (text: string | undefined, max: number) =>
  text ? text.replace(/\s+/g, ' ').trim().slice(0, max) || null : null;

interface Transition {
  readonly state?: AgentState;
  readonly waitingReason?: string | null;
  /** 道具の出来事。動いた印だが、直前の Stop を取り消さない。 */
  readonly activityOnly?: boolean;
  readonly turnEnded?: boolean;
  readonly ended?: { readonly reason: string | null };
}

/** 出来事 1 つでセッションがどう変わるか（null は状態を変えない。時刻は進める）。 */
export function transitionFor(e: HookEvent): Transition | null {
  switch (e.event) {
    case 'SessionStart':
      return { state: 'idle', waitingReason: null };
    case 'UserPromptSubmit':
      return { state: 'working', waitingReason: null };
    case 'PreToolUse':
    case 'PostToolUse':
    case 'PostToolUseFailure':
    case 'PostToolBatch':
    case 'SubagentStart':
    case 'SubagentStop':
    case 'PreCompact':
    case 'PostCompact':
      return { state: 'working', waitingReason: null, activityOnly: true };
    case 'PermissionRequest':
      return { state: 'waiting_user', waitingReason: 'permission' };
    case 'PermissionDenied':
      return { state: 'working', waitingReason: null, activityOnly: true };
    case 'Elicitation':
      return { state: 'waiting_user', waitingReason: 'input' };
    case 'Notification': {
      const text = `${e.notificationType ?? ''} ${e.message ?? ''}`;
      if (/permission/i.test(text)) return { state: 'waiting_user', waitingReason: 'permission' };
      if (/elicitation/i.test(text)) return { state: 'waiting_user', waitingReason: 'input' };
      // idle_prompt（「Claude is waiting for your input」）は、応答を終えたあと時間がたったという知らせで、
      // 本人の返事が要る待ちではない（Stop と同じ idle のまま）。2026-10-29 の実物: Stop の 111 秒後に届き、
      // 返事待ちとして LINE へ知らせてしまった
      return null;
    }
    case 'Stop':
      return { state: 'idle', waitingReason: null, turnEnded: true };
    case 'StopFailure':
      return { state: 'error', waitingReason: short(e.error ?? e.reason, 60) ?? 'stop_failure' };
    case 'SessionEnd':
      return { state: 'ended', waitingReason: null, ended: { reason: short(e.reason, 40) } };
    default:
      return null;
  }
}

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
/** テストを走らせるコマンド（ほかのコマンドの成否は確かめに数えない）。 */
const TEST_COMMAND =
  /(?:^|[\s;&|(])(?:vitest|jest|pytest|swift\s+test|go\s+test|cargo\s+test|dotnet\s+test|xcodebuild\b[^\n]*\btest|node\s+--test|rspec|(?:npm|pnpm|yarn|bun)\b[^\n;&|]*\btest\b|make\s+(?:test|check)|[\w./-]*verify[\w-]*\.sh)/;

export function isTestCommand(command: string | undefined): boolean {
  return !!command && TEST_COMMAND.test(command);
}

/** 出来事 1 つで確かめの状態がどう変わるか（null は変えない）。 */
export function checkFor(e: HookEvent, current: CheckState): CheckState | null {
  if (e.event === 'UserPromptSubmit') return current === 'none' ? null : current;
  if (e.event !== 'PostToolUse' && e.event !== 'PostToolUseFailure') return null;
  if (e.event === 'PostToolUse' && e.toolName && EDIT_TOOLS.has(e.toolName)) return 'changed';
  if (e.toolName === 'Bash' && isTestCommand(e.command))
    return e.event === 'PostToolUse' ? 'passed' : 'failed';
  return null;
}

export type MarkKind =
  | 'request'
  | 'instruction'
  | 'waiting_permission'
  | 'waiting_input'
  | 'changed'
  | 'test_passed'
  | 'test_failed'
  | 'turn_ended'
  | 'error'
  | 'ended';

/**
 * 出来事 1 つで台帳に残す印。前と同じ状態が重ねて届いたときは残さない（承認待ちの Notification が 2 回来るなど）。
 *   prev … 出来事の前のセッション（新しいセッションなら null）
 *   next … 出来事のあとの状態（状態を変えない出来事なら prev と同じ）
 */
export function marksFor(
  e: HookEvent,
  prev: {
    state: AgentState;
    waitingReason: string | null;
    checkState: CheckState;
    title: string | null;
  } | null,
  next: { state: AgentState; waitingReason: string | null },
  check: CheckState | null,
): MarkKind[] {
  const marks: MarkKind[] = [];
  // 機械の知らせ（<task-notification> など）だけの頼みは本人の指示ではない
  if (e.event === 'UserPromptSubmit' && titleFrom(e.prompt) !== null)
    marks.push(prev?.title ? 'instruction' : 'request');
  const moved = !prev || prev.state !== next.state || prev.waitingReason !== next.waitingReason;
  if (moved && next.state === 'waiting_user')
    marks.push(next.waitingReason === 'permission' ? 'waiting_permission' : 'waiting_input');
  if (moved && next.state === 'error') marks.push('error');
  if (moved && next.state === 'ended') marks.push('ended');
  if (e.event === 'Stop' && prev && prev.state !== 'idle' && next.state === 'idle')
    marks.push('turn_ended');
  if (e.event === 'PostToolUse' || e.event === 'PostToolUseFailure') {
    if (check === 'changed' && (prev?.checkState ?? 'none') !== 'changed') marks.push('changed');
    if (e.toolName === 'Bash' && isTestCommand(e.command))
      marks.push(e.event === 'PostToolUse' ? 'test_passed' : 'test_failed');
  }
  return marks;
}

async function addMarks(
  tx: ScopedDb,
  tenantId: string,
  sessionId: string,
  marks: readonly MarkKind[],
  at: Date,
): Promise<void> {
  if (marks.length === 0) return;
  await tx
    .insertInto('agent_session_marks')
    .values(
      marks.map((kind) => ({ id: uuidv7(), tenant_id: tenantId, session_id: sessionId, kind, at })),
    )
    .execute();
}

/** 見回りが次にこのセッションを見る時刻（null は見なくてよい）。 */
export function checkAfterFor(s: {
  state: AgentState;
  userPolicy: UserPolicy;
  stateSince: Date;
  lastActivityAt: Date;
}): Date | null {
  if (s.userPolicy === 'paused_by_user') return null;
  if (s.state === 'waiting_user' || s.state === 'error')
    return new Date(s.stateSince.getTime() + NEEDS_USER_NOTIFY_MS);
  // attentionFor は「STALL_AFTER_MS を超えたら」なので 1ms 後に見る
  if (s.state === 'working') return new Date(s.lastActivityAt.getTime() + STALL_AFTER_MS + 1);
  return null;
}

/** いまのセッションを何として出すか。本人が止めた・保留にしたものは「止まっているかも」と言わない。 */
export function attentionFor(s: AgentSession, now: number): Attention {
  if (s.state === 'ended') return 'ended';
  if (s.heldBy) return 'held';
  if (s.userPolicy === 'paused_by_user') return 'paused';
  if (s.state === 'waiting_user' || s.state === 'error') return 'needs_user';
  if (s.state === 'working') {
    const quiet = now - s.lastActivityAt.getTime();
    if (quiet > UNKNOWN_AFTER_MS) return 'unknown';
    return quiet > STALL_AFTER_MS ? 'stalled_suspected' : 'working';
  }
  return 'idle';
}

type Row = {
  id: string;
  source: string;
  external_session_id: string;
  project: string | null;
  title: string | null;
  state: string;
  waiting_reason: string | null;
  user_policy: string;
  last_event: string;
  last_activity_at: Date | string;
  state_since: Date | string;
  held_by: string | null;
  check_state: string;
  ended_at: Date | string | null;
  end_reason: string | null;
  created_at: Date | string;
};

function rowToSession(row: Row): AgentSession {
  return {
    id: row.id,
    source: row.source as AgentSource,
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
    checkState: row.check_state as CheckState,
    endedAt: row.ended_at ? new Date(row.ended_at) : null,
    endReason: row.end_reason,
    createdAt: new Date(row.created_at),
  };
}

const COLUMNS = [
  'id',
  'source',
  'external_session_id',
  'project',
  'title',
  'state',
  'waiting_reason',
  'user_policy',
  'last_event',
  'last_activity_at',
  'state_since',
  'held_by',
  'check_state',
  'ended_at',
  'end_reason',
  'created_at',
] as const;

/** 本人の保留のうち、フォルダ名か頼みの頭に名前を含むもの（work-holds.ts の matchesHold と同じ照らし方）。 */
async function holdMatching(
  tx: ScopedDb,
  userId: string,
  project: string | null,
  title: string | null,
): Promise<string | null> {
  if (!project && !title) return null;
  const row = await tx
    .selectFrom('work_holds')
    .select('id')
    .where('user_id', '=', userId)
    .where('status', '=', 'active')
    .where((eb) =>
      eb.or([
        ...(project ? [eb(sql`strpos(lower(${project}), lower(subject))`, '>', 0)] : []),
        ...(title ? [eb(sql`strpos(lower(${title}), lower(subject))`, '>', 0)] : []),
      ]),
    )
    .orderBy('created_at', 'desc')
    .limit(1)
    .executeTakeFirst();
  return row?.id ?? null;
}

export class AgentSessionStore {
  constructor(
    private readonly db: DbHandle,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** hooks の鍵を発行する。平文はここで 1 回返すだけで、残すのはハッシュ。 */
  async connect(input: {
    tenantId: string;
    userId: string;
    source: AgentSource;
    label: string;
  }): Promise<{ id: string; token: string }> {
    const id = uuidv7();
    const token = TOKEN_PREFIX + randomBytes(32).toString('base64url');
    await withTenant(this.db, input.tenantId, (tx) =>
      tx
        .insertInto('agent_connections')
        .values({
          id,
          tenant_id: input.tenantId,
          user_id: input.userId,
          source: input.source,
          label: input.label,
          token_hash: hash(token),
        })
        .execute(),
    );
    return { id, token };
  }

  /** その種類の接続（発見で届くものには hooks の鍵が要らない。無ければ作る）。 */
  async ownConnection(
    tenantId: string,
    userId: string,
    source: AgentSource,
    label: string,
  ): Promise<AgentConnection> {
    const found = await withTenant(this.db, tenantId, (tx) =>
      tx
        .selectFrom('agent_connections')
        .select('id')
        .where('user_id', '=', userId)
        .where('source', '=', source)
        .where('revoked_at', 'is', null)
        .executeTakeFirst(),
    );
    const id = found?.id ?? (await this.connect({ tenantId, userId, source, label })).id;
    return { id, tenantId, userId, source };
  }

  async connections(tenantId: string, userId: string) {
    return withTenant(this.db, tenantId, (tx) =>
      tx
        .selectFrom('agent_connections')
        .select(['id', 'source', 'label', 'last_seen_at', 'created_at'])
        .where('user_id', '=', userId)
        .where('revoked_at', 'is', null)
        .orderBy('created_at', 'desc')
        .execute(),
    );
  }

  /** 鍵を取り消す。本人の鍵でなければ false。 */
  async revoke(tenantId: string, userId: string, id: string): Promise<boolean> {
    const result = await withTenant(this.db, tenantId, (tx) =>
      tx
        .updateTable('agent_connections')
        .set({ revoked_at: this.now() })
        .where('id', '=', id)
        .where('user_id', '=', userId)
        .where('revoked_at', 'is', null)
        .executeTakeFirst(),
    );
    return Number(result.numUpdatedRows) > 0;
  }

  /** だれの鍵か（形が違う・知らない・取り消し済みなら null）。 */
  async identify(token: string): Promise<AgentConnection | null> {
    if (!TOKEN.test(token)) return null;
    const row = await withIdentity(this.db, (tx) =>
      tx
        .selectFrom('agent_connections')
        .select(['id', 'tenant_id', 'user_id', 'source', 'revoked_at'])
        .where('token_hash', '=', hash(token))
        .executeTakeFirst(),
    );
    if (!row || row.revoked_at) return null;
    return {
      id: row.id,
      tenantId: row.tenant_id,
      userId: row.user_id,
      source: row.source as AgentSource,
    };
  }

  /** 出来事 1 つをセッションの行へ畳む。 */
  async record(connection: AgentConnection, e: HookEvent): Promise<AgentSession> {
    const now = this.now();
    const t = transitionFor(e);
    return withTenant(this.db, connection.tenantId, async (tx) => {
      await tx
        .updateTable('agent_connections')
        .set({ last_seen_at: now })
        .where('id', '=', connection.id)
        .execute();
      const current = await tx
        .selectFrom('agent_sessions')
        .select([...COLUMNS, 'turn_ended_at'])
        .where('user_id', '=', connection.userId)
        .where('source', '=', connection.source)
        .where('external_session_id', '=', e.sessionId)
        .forUpdate()
        .executeTakeFirst();
      const title = e.event === 'UserPromptSubmit' ? titleFrom(e.prompt) : null;
      const project = projectName(e.cwd);
      // 本人が保留にした名前のフォルダ・頼みなら、届いた時点から静かにする（見守りに戻したものは除く）
      const hold =
        !current ||
        (!current.held_by &&
          current.user_policy === 'watch' &&
          (title !== null || (project !== null && !current.project)))
          ? await holdMatching(tx, connection.userId, project ?? current?.project ?? null, title)
          : null;
      const check = checkFor(e, (current?.check_state as CheckState | undefined) ?? 'none');
      if (!current) {
        const row = await tx
          .insertInto('agent_sessions')
          .values({
            id: uuidv7(),
            tenant_id: connection.tenantId,
            user_id: connection.userId,
            connection_id: connection.id,
            source: connection.source,
            external_session_id: e.sessionId,
            project,
            title,
            state: t?.state ?? 'idle',
            waiting_reason: t?.waitingReason ?? null,
            last_event: e.event.slice(0, 40),
            last_activity_at: now,
            state_since: now,
            ...(hold ? { held_by: hold, user_policy: 'paused_by_user' } : {}),
            ...(check ? { check_state: check, checked_at: now } : {}),
            check_after: checkAfterFor({
              state: t?.state ?? 'idle',
              userPolicy: hold ? 'paused_by_user' : 'watch',
              stateSince: now,
              lastActivityAt: now,
            }),
            turn_ended_at: t?.turnEnded ? now : null,
            ended_at: t?.ended ? now : null,
            end_reason: t?.ended?.reason ?? null,
          })
          .returning(COLUMNS)
          .executeTakeFirstOrThrow();
        const created = rowToSession(row);
        await addMarks(tx, connection.tenantId, created.id, marksFor(e, null, created, check), now);
        return created;
      }
      const turnEndedAt = current.turn_ended_at ? new Date(current.turn_ended_at) : null;
      const justEnded =
        turnEndedAt !== null && now.getTime() - turnEndedAt.getTime() < TURN_SETTLE_MS;
      // Stop 直後に遅れて届いた道具の出来事と、終わったあとの出来事では状態を変えない
      const keepState =
        !t ||
        (t.activityOnly && justEnded) ||
        (current.state === 'ended' && e.event !== 'SessionStart');
      const state = keepState ? (current.state as AgentState) : t.state!;
      const waitingReason = keepState ? current.waiting_reason : (t.waitingReason ?? null);
      // 同じ待ちに出来事が重ねて届いても、待ちの始まりは動かさない（知らせを遅らせない・二度出さない）
      const stateSince =
        state === current.state && waitingReason === current.waiting_reason
          ? new Date(current.state_since)
          : now;
      const row = await tx
        .updateTable('agent_sessions')
        .set({
          ...(keepState
            ? {}
            : {
                state: t.state!,
                waiting_reason: t.waitingReason ?? null,
                ...(t.turnEnded ? { turn_ended_at: now } : {}),
                ...(e.event === 'UserPromptSubmit' ? { turn_ended_at: null } : {}),
                ...(t.ended
                  ? { ended_at: now, end_reason: t.ended.reason }
                  : { ended_at: null, end_reason: null }),
              }),
          // 名前は最初の頼みで決める（あとの頼みで変えない）
          ...(title && !current.title ? { title } : {}),
          ...(project && !current.project ? { project } : {}),
          last_event: e.event.slice(0, 40),
          last_activity_at: now,
          state_since: stateSince,
          ...(hold ? { held_by: hold, user_policy: 'paused_by_user' } : {}),
          ...(check && check !== current.check_state
            ? { check_state: check, checked_at: now }
            : {}),
          check_after: checkAfterFor({
            state,
            userPolicy: hold ? 'paused_by_user' : (current.user_policy as UserPolicy),
            stateSince,
            lastActivityAt: now,
          }),
          updated_at: now,
        })
        .where('id', '=', current.id)
        .returning(COLUMNS)
        .executeTakeFirstOrThrow();
      const updated = rowToSession(row);
      await addMarks(
        tx,
        connection.tenantId,
        updated.id,
        marksFor(
          e,
          {
            state: current.state as AgentState,
            waitingReason: current.waiting_reason,
            checkState: current.check_state as CheckState,
            title: current.title,
          },
          updated,
          check,
        ),
        now,
      );
      return updated;
    });
  }

  /** 開いているセッションと、この 1 日に終わったもの。動いた順。 */
  async list(tenantId: string, userId: string, limit = 50): Promise<AgentSession[]> {
    const since = new Date(this.now().getTime() - 24 * 3600_000);
    const rows = await withTenant(this.db, tenantId, (tx) =>
      tx
        .selectFrom('agent_sessions')
        .select(COLUMNS)
        .where('user_id', '=', userId)
        .where((eb) => eb.or([eb('ended_at', 'is', null), eb('ended_at', '>', since)]))
        .orderBy('last_activity_at', 'desc')
        .limit(limit)
        .execute(),
    );
    return rows.map(rowToSession);
  }

  /** 本人のセッション 1 件（無ければ null）。 */
  async get(tenantId: string, userId: string, id: string): Promise<AgentSession | null> {
    const row = await withTenant(this.db, tenantId, (tx) =>
      tx
        .selectFrom('agent_sessions')
        .select(COLUMNS)
        .where('id', '=', id)
        .where('user_id', '=', userId)
        .executeTakeFirst(),
    );
    return row ? rowToSession(row) : null;
  }

  /** 本人が止める（見守らない）・見守りに戻す。本人のセッションでなければ null。 */
  async setPolicy(
    tenantId: string,
    userId: string,
    id: string,
    policy: UserPolicy,
  ): Promise<AgentSession | null> {
    const row = await withTenant(this.db, tenantId, async (tx) => {
      // 見守りに戻したら保留からも外す（本人がこのセッションだけ戻した）
      const updated = await tx
        .updateTable('agent_sessions')
        .set({
          user_policy: policy,
          ...(policy === 'watch' ? { held_by: null } : {}),
          updated_at: sql<Date>`now()`,
        })
        .where('id', '=', id)
        .where('user_id', '=', userId)
        .returning(COLUMNS)
        .executeTakeFirst();
      if (!updated) return undefined;
      // 止めたら見回りから外す。戻したら、まだ待っているものはまた知らせの対象にする
      const s = rowToSession(updated);
      await tx
        .updateTable('agent_sessions')
        .set({ check_after: checkAfterFor(s) })
        .where('id', '=', id)
        .execute();
      return updated;
    });
    return row ? rowToSession(row) : null;
  }
}
