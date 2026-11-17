/**
 * `browser.read_page`: 「<URL> を読んで要約して」に、Genie 専用のブラウザでページを読み、端末のモデルで答える。
 *
 * 専用のブラウザ:
 *   - 本人の Chrome とは別のプロファイル（~/Library/Application Support/Genie/browser-profile）。画面に出さない
 *   - この Mac に入っているものを使う（Playwright が入れた画面なしの Chromium → Google Chrome の順）。新しく入れない
 *   - 動かすのは DevTools の口（Node の WebSocket）。外の部品は使わない
 *
 * 守ること:
 *   - **読むだけ。**押す・入力する・ログインする・ダウンロードすることはしない。ダイアログは閉じる
 *   - 開くのは公開の http / https だけ。ページの中から読みに行く先も、Mac の中・家の中のアドレスは止める
 *   - モデルに渡すのは取り出した本文だけ（道具は渡さない）。答えのリンクは外す（ページに操らせない）
 */
import { BrowserReadArgs, isPublicWebUrl, type BrowserReadResult } from '@genie/contracts';
import { BrowserSession, type PageText, type SessionOptions } from './browser-session.js';
import {
  handOff,
  type HandoffApi,
  type HandoffEnd,
  type HandoffSession,
} from './browser-handoff.js';
import type { HostStep, StepOutcome } from './connector-steps.js';
import type { BrowserAsk } from './browser-open.js';

export type { PageText } from './browser-session.js';
export { browserExecutable, PROFILE_DIR } from './browser-session.js';

export type ReadPage = (url: string, signal?: AbortSignal) => Promise<PageText>;

/** 読むのと引き継ぎで使うブラウザ（BrowserSession のうち、ここで使うものだけ）。 */
export interface ReadingSession extends HandoffSession {
  goto(url: string, signal: AbortSignal): Promise<void>;
  extract(): Promise<PageText>;
  close(): Promise<void>;
  /** 隠すところを隠した 1 枚（隠せなければ null。無ければ画面は送らない）。 */
  maskedScreenshot?(): Promise<{ jpeg: Buffer; masked: number } | null>;
}

/**
 * いまの画面を、隠してから gateway に置く（LINE の「画面を見せて」）。隠せない・置けないときは何もしない
 * （読むのは止めない）。
 */
async function snapshot(
  session: ReadingSession,
  api: HandoffApi,
  requestId: string,
  page: PageText,
  stage: 'opened' | 'login' | 'read',
): Promise<void> {
  if (!api.snapshot || !session.maskedScreenshot) return;
  try {
    const shot = await session.maskedScreenshot();
    if (!shot) return;
    await api.snapshot(requestId, {
      jpeg: shot.jpeg.toString('base64'),
      site: new URL(page.finalUrl).hostname,
      title: page.title.slice(0, 120),
      stage,
      masked: shot.masked,
    });
  } catch {
    /* 画面を置けなくても、読むのは続ける */
  }
}

export interface BrowserReadDeps {
  readonly ask: BrowserAsk;
  /** ページを読む。既定は専用のブラウザ（readWithBrowser）。引き継ぎがあるときは使わない。 */
  readonly readPage?: ReadPage;
  /**
   * ログインの壁に当たったら、本人に引き継ぐ（LINE で画面を見て操作してもらい、済んだら続きを読む）。
   * 無ければ、これまでどおり「ログインが要るページかもしれません」と返す。
   */
  readonly handoff?: {
    readonly api: HandoffApi;
    /** 引き継げるブラウザを開く（既定は Genie 専用のブラウザ）。 */
    readonly open?: (signal: AbortSignal) => Promise<ReadingSession>;
    /** 本人を待つ長さ（既定 3 分。step の上限 5 分の中で、続きを読んで答える時間を残す）。 */
    readonly limitMs?: number;
  };
}

const HANDOFF_PROBLEM: Record<Exclude<HandoffEnd, 'resumed'>, string> = {
  timed_out:
    'ログインを待つ時間が切れました。ログインが済んでいれば Genie のブラウザに残っているので、もう一度頼んでください。',
  cancelled: 'ログインのお願いをやめました。',
  failed: 'ログインのあいだに Genie のブラウザが止まりました。もう一度頼んでください。',
};

/** モデルに渡す本文の長さ。 */
const MAX_TEXT = 12_000;
/** 本文とみなす最小の長さ（これより短いと、ログインの壁・画像だけのページとみなす）。 */
const MIN_TEXT = 40;

const fail = (code: string, message: string): StepOutcome => ({
  ok: false,
  error: { code: `browser.${code}`, message },
});

/** 読めなかった（公開でない・開けない・本文が無い）。失敗ではなく結果として ok で返す。 */
const notRead = (url: string, problem: string, extra: Partial<BrowserReadResult> = {}) => ({
  ok: true as const,
  result: {
    url,
    finalUrl: null,
    title: '',
    read: false,
    chars: 0,
    answer: null,
    problem,
    ...extra,
  } satisfies BrowserReadResult,
});

export class BrowserReadRuntime {
  readonly #deps: BrowserReadDeps;
  constructor(deps: BrowserReadDeps) {
    this.#deps = deps;
  }

  handles(toolId: string): boolean {
    return toolId === 'browser.read_page';
  }

  #readOrHandOff(url: string, requestId: string, signal?: AbortSignal) {
    return readOrHandOff(this.#deps.handoff!, url, requestId, signal);
  }

  async run(step: HostStep, signal?: AbortSignal): Promise<StepOutcome> {
    const parsed = BrowserReadArgs.safeParse(step.args);
    if (!parsed.success)
      return fail('invalid_args', '読むページのアドレスを確認できませんでした。');
    const { url, question } = parsed.data;
    if (!isPublicWebUrl(url))
      return notRead(
        url,
        'Mac の中や家の中のアドレスは開きません。公開のページのアドレスを送ってください。',
      );
    let page: PageText;
    try {
      const read = this.#deps.handoff
        ? await this.#readOrHandOff(url, step.id, signal)
        : await (this.#deps.readPage ?? readWithBrowser)(url, signal);
      if ('problem' in read) return notRead(url, read.problem);
      page = read;
    } catch (error) {
      signal?.throwIfAborted();
      return notRead(url, problemOf(error));
    }
    const title = page.title.replace(/\s+/g, ' ').trim().slice(0, 300);
    if (!isPublicWebUrl(page.finalUrl))
      return notRead(url, '転送された先が公開のページではなかったので、読みませんでした。');
    const text = page.text
      .replace(/[ \t]+/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    if (text.length < MIN_TEXT)
      return notRead(
        url,
        'ページから本文を取り出せませんでした（ログインが要るページや、画像だけのページかもしれません）。',
        { finalUrl: page.finalUrl.slice(0, 2000), title },
      );
    let raw: unknown;
    try {
      raw = await this.#deps.ask(
        'llm.read_page',
        { question, title, url: page.finalUrl, text: text.slice(0, MAX_TEXT) },
        signal,
      );
    } catch (error) {
      return fail(
        'answer_failed',
        `ページは読めましたが、答えを作れませんでした${reason(error)}。`,
      );
    }
    const answer = withoutLinks(String((raw as { answer?: unknown } | null)?.answer ?? ''));
    if (!answer) return fail('answer_failed', 'ページは読めましたが、答えを作れませんでした。');
    return {
      ok: true,
      result: {
        url,
        finalUrl: page.finalUrl.slice(0, 2000),
        title,
        read: true,
        chars: text.length,
        answer: answer.slice(0, 4000),
      } satisfies BrowserReadResult,
    };
  }
}

/**
 * 読む。ログインの壁（パスワードの欄）なら本人に引き継ぎ、済んだら同じページを読み直す。
 * ブラウザは引き継ぎのあいだも閉じない（同じプロファイルは同時に 1 つ）。
 */
export async function readOrHandOff(
  handoff: NonNullable<BrowserReadDeps['handoff']>,
  url: string,
  requestId: string,
  signal: AbortSignal | undefined,
): Promise<PageText | { problem: string }> {
  return withProfile(async () => {
    const outer = signal ?? new AbortController().signal;
    // 開いて読むまでの上限（本人を待つ時間は別に数える）
    const loading = () => AbortSignal.any([outer, AbortSignal.timeout(45_000)]);
    const session = await (handoff.open ?? ((s) => BrowserSession.open({}, s)))(loading());
    try {
      await session.goto(url, loading());
      const first = await session.extract();
      const login = await session.hasPasswordField();
      // 画面を置く（ログインのお願いより先に。お願いにこの画面を添える）
      await snapshot(session, handoff.api, requestId, first, login ? 'login' : 'read');
      if (!login) return first;
      const site = new URL(first.finalUrl).hostname;
      const done = await handOff(session, handoff.api, {
        requestId,
        site,
        signal: outer,
        ...(handoff.limitMs ? { limitMs: handoff.limitMs } : {}),
      });
      if ('problem' in done) return done;
      if (done.end !== 'resumed') return { problem: HANDOFF_PROBLEM[done.end] };
      // ログインのあと、頼まれたページを読み直す（ログインのあとに別のページへ移っていることがある）
      await session.goto(url, loading());
      const after = await session.extract();
      await snapshot(session, handoff.api, requestId, after, 'read');
      return after;
    } finally {
      await session.close();
    }
  });
}

/** 答えからリンクと裸の URL を外す（ページの文がモデル越しにリンクを差し込まないように）。 */
export function withoutLinks(text: string): string {
  return text
    .replace(/!?\[([^\]]*)\]\((?:[^()]|\([^()]*\))*\)/g, '$1')
    .replace(/\b(?:https?|javascript|data):\/?\/?[^\s)）」』]+/giu, '')
    .replace(/[ \t]+\n/g, '\n')
    .trim();
}

function problemOf(error: unknown): string {
  const message = error instanceof Error ? error.message : '';
  if (message === 'no_browser')
    return 'Genie 専用のブラウザが見つかりませんでした（Playwright の Chromium か Google Chrome が要ります）。';
  if (message === 'timeout') return 'ページが時間内に読み込めませんでした。';
  if (message.startsWith('navigate:'))
    return 'ページを開けませんでした（アドレスか接続を確かめてください）。';
  return 'ページを開けませんでした。';
}

function reason(error: unknown): string {
  return error instanceof Error && error.message ? `（${error.message.slice(0, 120)}）` : '';
}

/** 同じプロファイルを同時に 2 つ開かない（1 つずつ読む。引き継ぎ中のブラウザもこの順に並ぶ）。 */
let queue: Promise<unknown> = Promise.resolve();

/** 順に使う（同じプロファイルのブラウザは同時に 1 つ）。 */
export function withProfile<T>(run: () => Promise<T>): Promise<T> {
  const next = queue.then(run, run);
  queue = next.catch(() => undefined);
  return next;
}

export interface ReadOptions extends SessionOptions {
  readonly timeoutMs?: number;
}

/** 専用のブラウザでページを開き、題名・表示されたアドレス・本文を取り出して閉じる。 */
export function readWithBrowser(
  url: string,
  signal?: AbortSignal,
  options: ReadOptions = {},
): Promise<PageText> {
  return withProfile(async () => {
    const deadline = AbortSignal.timeout(options.timeoutMs ?? 45_000);
    const stop = signal ? AbortSignal.any([signal, deadline]) : deadline;
    let session: BrowserSession | null = null;
    try {
      session = await BrowserSession.open(options, stop);
      await session.goto(url, stop);
      return await session.extract();
    } catch (error) {
      if (stop.aborted && !signal?.aborted) throw new Error('timeout');
      throw error;
    } finally {
      await session?.close();
    }
  });
}
