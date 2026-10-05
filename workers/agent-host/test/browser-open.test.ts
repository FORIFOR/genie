import { describe, expect, it } from 'vitest';
import { BrowserOpenRuntime, candidatesOf, pickOf, sameSite } from '../src/browser-open.js';

const step = (args: Record<string, unknown>) => ({
  id: 'b1',
  toolId: 'browser.open_official',
  args,
  approval: null,
});
const RESULTS = {
  results: [
    { url: 'https://ja.wikipedia.org/wiki/マクドナルド', title: 'Wikipedia', snippet: '百科事典' },
    { url: 'https://www.mcdonalds.co.jp/', title: '日本マクドナルド', snippet: '公式' },
  ],
};

function runtime(
  pick: unknown,
  opened: string[] = [],
  search: unknown = RESULTS,
  front?: string | null,
) {
  const asks: string[] = [];
  return {
    asks,
    opened,
    runtime: new BrowserOpenRuntime({
      ask: async (toolId) => {
        asks.push(toolId);
        return toolId === 'search.web' ? search : pick;
      },
      open: async (url, browser) => {
        opened.push(browser === 'default' ? url : `${browser}:${url}`);
      },
      // 前面のタブ: 指定が無ければ開いた URL（表示された）
      frontUrl: async () =>
        front === undefined ? (opened.at(-1)?.replace(/^(safari|chrome):/, '') ?? null) : front,
      sleep: async () => {},
    }),
  };
}

describe('opening the official site in the browser', () => {
  it('searches, picks one of the results, and opens exactly that url', async () => {
    const { runtime: r, asks, opened } = runtime({ index: 1, reason: '運営会社' });
    const outcome = await r.run(step({ subject: 'マクドナルド' }));
    expect(asks).toEqual(['search.web', 'llm.pick_official']);
    expect(opened).toEqual(['https://www.mcdonalds.co.jp/']);
    expect(outcome).toMatchObject({
      ok: true,
      result: { opened: true, url: 'https://www.mcdonalds.co.jp/' },
    });
  });

  it('never opens a page the model made up or that was not in the results', async () => {
    const { runtime: r, opened } = runtime({ index: 7, url: 'https://evil.example/' });
    expect(await r.run(step({ subject: 'マクドナルド' }))).toMatchObject({ ok: false });
    expect(opened).toEqual([]);
  });

  it('says so when no result is the official site, without opening anything', async () => {
    const { runtime: r, opened } = runtime({ index: -1 });
    expect(await r.run(step({ subject: 'マクドナルド' }))).toMatchObject({
      ok: true,
      result: { opened: false, url: null, problem: expect.stringContaining('公式サイト') },
    });
    expect(opened).toEqual([]);
  });

  it('drops non-web and duplicate links before the model sees them', () => {
    expect(
      candidatesOf({
        results: [
          { url: 'javascript:alert(1)' },
          { url: 'file:///etc/passwd' },
          { url: 'https://a.example/' },
          { url: 'https://a.example/' },
        ],
      }).map((c) => c.url),
    ).toEqual(['https://a.example/']);
    expect(() => pickOf({ index: 0.5 }, 2)).toThrow();
  });

  it('refuses an empty subject', async () => {
    const { runtime: r, asks } = runtime({ index: 0 });
    expect(await r.run(step({ subject: ' ' }))).toMatchObject({ ok: false });
    expect(asks).toEqual([]);
  });

  it('confirms the page is actually showing before saying so', async () => {
    const { runtime: r } = runtime({ index: 1, reason: '運営会社' });
    expect(await r.run(step({ subject: 'マクドナルド' }))).toMatchObject({
      ok: true,
      result: { opened: true, shown: true, shownUrl: 'https://www.mcdonalds.co.jp/' },
    });
  });

  it('does not claim it is showing when the front tab is another page or unreadable', async () => {
    const other = runtime({ index: 1 }, [], RESULTS, 'https://example.com/other');
    expect(await other.runtime.run(step({ subject: 'マクドナルド' }))).toMatchObject({
      result: { shown: false },
    });
    const unknown = runtime({ index: 1 }, [], RESULTS, null);
    expect(await unknown.runtime.run(step({ subject: 'マクドナルド' }))).toMatchObject({
      result: { shown: null },
    });
  });

  it('opens in the browser that was named', async () => {
    const { runtime: r, opened } = runtime({ index: 1 });
    await r.run(step({ subject: 'マクドナルド', browser: 'safari' }));
    expect(opened).toEqual(['safari:https://www.mcdonalds.co.jp/']);
  });

  it('treats www and subdomains as the same site', () => {
    expect(sameSite('https://mcdonalds.co.jp/menu', 'https://www.mcdonalds.co.jp/')).toBe(true);
    expect(sameSite('https://evil.example/', 'https://www.mcdonalds.co.jp/')).toBe(false);
  });
});
