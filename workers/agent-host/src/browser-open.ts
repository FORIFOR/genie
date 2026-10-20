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
  /** ページを読む（公式の確かめ）。既定は fetch。 */
  readonly fetchPage?: (url: string, signal?: AbortSignal) => Promise<FetchedPage | null>;
}

export interface FetchedPage {
  readonly finalUrl: string;
  readonly status: number;
  readonly html: string;
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

/** 開かなかった（見つからない・開けない）結果。失敗ではなく結果として ok で返す。 */
const notOpened = (
  subject: string,
  problem: string,
  extra: Partial<BrowserOpenResult> = {},
): StepOutcome => ({
  ok: true,
  result: { subject, url: null, title: '', opened: false, reason: '', problem, ...extra },
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
    const browser: BrowserChoice = parsed.data.browser ?? 'default';
    const subject = parsed.data.subject;
    // 「オークリーのサングラス」のように商品まで含んだ名前では、公式サイトと確かめられなかった
    // （genie.log 2026-10-18 16:43Z）。「の」の前の名前（オークリー）でも**同時に**探し、名前全体で見つかれば
    // そちらを開く（「鬼滅の刃」は名前全体で見つかるので変わらない）。前は名前全体で見つからなかったときに
    // 探し直していて、検索と見極めが 2 周になり、開くまで 55 秒かかった（genie.log 2026-10-19 18:32Z）。
    const brand = brandOf(subject);
    const [whole, short] = await Promise.all([
      this.#find(subject, signal),
      brand ? this.#find(brand, signal) : Promise.resolve(null),
    ]);
    if ('chosen' in whole) return this.#show(subject, whole, browser, signal);
    if (brand && short && 'chosen' in short) return this.#show(brand, short, browser, signal);
    return whole.outcome;
  }

  /** 探して公式を見極める（開かない）。見つからなければ、そのまま返す結果。 */
  async #find(
    subject: string,
    signal?: AbortSignal,
  ): Promise<{ chosen: Candidate; reason: string } | { outcome: StepOutcome }> {
    let candidates: Candidate[];
    try {
      candidates = candidatesOf(
        await this.#deps.ask(
          'search.web',
          {
            query: `${subject} 公式サイト`,
            queries: [subject, `${subject} 公式サイト`, `${subject} official site`],
            limit: 8,
            purpose: 'official',
          },
          signal,
        ),
      );
    } catch (error) {
      return {
        outcome: fail(
          'search_failed',
          `「${subject}」を検索できませんでした${reason(error)}。検索できるモデル（Codex または Claude Code）が必要です。`,
        ),
      };
    }
    // 検索結果が無くても、下の「確かめた既知のアドレス」は試す。
    let pick: { index: number; reason: string } = { index: -1, reason: '' };
    if (candidates.length > 0)
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
        return {
          outcome: fail('pick_failed', `公式サイトを見極められませんでした${reason(error)}。`),
        };
      }
    if (pick.index >= 0) return { chosen: candidates[pick.index]!, reason: pick.reason };
    /*
     * 検索の索引に公式サイトが無いことがある（実測 2026-10-06: Claude Code の WebSearch は
     * 「マクドナルド」「マクドナルド 公式サイト」「McDonald's Japan」のどれでも mcdonalds.co.jp を返さない）。
     * そのときだけ、モデルが知っているアドレスを聞き、**端末がそのページを読んで確かめたら**開く:
     * https・同じサイトのまま表示され・題名かサイト名に「〇〇」が入っている。確かめられなければ開かない。
     */
    const known = await this.#knownOfficial(subject, signal);
    if (known) return { chosen: known, reason: known.snippet };
    // 見つからないのは失敗ではなく結果。理由を秘書の言葉で返せるよう ok で返す。
    return {
      outcome: notOpened(
        subject,
        candidates.length === 0
          ? `「${subject}」の公式サイトを検索で見つけられませんでした。`
          : `検索結果の中に「${subject}」の公式サイトと確かめられるページがありませんでした。`,
      ),
    };
  }

  /** 見極めた公式サイトを開き、前面に出たかを確かめる。 */
  async #show(
    subject: string,
    found: { chosen: Candidate; reason: string },
    browser: BrowserChoice,
    signal?: AbortSignal,
  ): Promise<StepOutcome> {
    const { chosen } = found;
    const result: BrowserOpenResult = {
      subject,
      url: chosen.url,
      title: chosen.title.slice(0, 300),
      opened: false,
      reason: found.reason.slice(0, 400),
      browser,
    };
    try {
      signal?.throwIfAborted();
      await (this.#deps.open ?? openInBrowser)(chosen.url, browser, signal);
    } catch {
      return notOpened(subject, '公式サイトは見つかりましたが、ブラウザで開けませんでした。', {
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

  async #knownOfficial(subject: string, signal?: AbortSignal): Promise<Candidate | null> {
    let url: string;
    try {
      const raw = (await this.#deps.ask('llm.official_guess', { subject }, signal)) as {
        url?: unknown;
      } | null;
      if (typeof raw?.url !== 'string') return null;
      url = new URL(raw.url).href;
    } catch {
      return null;
    }
    if (!url.startsWith('https://')) return null;
    const page = await (this.#deps.fetchPage ?? fetchPage)(url, signal).catch(() => null);
    if (!page || page.status !== 200 || !sameSite(page.finalUrl, url)) return null;
    const title = pageTitle(page.html);
    if (!title || !mentions(title, subject)) return null;
    return {
      url,
      title,
      snippet: `検索結果には出ませんでしたが、${new URL(url).hostname} を開いて題名「${title.slice(0, 80)}」を確かめました`,
    };
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

/** ページを読む（最大 512KB・8 秒・転送を追う）。 */
export async function fetchPage(url: string, signal?: AbortSignal): Promise<FetchedPage | null> {
  const timeout = AbortSignal.timeout(8_000);
  const response = await fetch(url, {
    redirect: 'follow',
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    headers: { 'user-agent': 'Mozilla/5.0 (Macintosh) Genie', 'accept-language': 'ja,en;q=0.5' },
  });
  const reader = response.body?.getReader();
  let html = '';
  if (reader) {
    const decoder = new TextDecoder();
    while (html.length < 512 * 1024) {
      const { done, value } = await reader.read();
      if (done) break;
      html += decoder.decode(value, { stream: true });
    }
    await reader.cancel().catch(() => {});
  }
  return { finalUrl: response.url || url, status: response.status, html };
}

/** 題名とサイト名（og:site_name）。 */
export function pageTitle(html: string): string {
  const title = /<title[^>]*>([^<]{1,300})<\/title>/i.exec(html)?.[1] ?? '';
  const site =
    /<meta[^>]+property=["']og:site_name["'][^>]+content=["']([^"']{1,200})["']/i.exec(html)?.[1] ??
    '';
  return [title, site]
    .map((t) => t.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join(' / ');
}

/** 「〇〇の△△」の〇〇。「の」が無い・短すぎるときは null。 */
export function brandOf(subject: string): string | null {
  const head = subject.split('の')[0]!.trim();
  return head.length >= 2 && head !== subject.trim() ? head : null;
}

/** 題名に名前が入っているか（全角半角・大文字小文字・空白を無視）。 */
export function mentions(title: string, subject: string): boolean {
  const norm = (t: string) =>
    t
      .normalize('NFKC')
      .toLowerCase()
      .replace(/[\s・'’]/g, '');
  return norm(subject).length > 0 && norm(title).includes(norm(subject));
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
