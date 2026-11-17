import { describe, expect, it, vi } from 'vitest';
import { BriefSection } from '@genie/contracts';
import { infoFetch } from '../src/current-info/hosts.js';
import {
  DEFAULT_WATCHLIST,
  lookupMarkets,
  lookupQuotes,
  parseMarketQuote,
  sessionLabel,
  symbolsFor,
} from '../src/current-info/markets.js';
import { CurrentInfoRunner } from '../src/current-info/runner.js';

const now = () => new Date('2026-10-10T12:00:00Z');
const observed = '2026-10-09T06:30:00.000Z';
const metadata = (symbol = '^N225') => ({
  symbol,
  currency: symbol === '^N225' || symbol.endsWith('.T') ? 'JPY' : 'USD',
  regularMarketPrice: 2910.5,
  regularMarketTime: Date.parse(observed) / 1000,
  instrumentType: symbol.startsWith('^') ? 'INDEX' : 'EQUITY',
});
const payload = (meta: Record<string, unknown> = metadata()) => ({
  chart: { result: [{ meta }], error: null },
});
const requestedSymbol = (url: string) =>
  decodeURIComponent(new URL(url).pathname.split('/').at(-1)!);

describe('experimental public market quotes', () => {
  it('declares reference indices without implying holdings', () => {
    expect(DEFAULT_WATCHLIST).toEqual(['^N225', '^GSPC', '^IXIC']);
  });

  it('returns only an observed price, original currency, timestamp and fixed source link', () => {
    expect(parseMarketQuote(payload(metadata('7203.T')), '7203.T', now())).toEqual({
      symbol: '7203.T',
      name: '7203.T',
      price: 2910.5,
      currency: 'JPY',
      observedAt: observed,
      isIndex: false,
      sourceUrl: 'https://finance.yahoo.com/quote/7203.T/',
      session: 'unknown',
      sessionDate: '2026-10-09',
      today: '2026-10-10',
      previousClose: null,
    });
    expect(
      parseMarketQuote(payload({ ...metadata('VOD.L'), currency: 'GBp' }), 'VOD.L', now())
        ?.currency,
    ).toBe('GBp');
  });

  it.each([
    { regularMarketPrice: undefined },
    { regularMarketPrice: '2910.5' },
    { regularMarketPrice: 0 },
    { regularMarketPrice: -1 },
    { regularMarketPrice: Number.NaN },
    { regularMarketPrice: Number.POSITIVE_INFINITY },
    { regularMarketTime: undefined },
    { regularMarketTime: 0 },
    { regularMarketTime: 1.5 },
    { regularMarketTime: Number.POSITIVE_INFINITY },
    { regularMarketTime: now().getTime() / 1000 + 1 },
    { currency: undefined },
    { currency: '' },
    { currency: 'USD<script>' },
    { symbol: '^GSPC' },
  ])('rejects incomplete or inconsistent quote metadata %j', (change) => {
    expect(parseMarketQuote(payload({ ...metadata(), ...change }), '^N225', now())).toBeNull();
  });

  it('refuses provider errors and ambiguous result sets even when quote-looking values exist', () => {
    for (const value of [
      null,
      {},
      { chart: { result: [] } },
      { chart: { ...payload().chart, error: { description: 'PRIVATE_PROVIDER_MESSAGE' } } },
      { chart: { result: [{ meta: metadata() }, { meta: metadata() }], error: null } },
    ])
      expect(parseMarketQuote(value, '^N225', now())).toBeNull();
  });

  it('fetches bounded independent public queries and shows both observed and fetch times', async () => {
    const get = vi.fn(async (url: string) =>
      JSON.stringify(payload(metadata(requestedSymbol(url)))),
    );
    const section = await lookupMarkets(DEFAULT_WATCHLIST, get, now);
    expect(BriefSection.safeParse(section).success).toBe(true);
    expect(section).toMatchObject({
      id: 'markets',
      title: '株価・指数',
      status: 'ok',
      fetched_at: now().toISOString(),
    });
    expect(section.lines.map((line) => line.text)).toEqual([
      '日経平均 2,910.5 pt',
      'S&P 500 2,910.5 pt',
      'NASDAQ総合 2,910.5 pt',
    ]);
    // 観測時刻は本人の時間帯で読める形に。参考値の注記は節の出所に 1 度だけ。
    expect(section.lines[0]?.subtitle).toBe('10/9(金)の値・観測 10/9 15:30');
    expect(section.sources[0]?.name).toContain('参考値・遅延の可能性');
    expect(section.lines[0]?.url).toBe('https://finance.yahoo.com/quote/%5EN225/');
    expect(section.lines.every((line) => !line.text.includes('%'))).toBe(true); // No invented previous-close change.
    expect(get).toHaveBeenCalledTimes(3);
    for (const [raw] of get.mock.calls) {
      const url = new URL(raw);
      expect(url.origin).toBe('https://query1.finance.yahoo.com');
      expect(url.pathname).toMatch(/^\/v8\/finance\/chart\//);
      expect([...url.searchParams.entries()]).toEqual([
        ['interval', '1d'],
        ['range', '5d'],
      ]);
      expect(url.username).toBe('');
    }
  });

  it('normalizes and deduplicates ticker input without modifying quoted currency or price', async () => {
    const get = vi.fn(async (url: string) =>
      JSON.stringify(payload(metadata(requestedSymbol(url)))),
    );
    const section = await lookupMarkets([' aapl ', 'AAPL', '7203.t'], get, now);
    expect(get).toHaveBeenCalledTimes(2);
    expect(section.lines.map((line) => line.text)).toEqual([
      'AAPL 2,910.5 USD',
      '7203.T 2,910.5 JPY',
    ]);
  });

  it('treats an explicitly empty watchlist as unconfigured without fetching defaults', async () => {
    const get = vi.fn();
    const section = await lookupMarkets([], get, now);
    expect(section).toMatchObject({ status: 'none', fetched_at: null, lines: [], sources: [] });
    expect(get).not.toHaveBeenCalled();
  });

  it.each([
    [''],
    ['https://example.invalid/'],
    ['AAPL?secret=PRIVATE'],
    ['AAPL/../../x'],
    ['PRIVATE_株'],
    Array.from({ length: 9 }, (_, i) => `A${i}`),
  ])('rejects invalid or over-limit watchlists before network access: %j', async (...input) => {
    const get = vi.fn();
    const section = await lookupMarkets(input, get, now);
    expect(section).toMatchObject({ status: 'none', lines: [], sources: [] });
    expect(get).not.toHaveBeenCalled();
    expect(JSON.stringify(section)).not.toContain('PRIVATE');
  });

  it('keeps successful rows and identifies partial failure without copying provider errors', async () => {
    const get = vi.fn(async (url: string) => {
      if (requestedSymbol(url) === '^GSPC') throw new Error('PRIVATE_HTTP_NOTICE token=secret');
      return JSON.stringify(payload(metadata(requestedSymbol(url))));
    });
    const section = await lookupMarkets(DEFAULT_WATCHLIST, get, now);
    expect(section).toMatchObject({
      status: 'stale',
      fetched_at: now().toISOString(),
      reason: '2/3件取得・未取得: ^GSPC',
    });
    expect(section.lines).toHaveLength(2);
    expect(section.lines[1]?.text).toContain('NASDAQ総合');
    expect(JSON.stringify(section)).not.toContain('PRIVATE');
  });

  it('reports all unavailable quotes without substituting prices or fetch timestamps', async () => {
    const get = vi.fn(async (url: string) =>
      requestedSymbol(url) === '^N225'
        ? '<html>PRIVATE</html>'
        : JSON.stringify(payload({ ...metadata(), regularMarketTime: undefined })),
    );
    expect(await lookupMarkets(DEFAULT_WATCHLIST, get, now)).toMatchObject({
      status: 'stale',
      fetched_at: null,
      lines: [],
      reason: '0/3件取得・未取得: ^N225、^GSPC、^IXIC',
    });
  });

  it('uses the shared no-credentials, no-redirect, five-second fetch boundary', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(
      async (url) => new Response(JSON.stringify(payload(metadata(requestedSymbol(String(url)))))),
    );
    const section = await lookupMarkets(['7203.T'], infoFetch(fetch), now);
    expect(section.status).toBe('ok');
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({ redirect: 'error', credentials: 'omit' });
    expect(fetch.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
    await expect(infoFetch(fetch)('https://finance.yahoo.com/quote/7203.T/')).rejects.toThrow(
      'not an allowed',
    );
  });
});

// Shape of the live chart response (2026-10-09 close, read on the following holiday Monday).
const JST = 9 * 3600;
const session = (day: string) => Date.parse(`${day}T00:00:00Z`) / 1000 - JST + 9 * 3600; // 09:00 JST
const live = (
  meta: Record<string, unknown> = {},
  closes = [69946.86, 70683.98, 70035.71, 69042.11, 69030.92],
) => ({
  chart: {
    error: null,
    result: [
      {
        meta: {
          symbol: '^N225',
          currency: 'JPY',
          instrumentType: 'INDEX',
          regularMarketPrice: 69030.92,
          regularMarketTime: session('2026-10-09') + 6 * 3600 + 45 * 60, // 15:45 JST
          currentTradingPeriod: {
            regular: {
              start: session('2026-10-09'),
              end: session('2026-10-09') + 6.5 * 3600,
              gmtoffset: JST,
            },
          },
          ...meta,
        },
        timestamp: ['2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09'].map(
          session,
        ),
        indicators: { quote: [{ close: closes }] },
      },
    ],
  },
});

describe('trading-day labels', () => {
  const at = (iso: string) => new Date(iso);

  it('calls the value the previous trading day close before the market opens, with a real change', () => {
    const quote = parseMarketQuote(live(), '^N225', at('2026-10-11T23:00:00Z'))!; // 10/12 08:00 JST
    expect(quote).toMatchObject({
      session: 'closed',
      sessionDate: '2026-10-09',
      today: '2026-10-12',
    });
    expect(quote.previousClose).toBeCloseTo(69042.11);
    expect(sessionLabel(quote)).toBe('前営業日 10/9(金)の終値');
  });

  it('calls the same-day value a close after the session ends, and open during the session', () => {
    const afterClose = parseMarketQuote(live(), '^N225', at('2026-10-09T07:00:00Z'))!; // 16:00 JST
    expect(sessionLabel(afterClose)).toBe('本日 10/9(金)の終値');
    const during = parseMarketQuote(
      live({ regularMarketTime: session('2026-10-09') + 3600 }),
      '^N225',
      at('2026-10-09T02:00:00Z'), // 11:00 JST
    )!;
    expect(during.session).toBe('open');
    expect(sessionLabel(during)).toBe('取引中 10/9(金)');
  });

  it('shows the change from the previous close and the trading day in the row', async () => {
    const section = await lookupMarkets(
      ['^N225'],
      async () => JSON.stringify(live()),
      () => at('2026-10-11T23:00:00Z'),
    );
    expect(section.lines[0]?.text).toBe('日経平均 69,030.92 pt -0.02%');
    expect(section.lines[0]?.subtitle?.startsWith('前日比 -11.19・前営業日 10/9(金)の終値・')).toBe(
      true,
    );
  });

  it('does not invent a change when the previous close is missing', () => {
    const quote = parseMarketQuote(
      live({}, [null, null, null, null, 69030.92] as never),
      '^N225',
      at('2026-10-11T23:00:00Z'),
    )!;
    expect(quote.previousClose).toBeNull();
  });

  it('never mixes a future or other instrument into an index row', () => {
    expect(
      parseMarketQuote(live({ instrumentType: 'FUTURE' }), '^N225', at('2026-10-11T23:00:00Z')),
    ).toBeNull();
  });
});

describe('quotes asked in conversation or a request', () => {
  it('maps fixed index names and Tokyo codes, never years or amounts', () => {
    expect(symbolsFor('日経平均は？')).toEqual(['^N225']);
    expect(symbolsFor('ダウとナスダックはどう？')).toEqual(['^DJI', '^IXIC']);
    expect(symbolsFor('7203の株価')).toEqual(['7203.T']);
    expect(symbolsFor('2026年の日経平均')).toEqual(['^N225']);
    expect(symbolsFor('1000円以下の株価')).toEqual([]);
    expect(symbolsFor('ドル円はいくら？')).toEqual(['JPY=X']);
    expect(symbolsFor('今の為替レート教えて')).toEqual(['JPY=X']);
    expect(symbolsFor('ユーロ円って今どう？')).toEqual(['EURJPY=X']);
    expect(symbolsFor('ユーロ円の為替')).toEqual(['EURJPY=X']);
    expect(symbolsFor('ダウンロード数')).toEqual([]);
  });

  it('shows the provider name and value for the symbol the model passed, not its words', async () => {
    const get = vi.fn(async (url: string) =>
      JSON.stringify(
        payload({ ...metadata(requestedSymbol(url)), longName: 'Toyota Motor Corporation' }),
      ),
    );
    const envelope = await lookupQuotes({ subject: 'トヨタの株価', symbols: ['7203'] }, get, now);
    expect(envelope.kind).toBe('markets');
    if (envelope.kind !== 'markets') return;
    expect(envelope.data?.quotes).toEqual([
      expect.objectContaining({
        symbol: '7203.T',
        name: 'Toyota Motor Corporation',
        price: 2910.5,
        currency: 'JPY',
        observed: '10/9 15:30',
      }),
    ]);
    expect(envelope.text).toContain('Toyota Motor Corporationは2,910.5 JPY');
    expect(envelope.text).toContain('参考値');
    expect(get).toHaveBeenCalledTimes(1);
  });

  it('says it does not know the symbol instead of guessing', async () => {
    const get = vi.fn();
    const envelope = await lookupQuotes({ subject: 'トヨタの株価' }, get, now);
    expect(envelope).toMatchObject({ kind: 'markets', data: null });
    expect(envelope.text).toContain('銘柄が分かりませんでした');
    expect(get).not.toHaveBeenCalled();
  });

  it('runs as info.lookup markets and returns a card envelope', async () => {
    const runner = new CurrentInfoRunner({
      fetch: async (url) => JSON.stringify(payload(metadata(requestedSymbol(url)))),
      now,
    });
    const outcome = await runner.run({
      toolId: 'info.lookup',
      args: { kind: 'markets', subject: '日経平均は？', question: '日経平均は？' },
    } as never);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const body = JSON.parse(
      (outcome.result as { artifact: { markdown: string } }).artifact.markdown,
    );
    expect(body).toMatchObject({ schema: 'genie.info/v1', kind: 'markets' });
    expect(body.data.quotes[0]).toMatchObject({ symbol: '^N225', name: '日経平均' });
  });
});
