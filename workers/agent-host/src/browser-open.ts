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
import { BrowserOpenArgs, type BrowserOpenResult } from '@genie/contracts';
import type { HostStep, StepOutcome } from './connector-steps.js';

const exec = promisify(execFile);
export type BrowserAsk = (
  toolId: string,
  args: Record<string, unknown>,
  signal?: AbortSignal,
) => Promise<unknown>;

export interface BrowserOpenDeps {
  readonly ask: BrowserAsk;
  readonly open?: (url: string, signal?: AbortSignal) => Promise<void>;
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
    };
    try {
      signal?.throwIfAborted();
      await (this.#deps.open ?? openInDefaultBrowser)(chosen.url, signal);
    } catch {
      return notOpened('公式サイトは見つかりましたが、ブラウザで開けませんでした。', {
        url: chosen.url,
        title: result.title,
        reason: result.reason,
      });
    }
    return { ok: true, result: { ...result, opened: true } };
  }
}

export async function openInDefaultBrowser(url: string, signal?: AbortSignal): Promise<void> {
  if (process.platform !== 'darwin') throw new Error('unsupported_platform');
  if (!/^https?:\/\//i.test(url)) throw new Error('unsupported_scheme');
  await exec('/usr/bin/open', [url], {
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
