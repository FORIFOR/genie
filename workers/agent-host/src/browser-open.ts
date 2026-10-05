/**
 * `browser.open_official`: 「〇〇の公式サイトを開いて」に、検索 → 公式の見極め → 既定のブラウザで開く、で応える。
 *
 * 守ること:
 *   - 開くのは**検索結果に実際に出た URL だけ**。モデルに URL を書かせない
 *   - 通販・ニュース・百科事典・比較サイトを公式としない（選ぶのはモデル、候補の外は選べない）
 *   - http / https だけ。開くのは macOS の `open`（既定のブラウザ）。ページの中は操作しない
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { BrowserOpenArgs, type BrowserChoice, type BrowserOpenResult } from '@genie/contracts';
import type { HostStep, StepOutcome } from './connector-steps.js';

const exec = promisify(execFile);
export type BrowserAsk = (
  toolId: string,
  args: Record<string, unknown>,
  signal?: AbortSignal,
) => Promise<unknown>;

export interface BrowserOpenDeps {
  readonly ask: BrowserAsk;
  readonly open?: (url: string, browser: BrowserChoice, signal?: AbortSignal) => Promise<void>;
  /** 前面のタブの URL を読む（表示の確認）。読めなければ null。 */
  readonly frontUrl?: (browser: BrowserChoice) => Promise<string | null>;
  readonly sleep?: (ms: number) => Promise<void>;
}

interface Candidate {
  readonly url: string;
  readonly title: string;
  readonly snippet: string;
}

const fail = (code: string, message: string): StepOutcome => ({
  ok: false,
  error: { code: `browser.${code}`, message },
});

export class BrowserOpenRuntime {
  readonly #deps: BrowserOpenDeps;
  constructor(deps: BrowserOpenDeps) {
    this.#deps = deps;
  }

  handles(toolId: string): boolean {
    return toolId === 'browser.open_official';
  }

  async run(step: HostStep, signal?: AbortSignal): Promise<StepOutcome> {
    const parsed = BrowserOpenArgs.safeParse(step.args);
    if (!parsed.success) return fail('invalid_args', '開くサイトの名前を確認できませんでした。');
    const subject = parsed.data.subject;
    const browser: BrowserChoice = parsed.data.browser ?? 'default';

    let candidates: Candidate[];
    try {
      candidates = candidatesOf(
        await this.#deps.ask('search.web', { query: `${subject} 公式サイト`, limit: 6 }, signal),
      );
    } catch (error) {
      return fail(
        'search_failed',
        `「${subject}」を検索できませんでした${reason(error)}。検索できるモデル（Codex または Claude Code）が必要です。`,
      );
    }
    // 見つからないのは失敗ではなく結果。理由を秘書の言葉で返せるよう ok で返す。
    const notOpened = (problem: string, extra: Partial<BrowserOpenResult> = {}): StepOutcome => ({
      ok: true,
      result: { subject, url: null, title: '', opened: false, reason: '', problem, ...extra },
    });
    if (candidates.length === 0)
      return notOpened(`「${subject}」の公式サイトを検索で見つけられませんでした。`);

    let pick: { index: number; reason: string };
    try {
      pick = pickOf(
        await this.#deps.ask(
          'llm.pick_official',
          { subject, results: candidates.map((c, index) => ({ index, ...c })) },
          signal,
        ),
        candidates.length,
      );
    } catch (error) {
      return fail('pick_failed', `公式サイトを見極められませんでした${reason(error)}。`);
    }
    if (pick.index < 0)
      return notOpened(
        `検索結果の中に「${subject}」の公式サイトと確かめられるページがありませんでした。`,
      );

    const chosen = candidates[pick.index]!;
    const result: BrowserOpenResult = {
      subject,
      url: chosen.url,
      title: chosen.title.slice(0, 300),
      opened: false,
      reason: pick.reason.slice(0, 400),
      browser,
    };
    try {
      signal?.throwIfAborted();
      await (this.#deps.open ?? openInBrowser)(chosen.url, browser, signal);
    } catch {
      return notOpened('公式サイトは見つかりましたが、ブラウザで開けませんでした。', {
        url: chosen.url,
        title: result.title,
        reason: result.reason,
        browser,
      });
    }
    // 開く依頼が通っただけでは「表示した」と言わない。前面のタブがそのサイトになったかを読み取る。
    const shown = await this.#confirmShown(chosen.url, browser, signal);
    return { ok: true, result: { ...result, opened: true, ...shown } };
  }

  async #confirmShown(
    url: string,
    browser: BrowserChoice,
    signal?: AbortSignal,
  ): Promise<{ shown: boolean | null; shownUrl?: string }> {
    const read = this.#deps.frontUrl ?? readFrontUrl;
    const sleep = this.#deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
    let last: string | null = null;
    for (let i = 0; i < 16 && !signal?.aborted; i++) {
      await sleep(500);
      last = await read(browser).catch(() => null);
      if (last && sameSite(last, url)) return { shown: true, shownUrl: last.slice(0, 500) };
    }
    return last ? { shown: false, shownUrl: last.slice(0, 500) } : { shown: null };
  }
}

const APP: Record<Exclude<BrowserChoice, 'default'>, string> = {
  safari: 'Safari',
  chrome: 'Google Chrome',
};

export async function openInBrowser(
  url: string,
  browser: BrowserChoice,
  signal?: AbortSignal,
): Promise<void> {
  if (process.platform !== 'darwin') throw new Error('unsupported_platform');
  if (!/^https?:\/\//i.test(url)) throw new Error('unsupported_scheme');
  const args = browser === 'default' ? [url] : ['-a', APP[browser], url];
  await exec('/usr/bin/open', args, {
    ...(signal ? { signal } : {}),
    timeout: 10_000,
    maxBuffer: 4096,
  });
}

export function candidatesOf(raw: unknown): Candidate[] {
  const results = (raw as { results?: unknown } | null)?.results;
  if (!Array.isArray(results)) return [];
  const seen = new Set<string>();
  const out: Candidate[] = [];
  for (const item of results) {
    const row = item as Record<string, unknown>;
    const url = typeof row['url'] === 'string' ? row['url'].trim() : '';
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      continue;
    }
    if (!['http:', 'https:'].includes(parsed.protocol) || seen.has(parsed.href)) continue;
    seen.add(parsed.href);
    out.push({
      url: parsed.href,
      title: typeof row['title'] === 'string' ? row['title'].slice(0, 200) : '',
      snippet: typeof row['snippet'] === 'string' ? row['snippet'].slice(0, 300) : '',
    });
    if (out.length >= 6) break;
  }
  return out;
}

export function pickOf(raw: unknown, count: number): { index: number; reason: string } {
  const row = (raw ?? {}) as Record<string, unknown>;
  const index = row['index'];
  if (typeof index !== 'number' || !Number.isInteger(index) || index < -1 || index >= count)
    throw new Error('the choice was not one of the search results');
  return { index, reason: typeof row['reason'] === 'string' ? row['reason'] : '' };
}

function reason(error: unknown): string {
  return error instanceof Error && error.message ? `（${error.message.slice(0, 120)}）` : '';
}

/** 同じサイトか（ホスト名で比べる。www. の有無は同じとみなす）。 */
export function sameSite(shown: string, wanted: string): boolean {
  try {
    const host = (u: string) => new URL(u).hostname.replace(/^www\./, '').toLowerCase();
    const a = host(shown),
      b = host(wanted);
    return a === b || a.endsWith(`.${b}`) || b.endsWith(`.${a}`);
  } catch {
    return false;
  }
}

/**
 * ブラウザの前面のタブの URL を読む（AppleScript。読むのは URL だけ）。
 * 既定のブラウザのときは、動いている Safari → Chrome の順に見る。初回は macOS が「操作の許可」を聞く。
 */
export async function readFrontUrl(browser: BrowserChoice): Promise<string | null> {
  const scripts: Record<Exclude<BrowserChoice, 'default'>, string> = {
    safari:
      'if application "Safari" is running then tell application "Safari" to if (count of windows) > 0 then return URL of current tab of front window',
    chrome:
      'if application "Google Chrome" is running then tell application "Google Chrome" to if (count of windows) > 0 then return URL of active tab of front window',
  };
  const order: Exclude<BrowserChoice, 'default'>[] =
    browser === 'default' ? ['safari', 'chrome'] : [browser];
  for (const b of order) {
    try {
      const { stdout } = await exec('/usr/bin/osascript', ['-e', scripts[b]], {
        timeout: 4000,
        maxBuffer: 8192,
      });
      const url = stdout.trim();
      if (/^https?:\/\//i.test(url)) return url;
    } catch {
      /* 許可が無い・動いていない */
    }
  }
  return null;
}
