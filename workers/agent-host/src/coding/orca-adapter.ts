/** Orca's local CLI is a transport to a running Orca runtime, not a task store. */
import { execFile } from 'node:child_process';
import { mkdir, realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';

export type CodingAgent = 'claude' | 'codex';
function agentCommand(agent: CodingAgent, sessionId?: string): string {
  if (agent === 'claude') {
    return sessionId
      ? `claude --permission-mode manual --resume ${sessionId}`
      : 'claude --permission-mode manual';
  }
  return sessionId
    ? `codex --sandbox workspace-write --ask-for-approval on-request resume ${sessionId}`
    : 'codex --sandbox workspace-write --ask-for-approval on-request';
}
export type OrcaCommand = (
  executable: string,
  args: readonly string[],
  cwd: string,
  signal?: AbortSignal,
) => Promise<unknown>;

export class OrcaError extends Error {
  constructor(
    readonly code:
      | 'not_installed'
      | 'runtime_unavailable'
      | 'invalid_response'
      | 'command_failed'
      | 'path_denied'
      | 'cancelled'
      | 'delivery_unconfirmed'
      | 'workspace_trust_required',
    message: string,
    readonly terminal?: string,
  ) {
    super(message);
    this.name = 'OrcaError';
  }
}

function scrub(message: string): string {
  // CLI stderr can contain prompts, paths, credentials and transcript content.
  if (/ENOENT/.test(message)) return 'Orca CLI が見つかりません。';
  return 'Orca CLI の操作に失敗しました。Orca の起動状態を確認してください。';
}

export const execOrca: OrcaCommand = (executable, args, cwd, signal) =>
  new Promise((done, fail) => {
    execFile(
      executable,
      [...args, '--json'],
      { cwd, timeout: 30_000, maxBuffer: 4 * 1024 * 1024, signal, shell: false },
      (error, stdout) => {
        // Orca exits 1 for an unsatisfied terminal wait while still returning a
        // valid JSON receipt (including a reason such as agent-trust-workspace).
        if (error && args[0] === 'terminal' && args[1] === 'wait') {
          try {
            const value: unknown = JSON.parse(stdout);
            const envelope = value as { ok?: unknown; result?: { wait?: unknown } };
            const wait = envelope?.result?.wait;
            if (envelope.ok === true && wait && typeof wait === 'object') {
              done(value);
              return;
            }
          } catch {
            /* report the original command failure below */
          }
        }
        if (error) {
          const code = (error as NodeJS.ErrnoException).code;
          fail(
            new OrcaError(
              code === 'ENOENT'
                ? 'not_installed'
                : code === 'ABORT_ERR'
                  ? 'cancelled'
                  : 'command_failed',
              scrub(String(error)),
            ),
          );
          return;
        }
        try {
          const value: unknown = JSON.parse(stdout);
          if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
          const envelope = value as { ok?: unknown; error?: { message?: unknown } };
          if (envelope.ok === false) {
            fail(new OrcaError('command_failed', 'Orca が操作を拒否しました。'));
            return;
          }
          done(value);
        } catch {
          fail(new OrcaError('invalid_response', 'Orca CLI の JSON 応答を読み取れませんでした。'));
        }
      },
    );
  });

function terminalHandle(value: unknown): string {
  const object = value as Record<string, unknown>;
  const data =
    object['result'] && typeof object['result'] === 'object'
      ? (object['result'] as Record<string, unknown>)
      : object['data'] && typeof object['data'] === 'object'
        ? (object['data'] as Record<string, unknown>)
        : object;
  const terminal =
    data['terminal'] && typeof data['terminal'] === 'object'
      ? (data['terminal'] as Record<string, unknown>)
      : data;
  const handle =
    terminal['handle'] ?? terminal['terminalId'] ?? terminal['terminal_id'] ?? terminal['id'];
  if (typeof handle !== 'string' || !handle || handle.length > 256) {
    throw new OrcaError('invalid_response', 'Orca が terminal の識別子を返しませんでした。');
  }
  return handle;
}

export interface OrcaAdapterOptions {
  /** Administrator-configured workspace roots; symlinks are resolved before comparison. */
  readonly roots: readonly string[];
  readonly executable: string;
  readonly run?: OrcaCommand;
  readonly initGit?: (path: string) => Promise<void>;
}

export interface OrcaReadiness {
  readonly reachable: boolean;
  readonly state: string;
}

export type OrcaTurnState = 'working' | 'idle' | 'quota' | 'exited' | 'unknown';

/** Only agent-rendered error lines count; the user's echoed prompt is never a quota signal. */
export function quotaOnScreen(lines: readonly string[], agent: CodingAgent): boolean {
  return lines.some((line) => {
    const text = line.trim();
    if (agent === 'claude')
      return (
        /^⎿\s*You've hit your (?:weekly|usage) limit\b/i.test(text) ||
        /^⎿\s*(?:Usage|Rate) limit (?:reached|exceeded)\b/i.test(text)
      );
    return /^(?:•|⚠|Error:|ERROR:)\s*.*(?:rate limit|usage limit|quota exceeded)/i.test(text);
  });
}

export type OrcaSessionSearch =
  | { readonly kind: 'unavailable'; readonly reason: 'disabled' | 'unavailable' }
  | {
      readonly kind: 'results';
      readonly sessions: readonly {
        readonly agent: CodingAgent;
        readonly sessionId: string;
        readonly cwd: string;
        readonly updatedAt: string;
        readonly messageCount: number;
      }[];
    };

export class OrcaAdapter {
  readonly #options: OrcaAdapterOptions;
  readonly #run: OrcaCommand;

  constructor(options: OrcaAdapterOptions) {
    if (!isAbsolute(options.executable))
      throw new Error('Orca executable must be an absolute path');
    if (!options.roots.length || options.roots.some((root) => !isAbsolute(root))) {
      throw new Error('Orca workspace roots must be absolute paths');
    }
    this.#options = options;
    this.#run = options.run ?? execOrca;
  }

  async #workspace(path: string): Promise<string> {
    if (!isAbsolute(path))
      throw new OrcaError('path_denied', '絶対パスの作業場所を指定してください。');
    let actual: string;
    try {
      actual = await realpath(path);
      if (!(await stat(actual)).isDirectory()) throw new Error();
    } catch {
      throw new OrcaError('path_denied', '作業場所が見つかりません。');
    }
    for (const root of this.#options.roots) {
      const allowed = await realpath(root);
      const rel = relative(allowed, actual);
      if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))) return actual;
    }
    throw new OrcaError('path_denied', '許可された作業場所の外です。');
  }

  async #call(args: readonly string[], cwd: string, signal?: AbortSignal): Promise<unknown> {
    if (signal?.aborted) throw new OrcaError('cancelled', 'Orca の操作を取り消しました。');
    return this.#run(this.#options.executable, args, cwd, signal);
  }

  async #waitReady(terminal: string, workspace: string, signal?: AbortSignal): Promise<void> {
    try {
      const waited = (await this.#call(
        ['terminal', 'wait', '--terminal', terminal, '--for', 'tui-idle', '--timeout-ms', '20000'],
        workspace,
        signal,
      )) as {
        result?: { wait?: { satisfied?: unknown; status?: unknown; blockedReason?: unknown } };
      };
      if (waited.result?.wait?.blockedReason === 'agent-trust-workspace') {
        throw new OrcaError(
          'workspace_trust_required',
          'Orca の terminal で、この作業フォルダを信頼するか確認してください。指示はまだ送っていません。',
          terminal,
        );
      }
      if (waited.result?.wait?.satisfied !== true || waited.result.wait.status !== 'running') {
        throw new OrcaError(
          'invalid_response',
          'エージェントの入力待ち状態を確認できませんでした。',
        );
      }
    } catch (error) {
      if (!(error instanceof OrcaError && error.code === 'workspace_trust_required')) {
        await this.#call(['terminal', 'close', '--terminal', terminal], workspace).catch(
          () => undefined,
        );
      }
      throw error;
    }
  }

  /** Readiness distinguishes a missing executable from a stopped runtime. */
  async status(signal?: AbortSignal): Promise<OrcaReadiness> {
    try {
      const response = (await this.#call(['status'], resolve(this.#options.roots[0]!), signal)) as {
        result?: { runtime?: { reachable?: unknown; state?: unknown } };
      };
      const runtime = response.result?.runtime;
      if (typeof runtime?.reachable !== 'boolean' || typeof runtime.state !== 'string') {
        throw new OrcaError('invalid_response', 'Orca の状態応答を読み取れませんでした。');
      }
      return { reachable: runtime.reachable, state: runtime.state };
    } catch (error) {
      if (error instanceof OrcaError && error.code === 'command_failed') {
        throw new OrcaError('runtime_unavailable', 'Orca ランタイムに接続できません。');
      }
      throw error;
    }
  }

  async register(path: string, signal?: AbortSignal): Promise<unknown> {
    const workspace = await this.#workspace(path);
    return this.#call(['repo', 'add', '--path', workspace], workspace, signal);
  }

  /** Active editable agent terminals in this exact workspace. */
  async activeAgents(path: string, signal?: AbortSignal): Promise<readonly string[]> {
    const workspace = await this.#workspace(path);
    const response = (await this.#call(
      ['terminal', 'list', '--worktree', `path:${workspace}`],
      workspace,
      signal,
    )) as {
      result?: { terminals?: unknown };
    };
    if (!Array.isArray(response.result?.terminals)) {
      throw new OrcaError('invalid_response', 'Orca の terminal 一覧を読み取れませんでした。');
    }
    return response.result.terminals.flatMap((entry: unknown) => {
      if (!entry || typeof entry !== 'object') return [];
      const row = entry as Record<string, unknown>;
      return (row['agentIdentity'] === 'claude' || row['agentIdentity'] === 'codex') &&
        row['worktreePath'] === workspace &&
        row['connected'] === true &&
        row['writable'] === true &&
        typeof row['handle'] === 'string'
        ? [row['handle']]
        : [];
    });
  }

  /** Observe the current turn without sending input to the agent. */
  async observe(
    path: string,
    agent: CodingAgent,
    terminal: string,
    signal?: AbortSignal,
  ): Promise<OrcaTurnState> {
    const workspace = await this.#workspace(path);
    if (!/^term_[a-f\d-]{16,80}$/i.test(terminal))
      throw new OrcaError('invalid_response', 'Orca terminal の識別子が無効です。');
    const response = (await this.#call(
      ['terminal', 'read', '--terminal', terminal, '--screen'],
      workspace,
      signal,
    )) as {
      result?: {
        terminal?: { handle?: unknown; status?: unknown; source?: unknown; tail?: unknown };
      };
    };
    const view = response.result?.terminal;
    if (
      view?.handle !== terminal ||
      !Array.isArray(view.tail) ||
      !view.tail.every((line: unknown) => typeof line === 'string')
    )
      return 'unknown';
    if (view.source === 'screen' && quotaOnScreen(view.tail as string[], agent)) return 'quota';
    if (view.status === 'exited') return 'exited';
    if (view.source !== 'screen' || view.status !== 'running') return 'unknown';
    try {
      const waited = (await this.#call(
        ['terminal', 'wait', '--terminal', terminal, '--for', 'tui-idle', '--timeout-ms', '1000'],
        workspace,
        signal,
      )) as { result?: { wait?: { satisfied?: unknown; status?: unknown } } };
      return waited.result?.wait?.satisfied === true && waited.result.wait.status === 'running'
        ? 'idle'
        : 'working';
    } catch (error) {
      if (error instanceof OrcaError && error.code === 'command_failed') return 'working';
      throw error;
    }
  }

  /** Close only the captured terminal, then prove it is absent before a replacement starts. */
  async closeForHandoff(path: string, terminal: string, signal?: AbortSignal): Promise<void> {
    const workspace = await this.#workspace(path);
    await this.#call(['terminal', 'close', '--terminal', terminal], workspace, signal);
    if ((await this.activeAgents(workspace, signal)).includes(terminal))
      throw new OrcaError(
        'delivery_unconfirmed',
        '元の terminal を停止したか確認できません。',
        terminal,
      );
  }

  /** Creates exactly one new directory under a configured root, then initializes Git and registers it. */
  async create(
    root: string,
    name: string,
    signal?: AbortSignal,
  ): Promise<{ path: string; registration: unknown }> {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(name) || name === '.' || name === '..') {
      throw new OrcaError('path_denied', 'プロジェクト名が無効です。');
    }
    const actualRoot = await realpath(root);
    const allowed = await Promise.all(this.#options.roots.map((item) => realpath(item)));
    if (!allowed.includes(actualRoot))
      throw new OrcaError('path_denied', '許可された保存先ではありません。');
    const path = resolve(actualRoot, name);
    await mkdir(path);
    const initGit =
      this.#options.initGit ??
      ((cwd: string) =>
        new Promise<void>((done, fail) => {
          execFile(
            '/usr/bin/git',
            ['init', '--', cwd],
            { cwd, timeout: 10_000, shell: false },
            (error) => {
              if (error)
                fail(new OrcaError('command_failed', 'Git リポジトリを初期化できませんでした。'));
              else done();
            },
          );
        }));
    await initGit(path);
    return { path, registration: await this.register(path, signal) };
  }

  /** Starts the agent CLI without Orca's full-autonomy agent-launch defaults. */
  async launch(
    path: string,
    agent: CodingAgent,
    prompt: string,
    signal?: AbortSignal,
  ): Promise<{ terminal: string }> {
    const workspace = await this.#workspace(path);
    if (!['claude', 'codex'].includes(agent) || !prompt.trim() || prompt.length > 8_000) {
      throw new OrcaError('command_failed', 'エージェントまたは指示が無効です。');
    }
    const opened = await this.#call(
      ['terminal', 'create', '--worktree', `path:${workspace}`, '--command', agentCommand(agent)],
      workspace,
      signal,
    );
    const terminal = terminalHandle(opened);
    // Never send a natural-language prompt to a shell before the agent TUI is ready.
    await this.#waitReady(terminal, workspace, signal);
    try {
      const sent = (await this.#call(
        [
          'terminal',
          'send',
          '--terminal',
          terminal,
          '--text',
          prompt,
          '--enter',
          '--wait-submit',
          '5',
        ],
        workspace,
        signal,
      )) as {
        result?: { send?: { accepted?: unknown } };
      };
      if (sent.result?.send?.accepted !== true) {
        throw new OrcaError(
          'delivery_unconfirmed',
          'Orca が指示の受付を確認できませんでした。',
          terminal,
        );
      }
    } catch {
      throw new OrcaError(
        'delivery_unconfirmed',
        '指示が届いたか確認できません。Orca の terminal を確認してください。',
        terminal,
      );
    }
    return { terminal };
  }

  async search(
    path: string,
    agent: CodingAgent,
    query: string,
    signal?: AbortSignal,
  ): Promise<OrcaSessionSearch> {
    const workspace = await this.#workspace(path);
    if (!['claude', 'codex'].includes(agent) || !query.trim() || query.length > 500) {
      throw new OrcaError('command_failed', '検索条件が無効です。');
    }
    const response = (await this.#call(
      ['search', '--query', query, '--agent', agent, '--path', workspace, '--limit', '20'],
      workspace,
      signal,
    )) as {
      result?: { kind?: unknown; reason?: unknown; hits?: unknown };
    };
    const result = response.result;
    if (result?.kind === 'unavailable') {
      return {
        kind: 'unavailable',
        reason: result.reason === 'disabled' ? 'disabled' : 'unavailable',
      };
    }
    if (result?.kind !== 'results' || !Array.isArray(result.hits)) {
      throw new OrcaError('invalid_response', 'Orca の検索応答を読み取れませんでした。');
    }
    const sessions = result.hits.flatMap((hit: unknown) => {
      if (!hit || typeof hit !== 'object') return [];
      const row = hit as Record<string, unknown>;
      if (
        row['agent'] !== agent ||
        row['cwd'] !== workspace ||
        typeof row['sessionId'] !== 'string' ||
        !/^[a-f\d]{8}-[a-f\d-]{27,40}$/i.test(row['sessionId']) ||
        typeof row['updatedAt'] !== 'string' ||
        typeof row['messageCount'] !== 'number'
      )
        return [];
      return [
        {
          agent,
          sessionId: row['sessionId'],
          cwd: workspace,
          updatedAt: row['updatedAt'],
          messageCount: row['messageCount'],
        },
      ];
    });
    return { kind: 'results', sessions };
  }

  /** The public CLI has no session-resume command. Open a terminal with the agent's documented resume argv. */
  async resume(
    path: string,
    agent: CodingAgent,
    sessionId: string,
    signal?: AbortSignal,
  ): Promise<{ terminal: string }> {
    const workspace = await this.#workspace(path);
    if (!['claude', 'codex'].includes(agent) || !/^[a-f\d]{8}-[a-f\d-]{27,40}$/i.test(sessionId)) {
      throw new OrcaError('command_failed', 'セッション ID が無効です。');
    }
    const command = agentCommand(agent, sessionId);
    const terminal = terminalHandle(
      await this.#call(
        ['terminal', 'create', '--worktree', `path:${workspace}`, '--command', command],
        workspace,
        signal,
      ),
    );
    await this.#waitReady(terminal, workspace, signal);
    return { terminal };
  }
}
