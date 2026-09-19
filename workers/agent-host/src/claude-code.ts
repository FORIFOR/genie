/**
 * この端末の Claude Code を呼ぶ。正本 §21、UI/UX §22。
 *
 * **ログインの中身を読まない。**Claude Code は自分で資格情報を持っている。
 * Genie はそれを抜き出さず、写さず、API へ流用しない。
 * 使うのは CLI そのもので、実行の境界を Claude Code 側に置く。
 *
 * これは遠慮ではなく、線引きの問題:
 * 利用者が Claude Code に同意したのは「Claude Code が使う」ことであって、
 * 「別のプログラムがその鍵で好きに呼ぶ」ことではない。
 */
import { execFile } from 'node:child_process';

/** 呼べなかった理由。**種類で扱う。** */
export const CLAUDE_CODE_FAILURES = [
  'not_installed',
  'not_signed_in',
  'rate_limited',
  'crashed',
  'timed_out',
  'unreadable_output',
] as const;
export type ClaudeCodeFailure = (typeof CLAUDE_CODE_FAILURES)[number];

/** 何をすれば直るか。画面にそのまま出す。 */
export const CLAUDE_CODE_RECOVERY: Readonly<Record<ClaudeCodeFailure, string>> = {
  not_installed: 'この端末に Claude Code が見つかりません。',
  not_signed_in: 'Claude Code にサインインしてください。',
  rate_limited: 'Claude の利用上限に達しました。しばらく待ってから試してください。',
  crashed: 'Claude Code が応答しませんでした。',
  timed_out: 'Claude Code が時間内に返しませんでした。',
  unreadable_output: 'Claude Code の返事を読み取れませんでした。',
};

export class ClaudeCodeError extends Error {
  readonly reason: ClaudeCodeFailure;
  constructor(reason: ClaudeCodeFailure, message?: string) {
    super(message ?? CLAUDE_CODE_RECOVERY[reason]);
    this.name = 'ClaudeCodeError';
    this.reason = reason;
  }
}

export interface RunResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** 外のプロセスを走らせるもの。試験は偽物を渡す。 */
export type RunCommand = (
  command: string,
  args: readonly string[],
  options: { input?: string; timeoutMs: number; signal?: AbortSignal },
) => Promise<RunResult>;

export const runCommand: RunCommand = (command, args, options) =>
  new Promise((resolve) => {
    const child = execFile(
      command,
      [...args],
      {
        timeout: options.timeoutMs,
        maxBuffer: 32 * 1024 * 1024,
        ...(options.signal ? { signal: options.signal } : {}),
      },
      (error, stdout, stderr) => {
        resolve({
          code: error ? (error.killed ? 124 : typeof error.code === 'number' ? error.code : 1) : 0,
          stdout,
          stderr,
          // ENOENT は code に文字列が入る。呼び出し側で見分けられるよう stderr に残す
          ...((error as { code?: unknown } | null)?.code === 'ENOENT'
            ? { code: null, stderr: 'ENOENT' }
            : {}),
        });
      },
    );
    if (options.input !== undefined) {
      child.stdin?.end(options.input);
    }
  });

export interface ClaudeCodeConfig {
  /** 実行ファイル。PATH に無ければフルパスを渡す。 */
  readonly command?: string;
  readonly model?: string;
  readonly timeoutMs?: number;
  readonly run?: RunCommand;
}

const DEFAULT_TIMEOUT_MS = 120_000;

/**
 * 出力から失敗の種類を読む。
 *
 * **文面に頼りすぎない。**版が変われば文言は変わる。
 * だから、確度の高い手掛かり（終了コード、ENOENT）を先に見て、
 * 文面は最後の手掛かりとして使う。読めなければ `crashed` に倒す
 * — **「たぶん上限」で握り潰すより、分からないと言うほうがよい。**
 */
export function failureFrom(result: RunResult): ClaudeCodeFailure | null {
  if (result.code === 0) return null;
  if (result.code === 124) return 'timed_out';
  if (result.code === null || /ENOENT|command not found/i.test(result.stderr)) {
    return 'not_installed';
  }

  const text = `${result.stderr}\n${result.stdout}`;
  if (/rate.?limit|too many requests|429|usage limit/i.test(text)) return 'rate_limited';
  if (/not logged in|please (run )?\/?login|unauthori[sz]ed|401|authentication/i.test(text)) {
    return 'not_signed_in';
  }
  return 'crashed';
}

export class ClaudeCodeCli {
  readonly #config: ClaudeCodeConfig;
  readonly #run: RunCommand;

  constructor(config: ClaudeCodeConfig = {}) {
    this.#config = config;
    this.#run = config.run ?? runCommand;
  }

  get command(): string {
    return this.#config.command ?? 'claude';
  }

  /**
   * この端末で使えるか。
   *
   * **使えないことを、使えるふりにしない。**起動時にここで確かめて、
   * 使えないなら「Claude Code が見つかりません」と言う。
   */
  async probe(): Promise<{ available: boolean; version: string | null; reason: string | null }> {
    const result = await this.#run(this.command, ['--version'], { timeoutMs: 10_000 });
    const failure = failureFrom(result);
    if (failure) {
      return { available: false, version: null, reason: CLAUDE_CODE_RECOVERY[failure] };
    }
    return { available: true, version: result.stdout.trim() || null, reason: null };
  }

  /**
   * 問いを投げて、JSON を受け取る。
   *
   * `--output-format json` を使うのは、囲みの外に説明文が混ざっても
   * 拾えるようにするため。**読めない返事を、空の答えとして通さない。**
   */
  async ask(
    prompt: string,
    options: { signal?: AbortSignal; allowedTools?: readonly string[] } = {},
  ): Promise<unknown> {
    if (options.signal?.aborted) {
      throw new ClaudeCodeError('timed_out', '始まる前に取り消されました。');
    }

    const args = ['-p', '--output-format', 'json'];
    if (this.#config.model) args.push('--model', this.#config.model);
    /*
     * 使ってよい道具を**名指しで渡す。**渡さなければ何も使えない。
     * 「全部許す」を既定にすると、問いに答えるだけのつもりの呼び出しが
     * 端末のファイルを読み書きできることになる。
     */
    if (options.allowedTools?.length) {
      args.push('--allowedTools', options.allowedTools.join(','));
    }

    const result = await this.#run(this.command, args, {
      input: prompt,
      timeoutMs: this.#config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      ...(options.signal ? { signal: options.signal } : {}),
    });

    const failure = failureFrom(result);
    if (failure) throw new ClaudeCodeError(failure);

    return parseReply(result.stdout);
  }
}

/**
 * 返事から中身を取り出す。
 *
 * CLI は `{ type, result, ... }` の封筒で返し、`result` は文字列。
 * その中に JSON が入っている（囲みつきのこともある）。
 * **どの層でも、読めなければ読めないと言う。**
 */
export function parseReply(stdout: string): unknown {
  let envelope: unknown;
  try {
    envelope = JSON.parse(stdout);
  } catch {
    throw new ClaudeCodeError('unreadable_output');
  }

  const inner = (envelope as { result?: unknown })?.result;
  if (typeof inner !== 'string') {
    // 封筒の形が変わった。中身を推測しない。
    throw new ClaudeCodeError('unreadable_output');
  }

  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(inner);
  const body = (fenced?.[1] ?? inner).trim();
  try {
    return JSON.parse(body);
  } catch {
    /*
     * 全体としては読めない。**先頭の JSON だけ拾う。**
     *
     * web を引かせると、Claude Code は答えのあとに
     * 「Sources: [example.com](https://…)」を足す。これは CLI の親切で、
     * 消せない。全体を捨てると、正しく引けた検索結果まで捨てることになる。
     *
     * ただし**拾えるのは先頭にある本物の JSON だけ**で、
     * 散文しか無ければ下で失敗する（散文を答えにしない）。
     */
    const leading = leadingJsonObject(body);
    if (leading !== null) {
      try {
        return JSON.parse(leading);
      } catch {
        throw new ClaudeCodeError('unreadable_output');
      }
    }
    throw new ClaudeCodeError('unreadable_output');
  }
}

/**
 * 先頭の `{ … }` を、対応が取れるところまで切り出す。
 *
 * 文字列の中の `{` `}` を数えないよう、引用符と逃がし文字を見る。
 * **見つからなければ null。**あてずっぽうに切らない。
 */
export function leadingJsonObject(text: string): string | null {
  const start = text.indexOf('{');
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i += 1) {
    const ch = text[i]!;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\' && inString) {
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === '{') depth += 1;
    if (ch === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  // 閉じていない。途中で切れたものを、完全な答えとして扱わない。
  return null;
}
