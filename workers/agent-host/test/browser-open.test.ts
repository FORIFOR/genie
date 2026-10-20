import { describe, expect, it } from 'vitest';
import {
  BrowserOpenRuntime,
  candidatesOf,
  mentions,
  pageTitle,
  pickOf,
  sameSite,
  type FetchedPage,
} from '../src/browser-open.js';

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
  known: { guess?: unknown; page?: FetchedPage | null } = {},
) {
  const fetched: string[] = [];
  const asks: string[] = [];
  const searches: Record<string, unknown>[] = [];
  return {
    asks,
    searches,
    opened,
    runtime: new BrowserOpenRuntime({
      ask: async (toolId, args) => {
        asks.push(toolId);
        if (toolId === 'search.web') searches.push(args);
        return toolId === 'search.web'
          ? search
          : toolId === 'llm.official_guess'
            ? (known.guess ?? { url: null })
            : pick;
      },
      open: async (url, browser) => {
        opened.push(browser === 'default' ? url : `${browser}:${url}`);
      },
      // 前面のタブ: 指定が無ければ開いた URL（表示された）
      frontUrl: async () =>
        front === undefined ? (opened.at(-1)?.replace(/^(safari|chrome):/, '') ?? null) : front,
      sleep: async () => {},
      fetchPage: async (url) => {
        fetched.push(url);
        return known.page ?? null;
      },
    }),
    fetched,
  };
}

describe('opening the official site in the browser', () => {
  it('searches, picks one of the results, and opens exactly that url', async () => {
    const { runtime: r, asks, opened, searches } = runtime({ index: 1, reason: '運営会社' });
    const outcome = await r.run(step({ subject: 'マクドナルド' }));
    expect(asks).toEqual(['search.web', 'llm.pick_official']);
    // 公式探しの検索: 抜粋を必須にしない（写せない公式サイトが落ちないように）
    expect(searches).toEqual([
      {
        query: 'マクドナルド 公式サイト',
        queries: ['マクドナルド', 'マクドナルド 公式サイト', 'マクドナルド official site'],
        limit: 8,
        purpose: 'official',
      },
    ]);
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

  describe('when the search index has no official site', () => {
    const NEWS = { results: [{ url: 'https://www.cnn.co.jp/a', title: 'ニュース', snippet: '' }] };
    const page = (over: Partial<FetchedPage> = {}): FetchedPage => ({
      finalUrl: 'https://www.mcdonalds.co.jp/',
      status: 200,
      html: '<html><head><title>マクドナルド公式サイト | マクドナルド公式</title></head></html>',
      ...over,
    });

    it('opens a known address only after reading the page and finding the name in its title', async () => {
      const {
        runtime: r,
        opened,
        fetched,
      } = runtime({ index: -1 }, [], NEWS, undefined, {
        guess: { url: 'https://www.mcdonalds.co.jp/' },
        page: page(),
      });
      const outcome = await r.run(step({ subject: 'マクドナルド' }));
      expect(fetched).toEqual(['https://www.mcdonalds.co.jp/']);
      expect(opened).toEqual(['https://www.mcdonalds.co.jp/']);
      expect(outcome).toMatchObject({
        ok: true,
        result: {
          opened: true,
          shown: true,
          reason: expect.stringContaining('題名「マクドナルド公式サイト'),
        },
      });
    });

    it.each([
      ['an http address', { url: 'http://www.mcdonalds.co.jp/' }, page()],
      [
        'a page that redirects elsewhere',
        { url: 'https://www.mcdonalds.co.jp/' },
        page({ finalUrl: 'https://evil.example/' }),
      ],
      [
        'a page without the name in its title',
        { url: 'https://www.mcdonalds.co.jp/' },
        page({ html: '<title>Welcome</title>' }),
      ],
      ['an error page', { url: 'https://www.mcdonalds.co.jp/' }, page({ status: 404 })],
      ['an unreadable page', { url: 'https://www.mcdonalds.co.jp/' }, null],
      ['no answer', { url: null }, page()],
    ])('does not open %s', async (_label, guess, fetchedPage) => {
      const { runtime: r, opened } = runtime({ index: -1 }, [], NEWS, undefined, {
        guess,
        page: fetchedPage,
      });
      expect(await r.run(step({ subject: 'マクドナルド' }))).toMatchObject({
        ok: true,
        result: { opened: false, url: null },
      });
      expect(opened).toEqual([]);
    });

    it('also tries the known address when the search returned nothing', async () => {
      const { runtime: r, opened } = runtime({ index: -1 }, [], { results: [] }, undefined, {
        guess: { url: 'https://www.mcdonalds.co.jp/' },
        page: page(),
      });
      expect(await r.run(step({ subject: 'マクドナルド' }))).toMatchObject({
        ok: true,
        result: { opened: true },
      });
      expect(opened).toEqual(['https://www.mcdonalds.co.jp/']);
    });

    it('reads titles and site names, ignoring width and case', () => {
      expect(
        pageTitle(
          '<title> Oakley | 公式 </title><meta property="og:site_name" content="Oakley Japan">',
        ),
      ).toBe('Oakley | 公式 / Oakley Japan');
      expect(mentions('ＵＮＩＱＬＯ 公式オンラインストア', 'uniqlo')).toBe(true);
      expect(mentions('ユニクロ', 'マクドナルド')).toBe(false);
    });
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

  it('also searches the name before 「の」 at the same time, and opens it when the product phrase finds no official site', async () => {
    const searched: string[] = [];
    const opened: string[] = [];
    const r = new BrowserOpenRuntime({
      ask: async (toolId, args) => {
        if (toolId === 'search.web') {
          searched.push(String(args['query']));
          return {
            results: [
              { url: 'https://www.oakley.com/ja-jp', title: 'Oakley Japan', snippet: '公式' },
            ],
          };
        }
        if (toolId === 'llm.official_guess') return { url: null };
        // 商品名まで含むと公式と見なさない（実際の 2026-10-18 の結果）。名前だけなら選ぶ。
        // 見極めは「何の公式か」（subject）で決まる。2 つの名前は同時に探すので、検索の順には頼らない
        return args['subject'] === 'オークリーのサングラス'
          ? { index: -1 }
          : { index: 0, reason: '運営元' };
      },
      open: async (url) => {
        opened.push(url);
      },
      frontUrl: async () => opened.at(-1) ?? null,
      sleep: async () => {},
      fetchPage: async () => null,
    });
    const outcome = await r.run(step({ subject: 'オークリーのサングラス' }));
    expect(searched).toEqual(['オークリーのサングラス 公式サイト', 'オークリー 公式サイト']);
    expect(opened).toEqual(['https://www.oakley.com/ja-jp']);
    expect(outcome).toMatchObject({ ok: true, result: { opened: true, subject: 'オークリー' } });
  });

  it('opens the whole name when both are found, and searches both at once instead of one after the other', async () => {
    let inFlight = 0;
    let most = 0;
    const opened: string[] = [];
    const r = new BrowserOpenRuntime({
      ask: async (toolId, args) => {
        if (toolId !== 'search.web') return { index: 0, reason: '公式' };
        inFlight += 1;
        most = Math.max(most, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight -= 1;
        const name = String(args['query']).replace(' 公式サイト', '');
        return {
          results: [
            { url: `https://example.com/${encodeURIComponent(name)}`, title: name, snippet: '' },
          ],
        };
      },
      open: async (url) => {
        opened.push(url);
      },
      frontUrl: async () => opened.at(-1) ?? null,
      sleep: async () => {},
      fetchPage: async () => null,
    });
    const outcome = await r.run(step({ subject: '鬼滅の刃' }));
    expect(most).toBe(2);
    expect(opened).toEqual([`https://example.com/${encodeURIComponent('鬼滅の刃')}`]);
    expect(outcome).toMatchObject({ ok: true, result: { opened: true, subject: '鬼滅の刃' } });
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
