/**
 * 本人が Genie を通さずに始めたセッションを見つける（本人の方針 2026-10-30）。
 *
 *   Claude Code … 登録済みの hooks がすべてのセッションから届く（ここでは何もしない）
 *   Codex       … hooks が無いので、記録のファイル（~/.codex/sessions/年/月/日/rollout-*.jsonl）を読む
 *                 **読むだけ。**種類・セッション・作業フォルダ・最初の頼みの頭だけを取り出し、本文は持ち出さない
 *                 実機では未確認（この Mac に codex が無い）。形は検査の写しで見ている。読めない行は飛ばす
 *
 * 見つけたセッションは hooks と同じ入口（AgentSessionStore.record）へ畳むので、状態・知らせ・保留は同じ扱いになる。
 * 同じセッションは同じ行に畳まれる（セッションの id で一意）。取り込みは observed（読むだけ）。
 */
import { open, readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { withIdentity, type DbHandle } from '@genie/db';
import type { AgentJobs } from './agent-jobs.js';
import {
  asksUser,
  type AgentConnection,
  type AgentSessionStore,
  type HookEvent,
} from './agent-sessions.js';

const HEAD_BYTES = 1024 * 1024;
const TAIL_BYTES = 256 * 1024;
const RECENT_MS = 24 * 3600_000;
const MAX_FILES = 200;
/** 初めて読んだ記録がこれより前に止まっていれば、知らせない（読み直しただけ）。 */
const STALE_MS = 5 * 60_000;

export type DiscoveredState = 'working' | 'waiting_user' | 'idle';

export interface DiscoveredSession {
  readonly sessionId: string;
  readonly cwd: string | null;
  readonly prompt: string | null;
  readonly state: DiscoveredState;
  /** 待っているのが承認か、本人の答え（request_user_input・問いで終えた応答）か */
  readonly waiting?: 'permission' | 'input';
}

function lines(text: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const value: unknown = JSON.parse(line);
      if (value && typeof value === 'object') out.push(value as Record<string, unknown>);
    } catch {
      // 頭と末尾だけ読むので、切れた行はここへ来る
    }
  }
  return out;
}

/** Codex の記録の頭と末尾から、セッションと今の状態を読む。読めなければ null。 */
export function parseCodexRollout(head: string, tail: string): DiscoveredSession | null {
  let sessionId: string | null = null;
  let cwd: string | null = null;
  let prompt: string | null = null;
  for (const row of lines(head)) {
    const payload = row['payload'] as Record<string, unknown> | undefined;
    if (!payload) continue;
    if (row['type'] === 'session_meta') {
      if (typeof payload['id'] === 'string') sessionId = payload['id'];
      if (typeof payload['cwd'] === 'string') cwd = payload['cwd'];
    }
    if (prompt === null && row['type'] === 'event_msg' && payload['type'] === 'user_message') {
      if (typeof payload['message'] === 'string') prompt = payload['message'];
    }
  }
  if (!sessionId) return null;
  let state: DiscoveredState = 'working';
  let waiting: 'permission' | 'input' | undefined;
  // この回に本人へ答えを求めたか（request_user_input）。_async は受け付けの返事がすぐ来て、本人の答えは
  // 次の頼み（user_message）として届く（2026-11-07 の実物）。同期のものは答え（出力）が来るまで待ち
  let askedThisTurn = false;
  const pendingSync = new Set<string>();
  for (const row of lines(tail)) {
    const payload = row['payload'] as Record<string, unknown> | undefined;
    if (row['type'] === 'response_item' && payload) {
      const callId = typeof payload['call_id'] === 'string' ? payload['call_id'] : null;
      const name = typeof payload['name'] === 'string' ? payload['name'] : '';
      if (payload['type'] === 'function_call' && /^request_user_input/.test(name)) {
        askedThisTurn = true;
        if (callId && !/_async$/.test(name)) pendingSync.add(callId);
        state = 'waiting_user';
        waiting = 'input';
      } else if (payload['type'] === 'function_call_output' && callId) {
        if (pendingSync.delete(callId) && pendingSync.size === 0 && waiting === 'input') {
          state = 'working';
          waiting = undefined;
        }
      }
      continue;
    }
    if (row['type'] !== 'event_msg' || typeof payload?.['type'] !== 'string') continue;
    const kind = payload['type'];
    if (/approval_request$/.test(kind)) {
      state = 'waiting_user';
      waiting = 'permission';
    } else if (kind === 'task_complete') {
      // この回に問いを出したか、最後の文が本人への問いなら、返事を待っている（文は見るだけで持ち出さない）
      const last = payload['last_agent_message'];
      const asks = askedThisTurn || asksUser(typeof last === 'string' ? last : undefined);
      state = asks ? 'waiting_user' : 'idle';
      waiting = asks ? 'input' : undefined;
    } else if (kind === 'turn_aborted') {
      state = 'idle';
      waiting = undefined;
    } else if (kind === 'task_started' || kind === 'user_message') {
      state = 'working';
      waiting = undefined;
      askedThisTurn = false;
      pendingSync.clear();
    } else if (/^exec_command|^patch_apply/.test(kind) && waiting !== 'input') {
      state = 'working';
      waiting = undefined;
    }
  }
  return { sessionId, cwd, prompt, state, ...(waiting ? { waiting } : {}) };
}

/** 状態を hooks の出来事の形にする（入口を 1 つにする）。 */
export function eventsFor(
  found: DiscoveredSession,
  firstSeen: boolean,
  quiet = false,
): HookEvent[] {
  const base = {
    sessionId: found.sessionId,
    ...(found.cwd ? { cwd: found.cwd } : {}),
    ...(quiet ? { quiet: true } : {}),
  };
  const events: HookEvent[] = [];
  if (firstSeen) {
    events.push({ ...base, event: 'SessionStart' });
    if (found.prompt) events.push({ ...base, event: 'UserPromptSubmit', prompt: found.prompt });
  }
  events.push({
    ...base,
    event:
      found.state === 'waiting_user'
        ? found.waiting === 'input'
          ? 'Elicitation'
          : 'PermissionRequest'
        : found.state === 'idle'
          ? 'Stop'
          : 'PreToolUse',
  });
  return events;
}

async function readEnds(path: string, size: number): Promise<{ head: string; tail: string }> {
  const file = await open(path, 'r');
  try {
    const headBuf = Buffer.alloc(Math.min(HEAD_BYTES, size));
    await file.read(headBuf, 0, headBuf.length, 0);
    const tailLen = Math.min(TAIL_BYTES, size);
    const tailBuf = Buffer.alloc(tailLen);
    await file.read(tailBuf, 0, tailLen, size - tailLen);
    return { head: headBuf.toString('utf8'), tail: tailBuf.toString('utf8') };
  } finally {
    await file.close();
  }
}

async function recentFiles(
  root: string,
  since: number,
): Promise<{ path: string; mtime: number; size: number }[]> {
  const out: { path: string; mtime: number; size: number }[] = [];
  const walk = async (dir: string): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (/^rollout-.*\.jsonl$/.test(entry.name)) {
        const info = await stat(path).catch(() => null);
        if (info && info.mtimeMs >= since) out.push({ path, mtime: info.mtimeMs, size: info.size });
      }
    }
  };
  await walk(root);
  return out.sort((a, b) => b.mtime - a.mtime).slice(0, MAX_FILES);
}

export interface AgentDiscoveryDeps {
  readonly db: DbHandle;
  readonly store: AgentSessionStore;
  readonly jobs: Pick<AgentJobs, 'observe'>;
  /** Codex の記録の場所（検査用に差し替える）。 */
  readonly codexRoot?: string;
  readonly now?: () => Date;
  readonly log?: (event: string, detail: Record<string, unknown>) => void;
}

export class AgentDiscovery {
  /** ファイルごとの、最後に見た更新時刻と状態（変わったときだけ出来事にする）。 */
  readonly #seen = new Map<string, { mtime: number; state: DiscoveredState }>();
  #connection: AgentConnection | null = null;
  #timer: NodeJS.Timeout | null = null;

  constructor(private readonly deps: AgentDiscoveryDeps) {}

  start(intervalMs = 60_000): void {
    if (this.#timer) return;
    this.#timer = setInterval(() => void this.tick().catch(() => 0), intervalMs);
    this.#timer.unref?.();
    void this.tick().catch(() => 0);
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
  }

  /** この Mac の持ち主（hooks を登録した人）。登録がなければ何もしない。 */
  async #owner(): Promise<AgentConnection | null> {
    if (this.#connection) return this.#connection;
    const row = await withIdentity(this.deps.db, (tx) =>
      tx
        .selectFrom('agent_connections')
        .select(['tenant_id', 'user_id'])
        .where('revoked_at', 'is', null)
        .orderBy('id', 'desc')
        .limit(1)
        .executeTakeFirst(),
    );
    if (!row) return null;
    this.#connection = await this.deps.store.ownConnection(
      row.tenant_id,
      row.user_id,
      'codex',
      'Codex（自動発見）',
    );
    return this.#connection;
  }

  /** 新しく動いた記録を見る。返すのは出来事にしたセッションの数。 */
  async tick(): Promise<number> {
    const root = this.deps.codexRoot ?? join(homedir(), '.codex', 'sessions');
    const now = (this.deps.now?.() ?? new Date()).getTime();
    const since = now - RECENT_MS;
    const files = await recentFiles(root, since);
    if (files.length === 0) return 0;
    const connection = await this.#owner();
    if (!connection) return 0;
    let changed = 0;
    for (const file of files) {
      const before = this.#seen.get(file.path);
      if (before?.mtime === file.mtime) continue;
      const { head, tail } = await readEnds(file.path, file.size);
      const found = parseCodexRollout(head, tail);
      this.#seen.set(file.path, { mtime: file.mtime, state: found?.state ?? 'working' });
      if (!found) continue;
      // Genie を起こし直したあとに初めて読む古い記録は、状態だけ戻して知らせない（今さらの「終わりました」を出さない）
      const quiet = !before && now - file.mtime > STALE_MS;
      for (const event of eventsFor(found, !before, quiet)) {
        const session = await this.deps.store.record(connection, event);
        await this.deps.jobs.observe(
          connection.tenantId,
          connection.userId,
          session,
          found.cwd ?? undefined,
        );
      }
      changed += 1;
    }
    return changed;
  }
}
