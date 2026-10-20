/**
 * Experimental public Yahoo chart adapter for a personal daily brief.
 * It uses no credentials or browser session and has no supported API guarantee.
 * Only observed price/currency/time are displayed; news and model text are not quotes.
 *
 * Every row says which trading day the value belongs to. Before the exchange opens the
 * value is the previous trading day's close and is labelled that way; holidays need no
 * calendar because the session date comes from the provider's own last regular trade.
 */
import type { BriefLine, BriefSection } from '@genie/contracts';
import { INFO_SCHEMA, type InfoEnvelope } from './envelope.js';
import type { InfoFetch } from './hosts.js';

/** Reference indices, not inferred holdings or investment recommendations. */
export const DEFAULT_WATCHLIST = ['^N225', '^GSPC', '^IXIC'] as const;
const MAX_SYMBOLS = 8;
const SYMBOL = /^(?:\^[A-Z][A-Z0-9]{0,18}|[A-Z0-9][A-Z0-9.=-]{0,19})$/;
const NAMES: Record<string, string> = {
  '^N225': '日経平均',
  '^GSPC': 'S&P 500',
  '^IXIC': 'NASDAQ総合',
};
// 「参考値・遅延の可能性」は節の出所に 1 度だけ書く（行ごとに繰り返すと値が読めない）。
const SOURCE = {
  name: 'Yahoo Finance（参考値・遅延の可能性・実験的）',
  url: 'https://finance.yahoo.com/',
};

export interface MarketQuote {
  readonly symbol: string;
  /** 表示名。決まった呼び名（日経平均など）か、取得元が返した銘柄名。会話のモデルが言った名前は使わない。 */
  readonly name: string;
  readonly price: number;
  /** Preserve provider units, including e.g. GBp; never assume a conversion. */
  readonly currency: string;
  readonly observedAt: string;
  readonly isIndex: boolean;
  readonly sourceUrl: string;
  /** open: inside the regular session now; closed: the value is that session's close. */
  readonly session: 'open' | 'closed' | 'unknown';
  /** Exchange-local trading day (YYYY-MM-DD) of the value. */
  readonly sessionDate: string;
  /** Exchange-local trading day at the time of reading. */
  readonly today: string;
  /** Close of the trading day before `sessionDate`, only when the provider returned it. */
  readonly previousClose: number | null;
}

const object = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

/** A quote belongs to exactly the requested symbol and must contain its own timestamp. */
export function parseMarketQuote(value: unknown, symbol: string, now: Date): MarketQuote | null {
  const chart = object(object(value)?.['chart']);
  const results = chart?.['result'];
  if (!chart || chart['error'] != null || !Array.isArray(results) || results.length !== 1)
    return null;
  const meta = object(object(results[0])?.['meta']);
  if (!meta || meta['symbol'] !== symbol) return null;
  const price = meta['regularMarketPrice'];
  const timestamp = meta['regularMarketTime'];
  const currency = meta['currency'];
  if (
    typeof price !== 'number' ||
    !Number.isFinite(price) ||
    price <= 0 ||
    typeof timestamp !== 'number' ||
    !Number.isSafeInteger(timestamp) ||
    timestamp <= 0 ||
    timestamp * 1000 > now.getTime() ||
    typeof currency !== 'string' ||
    !/^[A-Za-z]{3}$/.test(currency)
  )
    return null;
  // An index symbol must be the cash index itself; futures or other instruments are not mixed in.
  if (symbol.startsWith('^') && meta['instrumentType'] !== 'INDEX') return null;
  const period = object(object(meta['currentTradingPeriod'])?.['regular']);
  const offset = period?.['gmtoffset'];
  const offsetSeconds =
    typeof offset === 'number' && Number.isSafeInteger(offset) && Math.abs(offset) <= 14 * 3600
      ? offset
      : null;
  const localDay = (epochSeconds: number) =>
    new Date((epochSeconds + (offsetSeconds ?? 0)) * 1000).toISOString().slice(0, 10);
  const start = period?.['start'];
  const end = period?.['end'];
  const nowSeconds = Math.floor(now.getTime() / 1000);
  let session: MarketQuote['session'] = 'unknown';
  if (offsetSeconds !== null && typeof start === 'number' && typeof end === 'number' && end > start)
    session = nowSeconds >= start && nowSeconds < end && timestamp >= start ? 'open' : 'closed';
  const sessionDate = localDay(timestamp);
  const providerName = [meta['longName'], meta['shortName']].find(
    (value): value is string => typeof value === 'string' && value.trim().length > 0,
  );
  return {
    symbol,
    name: NAMES[symbol] ?? providerName?.trim().slice(0, 60) ?? symbol,
    price,
    currency,
    observedAt: new Date(timestamp * 1000).toISOString(),
    isIndex: meta['instrumentType'] === 'INDEX',
    sourceUrl: `https://finance.yahoo.com/quote/${encodeURIComponent(symbol)}/`,
    session,
    sessionDate,
    today: localDay(nowSeconds),
    previousClose: offsetSeconds === null ? null : previousClose(results[0], sessionDate, localDay),
  };
}

/** The last valid daily close strictly before the value's own trading day. */
function previousClose(
  result: unknown,
  sessionDate: string,
  localDay: (epochSeconds: number) => string,
): number | null {
  const row = object(result);
  const stamps = row?.['timestamp'];
  const quote = object((object(row?.['indicators'])?.['quote'] as unknown[] | undefined)?.[0]);
  const closes = quote?.['close'];
  if (!Array.isArray(stamps) || !Array.isArray(closes) || stamps.length !== closes.length)
    return null;
  for (let i = stamps.length - 1; i >= 0; i -= 1) {
    const stamp = stamps[i];
    const close = closes[i];
    if (typeof stamp !== 'number' || !Number.isSafeInteger(stamp)) return null;
    if (localDay(stamp) >= sessionDate) continue;
    return typeof close === 'number' && Number.isFinite(close) && close > 0 ? close : null;
  }
  return null;
}

/** 観測時刻を本人の時間帯で短く（10/10 5:00）。ISO のままでは読めない。 */
function observed(iso: string, timeZone: string): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone,
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(new Date(iso))
      .map((p) => [p.type, p.value]),
  );
  return `${parts['month']}/${parts['day']} ${Number(parts['hour'])}:${parts['minute']}`;
}

const WEEKDAY = ['日', '月', '火', '水', '木', '金', '土'];
function dayLabel(date: string): string {
  const [, month, day] = date.split('-').map(Number);
  return `${month}/${day}(${WEEKDAY[new Date(`${date}T00:00:00Z`).getUTCDay()]})`;
}

/** Which value this is, in words: never call yesterday's close "today". */
export function sessionLabel(quote: MarketQuote): string {
  if (quote.session === 'open') return `取引中 ${dayLabel(quote.sessionDate)}`;
  if (quote.session === 'unknown') return `${dayLabel(quote.sessionDate)}の値`;
  return quote.sessionDate < quote.today
    ? `前営業日 ${dayLabel(quote.sessionDate)}の終値`
    : `本日 ${dayLabel(quote.sessionDate)}の終値`;
}

function line(quote: MarketQuote, timeZone: string): BriefLine {
  const format = (value: number, sign = false) =>
    new Intl.NumberFormat('ja-JP', {
      maximumFractionDigits: 2,
      ...(sign ? { signDisplay: 'exceptZero' as const } : {}),
    }).format(value);
  // 行は短く（名前・値・騰落率）。幅を取る前日比の値は副題へ。
  const change = quote.previousClose === null ? null : quote.price - quote.previousClose;
  return {
    text: `${quote.name} ${format(quote.price)} ${quote.isIndex ? 'pt' : quote.currency}${change === null ? '' : ` ${format((change / quote.previousClose!) * 100, true)}%`}`,
    subtitle: `${change === null ? '' : `前日比 ${format(change, true)}・`}${sessionLabel(quote)}・観測 ${observed(quote.observedAt, timeZone)}`,
    url: quote.sourceUrl,
  };
}

/** At most eight public reads. Each passes through the same HTTPS/host/timeout boundary. */
async function fetchQuotes(
  symbols: readonly string[],
  get: InfoFetch,
  now: () => Date,
): Promise<(MarketQuote | null)[]> {
  return Promise.all(
    symbols.map(async (symbol): Promise<MarketQuote | null> => {
      try {
        const raw = await get(
          `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=5d`,
        );
        return parseMarketQuote(JSON.parse(raw), symbol, now());
      } catch {
        return null; // No response text, URL errors, cookies or provider notices enter the result.
      }
    }),
  );
}

/** Keep successful rows on partial failure; the caller can replace this adapter as a unit. */
export async function lookupMarkets(
  watchlist: readonly string[],
  get: InfoFetch,
  now: () => Date = () => new Date(),
  timeZone = 'Asia/Tokyo',
): Promise<BriefSection> {
  const base = { id: 'markets', title: '株価・指数', sources: [SOURCE] } as const;
  if (watchlist.length === 0)
    return {
      ...base,
      sources: [],
      status: 'none',
      reason: '確認する銘柄が未設定です',
      fetched_at: null,
      lines: [],
    };
  const symbols = [...new Set(watchlist.map((symbol) => symbol.trim().toUpperCase()))];
  if (symbols.length > MAX_SYMBOLS || symbols.some((symbol) => !SYMBOL.test(symbol)))
    return {
      ...base,
      sources: [],
      status: 'none',
      reason: '銘柄コードを8件以内で設定してください',
      fetched_at: null,
      lines: [],
    };
  const quotes = await fetchQuotes(symbols, get, now);
  const lines = quotes
    .filter((quote): quote is MarketQuote => quote !== null)
    .map((quote) => line(quote, timeZone));
  const failed = quotes.flatMap((quote, index) => (quote === null ? [symbols[index]!] : []));
  return {
    ...base,
    sources: [{ ...SOURCE }],
    status: failed.length ? 'stale' : 'ok',
    ...(failed.length
      ? { reason: `${lines.length}/${symbols.length}件取得・未取得: ${failed.join('、')}` }
      : {}),
    fetched_at: lines.length ? now().toISOString() : null,
    lines,
  };
}

/**
 * 呼び名・コードから銘柄コードへ。指数・為替の決まった呼び名と、東証の 4 桁コードだけを引く
 * （取得元の検索は日本語の社名を引けない。社名からのコードは会話のモデルが渡す）。
 */
const ALIASES: readonly (readonly [RegExp, string])[] = [
  [/日経平均|日経225|日経株価/u, '^N225'],
  [/ダウ(?!ン)/u, '^DJI'],
  [/S&P|SP500|エスアンドピー/iu, '^GSPC'],
  [/ナスダック|NASDAQ/iu, '^IXIC'],
  [/ドル円|米ドル|円相場|(?<!ユーロ.{0,4})為替/u, 'JPY=X'],
  [/ユーロ円/u, 'EURJPY=X'],
];

export function symbolsFor(subject: string): string[] {
  const text = subject.normalize('NFKC');
  const found = ALIASES.filter(([pattern]) => pattern.test(text)).map(([, symbol]) => symbol);
  // 年・月・日・金額の数字は銘柄コードにしない（「2026年の日経平均」）。
  for (const m of text.matchAll(
    /(?<![0-9A-Za-z.])(\d{4}|\d{3}[A-Z])(?:\.T)?(?![0-9A-Za-z年月日円%％])/gu,
  ))
    found.push(`${m[1]}.T`);
  return [...new Set(found)].slice(0, MAX_SYMBOLS);
}

export interface MarketRow {
  readonly symbol: string;
  readonly name: string;
  readonly price: number;
  readonly currency: string;
  readonly is_index: boolean;
  readonly change: number | null;
  readonly change_percent: number | null;
  /** 「前営業日 10/9(金)の終値」など、いつの値か */
  readonly session: string;
  /** 観測時刻（本人の時間帯、10/9 15:30） */
  readonly observed: string;
  readonly url: string;
}

/** 会話・依頼の「日経平均は？」「トヨタの株価」。数字は取得元の値だけ。 */
export async function lookupQuotes(
  query: { readonly subject: string | null; readonly symbols?: readonly string[] },
  get: InfoFetch,
  now: () => Date = () => new Date(),
  timeZone = 'Asia/Tokyo',
): Promise<InfoEnvelope> {
  const asked = (query.symbols ?? [])
    .map((symbol) => symbol.trim().toUpperCase())
    .map((symbol) => (/^\d{4}$/.test(symbol) ? `${symbol}.T` : symbol))
    .filter((symbol) => SYMBOL.test(symbol));
  const symbols = [...new Set(asked.length ? asked : symbolsFor(query.subject ?? ''))].slice(
    0,
    MAX_SYMBOLS,
  );
  const base = {
    schema: INFO_SCHEMA,
    kind: 'markets',
    sources: [{ ...SOURCE }],
    fetched_at: now().toISOString(),
  } as const;
  if (symbols.length === 0)
    return {
      ...base,
      text: '銘柄が分かりませんでした。「トヨタの株価」なら銘柄コード（7203）でも聞けます。',
      data: null,
    };
  const quotes = (await fetchQuotes(symbols, get, now)).filter(
    (quote): quote is MarketQuote => quote !== null,
  );
  if (quotes.length === 0)
    return {
      ...base,
      text: '株価を取得できませんでした。少し待ってからもう一度聞いてください。',
      data: null,
    };
  const rows: MarketRow[] = quotes.map((quote) => {
    const change = quote.previousClose === null ? null : quote.price - quote.previousClose;
    return {
      symbol: quote.symbol,
      name: quote.name,
      price: quote.price,
      currency: quote.currency,
      is_index: quote.isIndex,
      change,
      change_percent: change === null ? null : (change / quote.previousClose!) * 100,
      session: sessionLabel(quote),
      observed: observed(quote.observedAt, timeZone),
      url: quote.sourceUrl,
    };
  });
  const number = (value: number, sign = false) =>
    new Intl.NumberFormat('ja-JP', {
      maximumFractionDigits: 2,
      ...(sign ? { signDisplay: 'exceptZero' as const } : {}),
    }).format(value);
  const text = rows
    .map(
      (row) =>
        `${row.name}は${number(row.price)}${row.is_index ? 'ポイント' : ` ${row.currency}`}${row.change === null ? '' : `（前日比 ${number(row.change, true)}、${number(row.change_percent!, true)}%）`}、${row.session}です。`,
    )
    .join('');
  return {
    ...base,
    text: `${text}参考値で、遅れている可能性があります。`,
    data: { subject: query.subject, quotes: rows },
  };
}
