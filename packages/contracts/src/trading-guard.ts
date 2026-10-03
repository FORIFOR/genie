/**
 * デイトレードの歯止め。**模擬取引（紙の取引）にかける規則で、実売買の許可ではない。**
 *
 * 承認の範囲（金額・回数・期限）とは別に、取引の作法として毎回確かめる:
 *   - 取引時間の中か（東証: 前場 9:00〜11:30、後場 12:30〜15:30、平日）
 *   - 1 回の注文額が上限以下か
 *   - その日の取引回数が上限に達していないか
 *   - その日の確定損失が上限に達していないか（達したらその日はもう取引しない）
 *   - 買い: 持ち高（取得額）が上限を超えないか
 *   - 売り: 持っている数を超えないか（空売りはしない）
 *
 * 入出力を持たない純粋な関数。日付と時刻は呼び出し側の「いま」で決まる。
 */
export interface TradingSession {
  /** "HH:MM"（東京時間） */
  readonly start: string;
  readonly end: string;
}

export interface TradingLimits {
  readonly maxOrderValueMinor: number;
  readonly maxDailyLossMinor: number;
  readonly maxTradesPerDay: number;
  readonly maxPositionValueMinor: number;
  readonly sessions: readonly TradingSession[];
  /** 取引する曜日（0=日〜6=土、東京時間）。省けば平日。祝日は見ていない。 */
  readonly days?: readonly number[];
}

/** 円の minor 単位は 1 円。模擬取引の既定（本人が見直せる初期値）。 */
export const DEFAULT_PAPER_TRADING_LIMITS: TradingLimits = Object.freeze({
  maxOrderValueMinor: 300_000,
  maxDailyLossMinor: 30_000,
  maxTradesPerDay: 20,
  maxPositionValueMinor: 1_000_000,
  sessions: Object.freeze([
    Object.freeze({ start: '09:00', end: '11:30' }),
    Object.freeze({ start: '12:30', end: '15:30' }),
  ]),
});

export interface TradingFill {
  readonly symbol: string;
  readonly side: 'BUY' | 'SELL';
  readonly quantity: number;
  readonly priceMinor: number;
  /** ISO 時刻 */
  readonly at: string;
}

export interface TradingPosition {
  readonly quantity: number;
  /** 持っている分の取得額（平均単価 × 数量） */
  readonly costMinor: number;
}

export interface TradingDay {
  /** 東京時間の日付 "YYYY-MM-DD" */
  readonly date: string;
  readonly trades: number;
  readonly realizedPnlMinor: number;
  readonly positions: Readonly<Record<string, TradingPosition>>;
}

export interface TradeOrder {
  readonly symbol: string;
  readonly side: 'BUY' | 'SELL';
  readonly quantity: number;
  /** 指値なら指値、成行なら直近の価格。注文額の見積もりに使う。 */
  readonly priceMinor: number;
}

export type TradingBlock =
  | 'live_trading_unsupported'
  | 'market_closed'
  | 'order_too_large'
  | 'too_many_trades'
  | 'daily_loss_reached'
  | 'position_too_large'
  | 'no_short_selling';

export interface TradingDecision {
  readonly allowed: boolean;
  readonly blocks: readonly { readonly code: TradingBlock; readonly message: string }[];
}

const yen = (minor: number) => `${Math.round(minor).toLocaleString('ja-JP')}円`;

/** 東京時間の日付・曜日・分。 */
export function tokyoClock(now: Date): { date: string; weekday: number; minutes: number } {
  const shifted = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  return {
    date: shifted.toISOString().slice(0, 10),
    weekday: shifted.getUTCDay(),
    minutes: shifted.getUTCHours() * 60 + shifted.getUTCMinutes(),
  };
}

const minutesOf = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number);
  return h! * 60 + m!;
};

export function marketOpen(
  now: Date,
  limits: TradingLimits = DEFAULT_PAPER_TRADING_LIMITS,
): boolean {
  const clock = tokyoClock(now);
  if (!(limits.days ?? [1, 2, 3, 4, 5]).includes(clock.weekday)) return false;
  return limits.sessions.some(
    (session) =>
      clock.minutes >= minutesOf(session.start) && clock.minutes < minutesOf(session.end),
  );
}

/** 約定の記録から、その日の回数・確定損益・持ち高を出す（平均取得単価で計算）。 */
export function tradingDayOf(fills: readonly TradingFill[], now: Date): TradingDay {
  const today = tokyoClock(now).date;
  const positions: Record<string, TradingPosition> = {};
  let realized = 0;
  let trades = 0;
  const ordered = [...fills].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  for (const fill of ordered) {
    const held = positions[fill.symbol] ?? { quantity: 0, costMinor: 0 };
    const isToday = tokyoClock(new Date(fill.at)).date === today;
    if (isToday) trades += 1;
    if (fill.side === 'BUY') {
      positions[fill.symbol] = {
        quantity: held.quantity + fill.quantity,
        costMinor: held.costMinor + fill.quantity * fill.priceMinor,
      };
      continue;
    }
    const sold = Math.min(fill.quantity, held.quantity);
    const average = held.quantity > 0 ? held.costMinor / held.quantity : 0;
    if (isToday) realized += sold * (fill.priceMinor - average);
    positions[fill.symbol] = {
      quantity: held.quantity - sold,
      costMinor: held.costMinor - sold * average,
    };
  }
  return { date: today, trades, realizedPnlMinor: Math.round(realized), positions };
}

export function evaluatePaperTrade(
  order: TradeOrder,
  day: TradingDay,
  now: Date,
  options: { readonly mode: 'simulation' | 'live'; readonly limits?: TradingLimits },
): TradingDecision {
  const limits = options.limits ?? DEFAULT_PAPER_TRADING_LIMITS;
  const blocks: { code: TradingBlock; message: string }[] = [];
  const block = (code: TradingBlock, message: string) => blocks.push({ code, message });

  if (options.mode !== 'simulation')
    block('live_trading_unsupported', '実際の売買には対応していません。模擬取引だけを行います。');
  if (!marketOpen(now, limits))
    block(
      'market_closed',
      `取引時間外です（平日 ${limits.sessions.map((s) => `${s.start}〜${s.end}`).join('・')}、東京時間）。`,
    );
  const value = order.quantity * order.priceMinor;
  if (value > limits.maxOrderValueMinor)
    block(
      'order_too_large',
      `1 回の注文額 ${yen(value)} が上限 ${yen(limits.maxOrderValueMinor)} を超えます。`,
    );
  if (day.trades >= limits.maxTradesPerDay)
    block(
      'too_many_trades',
      `今日の取引回数が上限（${limits.maxTradesPerDay} 回）に達しています。`,
    );
  if (day.realizedPnlMinor <= -limits.maxDailyLossMinor)
    block(
      'daily_loss_reached',
      `今日の確定損失 ${yen(-day.realizedPnlMinor)} が上限 ${yen(limits.maxDailyLossMinor)} に達したため、今日はもう取引しません。`,
    );
  const held = day.positions[order.symbol] ?? { quantity: 0, costMinor: 0 };
  if (order.side === 'BUY') {
    const total = Object.values(day.positions).reduce((sum, p) => sum + p.costMinor, 0) + value;
    if (total > limits.maxPositionValueMinor)
      block(
        'position_too_large',
        `持ち高が ${yen(total)} になり、上限 ${yen(limits.maxPositionValueMinor)} を超えます。`,
      );
  } else if (order.quantity > held.quantity)
    block(
      'no_short_selling',
      `${order.symbol} の保有は ${held.quantity} 株です。持っている以上は売りません（空売りはしません）。`,
    );

  return { allowed: blocks.length === 0, blocks };
}
