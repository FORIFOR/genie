/**
 * 端末で引く検索。正本 §8・§21。
 *
 * 見るのは:
 *   - **辿れない出典を通さない**
 *   - 引けなかったことを、見つからなかったことにしない
 */
import { describe, expect, it } from 'vitest';
import { HostSearchProvider } from '../src/host-search.js';
import type { HostCall } from '../src/host-model.js';

const CONTEXT = {
  taskId: '01a00000-0000-7000-8000-000000000001',
  tenantId: '01a00000-0000-7000-8000-000000000002',
  userId: '01a00000-0000-7000-8000-000000000003',
  stepIndex: 0,
};

const hostReturning = (result: unknown): { host: HostCall; asks: unknown[] } => {
  const asks: unknown[] = [];
  return {
    asks,
    host: {
      async execute(_input, step) {
        asks.push(step);
        return { result };
      },
    },
  };
};

const provider = (host: HostCall, context = CONTEXT): HostSearchProvider =>
  new HostSearchProvider({ host, context: () => context });

describe('searching from the device', () => {
  it('is not a stand-in, because it really searches', () => {
    expect(provider(hostReturning({}).host).isStandIn).toBe(false);
  });

  it('turns results into the shape everything downstream expects', async () => {
    const { host } = hostReturning({
      results: [
        {
          url: 'https://www.reuters.com/a',
          title: 'A社の決算',
          snippet: '売上は 1,204 億円。',
          published: '2026-05-14',
        },
      ],
    });
    expect(await provider(host).search('A社 決算', 5)).toEqual([
      {
        url: 'https://www.reuters.com/a',
        title: 'A社の決算',
        snippet: '売上は 1,204 億円。',
        publisher: 'reuters.com',
        publishedAt: '2026-05-14T00:00:00.000Z',
        sourceType: 'news',
      },
    ]);
  });

  it('throws away a url that nobody could follow', async () => {
    // 辿れない出典は根拠ではない。件数として数えると「4 sources」が嘘になる。
    const { host } = hostReturning({
      results: [
        { url: 'https://example.com/real', title: 'ok', snippet: '本文' },
        { url: 'not a url', title: 'made up', snippet: '本文' },
        { url: 'javascript:alert(1)', title: 'no' },
        { url: '', title: 'empty' },
        { title: 'missing' },
      ],
    });
    const hits = await provider(host).search('q', 10);
    expect(hits.map((h) => h.url)).toEqual(['https://example.com/real']);
  });

  it('counts one page once', async () => {
    const { host } = hostReturning({
      results: [
        { url: 'https://example.com/a', title: '1', snippet: '本文' },
        { url: 'https://example.com/a', title: '2', snippet: '本文' },
      ],
    });
    expect(await provider(host).search('q', 10)).toHaveLength(1);
  });

  it('never returns more than was asked for', async () => {
    const { host } = hostReturning({
      results: Array.from({ length: 20 }, (_, i) => ({
        url: `https://example.com/${String(i)}`,
        snippet: '本文',
      })),
    });
    expect(await provider(host).search('q', 3)).toHaveLength(3);
  });

  it('returns nothing when the shape is wrong, rather than guessing', async () => {
    const { host } = hostReturning({ answer: '見つかりませんでした' });
    expect(await provider(host).search('q', 5)).toEqual([]);
  });

  it('will not search outside a task', async () => {
    const { host, asks } = hostReturning({ results: [] });
    await expect(provider(host, null as never).search('q', 5)).rejects.toMatchObject({
      reason: 'not_configured',
    });
    expect(asks).toEqual([]);
  });

  it('lets the device being away surface as it is', async () => {
    const failing: HostCall = {
      async execute() {
        throw Object.assign(new Error('端末が応答していません。'), { name: 'HostOffline' });
      },
    };
    // 引けなかったことを「見つからなかった」にしない
    await expect(provider(failing).search('q', 5)).rejects.toMatchObject({ name: 'HostOffline' });
  });

  it('does not count a result with no excerpt, since nothing can be quoted from it', async () => {
    const { host } = hostReturning({
      results: [
        { url: 'https://example.com/empty', title: 'empty', snippet: '' },
        { url: 'https://example.com/blank', title: 'blank', snippet: '   ' },
        { url: 'https://example.com/full', title: 'full', snippet: '出走予定は 12 頭。' },
      ],
    });
    const hits = await provider(host).search('出走予定', 5);
    expect(hits.map((hit) => hit.url)).toEqual(['https://example.com/full']);
  });
});
