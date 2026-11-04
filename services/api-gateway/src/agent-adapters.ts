/**
 * エージェントの共通の窓口（本人の方針 2026-10-30: Claude Code 専用にしない）。
 *
 * Genie の側（agent-jobs.ts）は「起動する → 結果を受け取る」だけを知っていて、エージェントごとの違いはここに閉じる。
 *   Claude Code … `claude -p --output-format json`。費用・手数が取れる。承認は登録済みの hooks が LINE へ出す
 *                （実機で確かめた 2026-10-30: -p でも PermissionRequest の hooks が働き、ルールも当たる）
 *   Codex       … `codex exec --json --sandbox workspace-write`。費用は取れない（null。推した値を入れない）
 *                 **実機では未確認**（この Mac に codex が無い）。形は検査の写しで見ている
 *   ブラウザ担当 … まだつないでいない。製品（Muse など）が決まったら、ここに足す
 *
 * 出力の本文は持ち出さない。結果の種類と数だけを返す（note は本人に見せる短い理由で、出力を写さない）。
 */
import { spawn } from 'node:child_process';

export type AgentKind = 'claude_code' | 'codex' | 'opencode' | 'browser';

export type RunOutcome =
  | 'success'
  | 'error'
  /** 待てば通るかもしれない（混雑・回数制限・通信）。 */
  | 'transient'
  /** 結果を返さずに落ちた。 */
  | 'crashed'
  | 'limit_turns'
  | 'limit_cost'
  | 'limit_time'
  /** エージェントが起動できない（入っていない）。 */
  | 'unavailable';

export interface AgentRunRequest {
  readonly cwd: string;
  readonly prompt: string;
  /** 新しく始めるセッションの id（決められるエージェントだけ使う）。 */
  readonly sessionId: string;
  /** 続きから進めるなら、そのセッション。 */
  readonly resumeSessionId: string | null;
  readonly maxTurns: number;
  /** 残りの費用の上限（ドル）。 */
  readonly maxCostUsd: number;
  /** 残りの実行時間の時計。本人を待つあいだは止まる。 */
  readonly clock: RunClock;
  readonly signal?: AbortSignal;
}

export interface AgentRunResult {
  readonly outcome: RunOutcome;
  readonly sessionId: string | null;
  /** 取れなかったら null。 */
  readonly costUsd: number | null;
  readonly turns: number | null;
  readonly exitCode: number | null;
  /** 承認が得られずに止められた操作があったか。 */
  readonly permissionDenied: boolean;
  readonly note: string | null;
}

/** レビューの頼み。**読むだけ**で走らせる（ファイルを書き換えさせない）。 */
export interface AgentReviewRequest {
  readonly cwd: string;
  readonly prompt: string;
  readonly maxTurns: number;
  readonly maxCostUsd: number;
  readonly clock: RunClock;
  readonly signal?: AbortSignal;
}

export interface AgentReviewResult {
  readonly outcome: RunOutcome;
  /** レビューの本文（最後の返事）。直すときにエージェントへ渡すだけで、DB には残さない。 */
  readonly text: string | null;
  readonly costUsd: number | null;
  readonly turns: number | null;
  readonly note: string | null;
}

export interface AgentAdapter {
  readonly agent: AgentKind;
  readonly label: string;
  /** Genie が起動できるエージェントか（できないものは observed で見守るだけ）。 */
  readonly runnable: boolean;
  /** 費用が取れるエージェントか（取れなければ、時間と回数で止める）。 */
  readonly reportsCost: boolean;
  available(): Promise<boolean>;
  run(request: AgentRunRequest): Promise<AgentRunResult>;
  /** 別のエージェントの成果を読むだけで確かめる。できないエージェントは持たない。 */
  review?(request: AgentReviewRequest): Promise<AgentReviewResult>;
}

/** レビューで使ってよい道具（読む・探す・git で差分を見るだけ）。 */
export const REVIEW_BASH = [
  'Bash(git diff:*)',
  'Bash(git status:*)',
  'Bash(git log:*)',
  'Bash(git show:*)',
] as const;

/** 待てば通るかもしれない失敗の言い方。 */
const TRANSIENT =
  /rate.?limit|overload|\b429\b|\b5(?:00|02|03|29)\b|timed? ?out|ECONN|network|temporar/i;
const OUTPUT_LIMIT = 4 * 1024 * 1024;
const KILL_GRACE_MS = 5_000;

/**
 * 実際に動いている時間だけを数える時計。本人の承認を待つあいだは pause する
 * （そのあいだプロセスは hooks で止まっていて、API も費用も使わない）。
 */
export class RunClock {
  #remaining: number;
  #runningSince: number | null = null;
  #pausedSince: number | null = null;
  #pausedMs = 0;
  #timer: NodeJS.Timeout | null = null;
  #onExpire: (() => void) | null = null;

  constructor(
    ms: number,
    private readonly now: () => number = Date.now,
  ) {
    this.#remaining = ms;
  }

  start(onExpire: () => void): void {
    this.#onExpire = onExpire;
    this.#run();
  }

  #run(): void {
    this.#runningSince = this.now();
    this.#timer = setTimeout(() => this.#onExpire?.(), this.#remaining);
  }

  pause(): void {
    if (this.#pausedSince !== null) return;
    this.#pausedSince = this.now();
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
    if (this.#runningSince !== null)
      this.#remaining = Math.max(0, this.#remaining - (this.now() - this.#runningSince));
    this.#runningSince = null;
  }

  resume(): void {
    if (this.#pausedSince === null) return;
    this.#pausedMs += this.now() - this.#pausedSince;
    this.#pausedSince = null;
    if (this.#onExpire) this.#run();
  }

  stop(): void {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
    this.#onExpire = null;
  }

  /** 本人を待った時間。 */
  get pausedMs(): number {
    return this.#pausedMs + (this.#pausedSince === null ? 0 : this.now() - this.#pausedSince);
  }
}

interface Finished {
  readonly stdout: string;
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  readonly missing: boolean;
}

function runProcess(
  bin: string,
  args: readonly string[],
  options: { cwd: string; clock: RunClock; signal?: AbortSignal },
): Promise<Finished> {
  return new Promise((resolve) => {
    const child = spawn(bin, args, { cwd: options.cwd, stdio: ['ignore', 'pipe', 'ignore'] });
    let stdout = '';
    let timedOut = false;
    let killer: NodeJS.Timeout | null = null;
    const stop = () => {
      child.kill('SIGTERM');
      killer ??= setTimeout(() => child.kill('SIGKILL'), KILL_GRACE_MS);
    };
    options.clock.start(() => {
      timedOut = true;
      stop();
    });
    options.signal?.addEventListener('abort', stop, { once: true });
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
      // 結果は最後に出る。長い出力は頭から捨てる
      if (stdout.length > OUTPUT_LIMIT) stdout = stdout.slice(-OUTPUT_LIMIT);
    });
    const finish = (result: Omit<Finished, 'stdout' | 'timedOut'>) => {
      options.clock.stop();
      if (killer) clearTimeout(killer);
      options.signal?.removeEventListener('abort', stop);
      resolve({ stdout, timedOut, ...result });
    };
    child.on('error', (error: NodeJS.ErrnoException) =>
      finish({ exitCode: null, missing: error.code === 'ENOENT' }),
    );
    child.on('close', (code) => finish({ exitCode: code, missing: false }));
  });
}

async function responds(bin: string): Promise<boolean> {
  const done = await runProcess(bin, ['--version'], { cwd: '/', clock: new RunClock(10_000) });
  return !done.missing && done.exitCode === 0;
}

const lastLines = (text: string) =>
  text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .reverse();

function parseLine(line: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(line);
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const finite = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

const nothing = {
  sessionId: null,
  costUsd: null,
  turns: null,
  permissionDenied: false,
} as const;

/** `claude -p --output-format json` の結果を読む。 */
export function parseClaudeResult(done: Finished): AgentRunResult {
  if (done.missing)
    return {
      ...nothing,
      outcome: 'unavailable',
      exitCode: null,
      note: 'claude コマンドが見つかりません',
    };
  const result = lastLines(done.stdout)
    .map(parseLine)
    .find((v) => v?.['type'] === 'result');
  if (!result)
    return {
      ...nothing,
      outcome: done.timedOut ? 'limit_time' : 'crashed',
      exitCode: done.exitCode,
      note: done.timedOut ? '時間の上限で止めました' : '結果を返さずに終わりました',
    };
  const subtype = typeof result['subtype'] === 'string' ? result['subtype'] : '';
  const isError = result['is_error'] === true;
  const text = typeof result['result'] === 'string' ? result['result'] : '';
  const denials = result['permission_denials'];
  const outcome: RunOutcome = done.timedOut
    ? 'limit_time'
    : subtype === 'error_max_turns'
      ? 'limit_turns'
      : /budget/i.test(subtype)
        ? 'limit_cost'
        : !isError && subtype === 'success'
          ? 'success'
          : TRANSIENT.test(`${subtype} ${text}`)
            ? 'transient'
            : 'error';
  const notes: Partial<Record<RunOutcome, string>> = {
    limit_time: '時間の上限で止めました',
    limit_turns: '手数の上限で止めました',
    limit_cost: '費用の上限で止めました',
    transient: '混雑か通信の問題で止まりました',
    error: 'エージェントがエラーで止まりました',
  };
  return {
    outcome,
    sessionId: typeof result['session_id'] === 'string' ? result['session_id'] : null,
    costUsd: finite(result['total_cost_usd']),
    turns: finite(result['num_turns']),
    exitCode: done.exitCode,
    permissionDenied: Array.isArray(denials) && denials.length > 0,
    note: notes[outcome] ?? null,
  };
}

/** `claude -p` のレビューの結果。返事の本文も読む。 */
export function parseClaudeReview(done: Finished): AgentReviewResult {
  const base = parseClaudeResult(done);
  const result = lastLines(done.stdout)
    .map(parseLine)
    .find((v) => v?.['type'] === 'result');
  const text = typeof result?.['result'] === 'string' ? result['result'] : null;
  return {
    outcome: base.outcome,
    text,
    costUsd: base.costUsd,
    turns: base.turns,
    note: base.note,
  };
}

/** `codex exec --json` のレビューの結果。最後のエージェントの返事を本文にする。 */
export function parseCodexReview(done: Finished): AgentReviewResult {
  const base = parseCodexResult(done);
  let text: string | null = null;
  for (const line of done.stdout.split('\n')) {
    const event = line.trim() ? parseLine(line) : null;
    const item = event?.['item'] as { type?: unknown; text?: unknown } | undefined;
    if (event?.['type'] === 'item.completed' && item?.type === 'agent_message')
      text = typeof item.text === 'string' ? item.text : text;
  }
  return { outcome: base.outcome, text, costUsd: null, turns: base.turns, note: base.note };
}

/** `codex exec --json` の出来事の列を読む。費用は出ない（null）。 */
export function parseCodexResult(done: Finished): AgentRunResult {
  if (done.missing)
    return {
      ...nothing,
      outcome: 'unavailable',
      exitCode: null,
      note: 'codex コマンドが見つかりません',
    };
  let sessionId: string | null = null;
  let turns = 0;
  let failure: string | null = null;
  for (const line of done.stdout.split('\n')) {
    const event = line.trim() ? parseLine(line) : null;
    if (!event) continue;
    if (event['type'] === 'thread.started' && typeof event['thread_id'] === 'string')
      sessionId = event['thread_id'];
    if (event['type'] === 'turn.completed') turns += 1;
    if (event['type'] === 'turn.failed' || event['type'] === 'error') {
      const nested = event['error'] as { message?: unknown } | undefined;
      const message = nested?.message ?? event['message'];
      failure = typeof message === 'string' ? message : 'error';
    }
  }
  const outcome: RunOutcome = done.timedOut
    ? 'limit_time'
    : failure !== null
      ? TRANSIENT.test(failure)
        ? 'transient'
        : 'error'
      : done.exitCode === 0 && turns > 0
        ? 'success'
        : 'crashed';
  const notes: Partial<Record<RunOutcome, string>> = {
    limit_time: '時間の上限で止めました',
    transient: '混雑か通信の問題で止まりました',
    error: 'エージェントがエラーで止まりました',
    crashed: '結果を返さずに終わりました',
  };
  return {
    outcome,
    sessionId,
    costUsd: null,
    turns: turns > 0 ? turns : null,
    exitCode: done.exitCode,
    permissionDenied: false,
    note: notes[outcome] ?? null,
  };
}

export class ClaudeCodeAdapter implements AgentAdapter {
  readonly agent = 'claude_code' as const;
  readonly label = 'Claude Code';
  readonly runnable = true;
  readonly reportsCost = true;

  constructor(private readonly options: { bin?: string; model?: string } = {}) {}

  #bin(): string {
    return this.options.bin ?? 'claude';
  }

  available(): Promise<boolean> {
    return responds(this.#bin());
  }

  async run(request: AgentRunRequest): Promise<AgentRunResult> {
    const args = [
      '-p',
      request.prompt,
      '--output-format',
      'json',
      '--max-turns',
      String(request.maxTurns),
      '--max-budget-usd',
      request.maxCostUsd.toFixed(2),
      // 既定の問い方のまま。許可の問いは hooks が LINE へ出す（Genie が勝手に広げない）
      '--permission-mode',
      'default',
      ...(request.resumeSessionId
        ? ['--resume', request.resumeSessionId]
        : ['--session-id', request.sessionId]),
      ...(this.options.model ? ['--model', this.options.model] : []),
    ];
    return parseClaudeResult(
      await runProcess(this.#bin(), args, {
        cwd: request.cwd,
        clock: request.clock,
        ...(request.signal ? { signal: request.signal } : {}),
      }),
    );
  }

  /**
   * 読むだけのレビュー。使える道具を読む・探す・git の差分に絞り、それ以外は聞かずに断る
   * （dontAsk + 問いを出さない）。書く道具は道具の一覧から外す。本人の LINE に問いは出ない。
   */
  async review(request: AgentReviewRequest): Promise<AgentReviewResult> {
    const args = reviewArgs(request, this.options.model);
    return parseClaudeReview(
      await runProcess(this.#bin(), args, {
        cwd: request.cwd,
        clock: request.clock,
        ...(request.signal ? { signal: request.signal } : {}),
      }),
    );
  }
}

/** Claude Code のレビューの起動引数（検査で中身を見る）。 */
export function reviewArgs(request: AgentReviewRequest, model?: string): string[] {
  return [
    '-p',
    request.prompt,
    '--output-format',
    'json',
    '--max-turns',
    String(request.maxTurns),
    '--max-budget-usd',
    request.maxCostUsd.toFixed(2),
    '--tools',
    'Read',
    'Grep',
    'Glob',
    'Bash',
    '--allowedTools',
    'Read',
    'Grep',
    'Glob',
    ...REVIEW_BASH,
    '--disallowedTools',
    'Edit',
    'Write',
    'NotebookEdit',
    '--permission-mode',
    'dontAsk',
    '--permission-prompts',
    'none',
    // 本人の設定（許可の一覧・hooks）は読まない。広い許可でレビューが書き換えないように
    '--setting-sources',
    'project',
    '--no-session-persistence',
    ...(model ? ['--model', model] : []),
  ];
}

export class CodexAdapter implements AgentAdapter {
  readonly agent = 'codex' as const;
  readonly label = 'Codex';
  readonly runnable = true;
  readonly reportsCost = false;

  constructor(private readonly options: { bin?: string } = {}) {}

  #bin(): string {
    return this.options.bin ?? 'codex';
  }

  available(): Promise<boolean> {
    return responds(this.#bin());
  }

  async run(request: AgentRunRequest): Promise<AgentRunResult> {
    const args = [
      'exec',
      ...(request.resumeSessionId ? ['resume', request.resumeSessionId] : []),
      '--json',
      // 書けるのはプロジェクトの中だけ（Codex の exec は途中で本人に聞けないので、囲いで守る）
      '--sandbox',
      'workspace-write',
      request.prompt,
    ];
    return parseCodexResult(
      await runProcess(this.#bin(), args, {
        cwd: request.cwd,
        clock: request.clock,
        ...(request.signal ? { signal: request.signal } : {}),
      }),
    );
  }

  /** 読むだけのレビュー（`--sandbox read-only`）。**実機では未確認**（この Mac に codex が無い）。 */
  async review(request: AgentReviewRequest): Promise<AgentReviewResult> {
    const args = ['exec', '--json', '--sandbox', 'read-only', request.prompt];
    return parseCodexReview(
      await runProcess(this.#bin(), args, {
        cwd: request.cwd,
        clock: request.clock,
        ...(request.signal ? { signal: request.signal } : {}),
      }),
    );
  }
}

export const ADAPTER_LABELS: Record<AgentKind, string> = {
  claude_code: 'Claude Code',
  codex: 'Codex',
  opencode: 'OpenCode',
  browser: 'ブラウザ担当',
};
