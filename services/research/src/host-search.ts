/**
 * 検索を、端末で引く。正本 §8・§21、UI/UX §22。
 *
 * **契約を要らなくするため**ではなく、**選ばせないため**でもない。
 * 利用者が既に持っている利用権（Claude Code）で引けるなら、
 * 新しい会社へ問い合わせ内容を渡さずに済む。
 *
 * ここが守ること:
 *   - **実在しない URL を通さない。**辿れない出典は根拠ではない
 *   - 引けなかったことを、見つからなかったことにしない
 */
import type { HostCall, HostModelContext } from './host-model.js';
import type { SearchHit, SearchProvider } from './providers.js';
import { classify, SearchError, toIsoDate } from './search.js';
import { canonicalSha256 } from '@genie/contracts';

export interface HostSearchDeps {
  readonly host: HostCall;
  readonly context: () => HostModelContext | null;
}

export class HostSearchProvider implements SearchProvider {
  readonly name = 'device (web search)';
  /** 代役ではない。**本物の検索を、端末で引いている。** */
  readonly isStandIn = false;

  readonly #deps: HostSearchDeps;

  constructor(deps: HostSearchDeps) {
    this.#deps = deps;
  }

  async search(query: string, limit: number): Promise<SearchHit[]> {
    const context = this.#deps.context();
    if (context === null) {
      // 仕事の外から呼ばれた。代役で答えない。
      throw new SearchError('not_configured', 'a search needs a task to belong to');
    }

    const { result } = await this.#deps.host.execute(
      { taskId: context.taskId, tenantId: context.tenantId, userId: context.userId },
      {
        index: context.stepIndex,
        toolId: 'search.web',
        args: { query, limit },
        requestKey: await canonicalSha256({ toolId: 'search.web', query, limit }),
      },
    );

    const raw = Array.isArray((result as { results?: unknown })?.results)
      ? (result as { results: unknown[] }).results
      : [];

    const seen = new Set<string>();
    const hits: SearchHit[] = [];
    for (const item of raw) {
      const row = item as Record<string, unknown>;
      const url = typeof row['url'] === 'string' ? row['url'] : '';
      /*
       * **辿れない出典は載せない。**形の壊れた URL や、
       * 同じページの重複を、件数として数えない。
       */
      // 抜粋の無い結果からは根拠を取り出せない。数に入れず、取り出しの呼び出しも作らない。
      const snippet = typeof row['snippet'] === 'string' ? row['snippet'].trim() : '';
      if (!isHttpUrl(url) || seen.has(url) || snippet.length === 0) continue;
      seen.add(url);

      hits.push({
        url,
        title: typeof row['title'] === 'string' ? row['title'] : '',
        snippet,
        publisher: hostOf(url),
        publishedAt: toIsoDate(row['published']),
        sourceType: classify(url),
      });
      if (hits.length >= limit) break;
    }
    return hits;
  }
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\d*\./, '');
  } catch {
    return null;
  }
}
