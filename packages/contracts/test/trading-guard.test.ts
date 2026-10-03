import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PAPER_TRADING_LIMITS,
  evaluatePaperTrade,
  marketOpen,
  tradingDayOf,
  type TradingFill,
} from '../src/trading-guard.js';

// 2026-10-05 is a Monday. Times are UTC; Tokyo is +9.
const tokyo = (hhmm: string, date = '2026-10-05') => {
  const [h, m] = hhmm.split(':').map(Number);
  return new Date(
    Date.UTC(
      Number(date.slice(0, 4)),
      Number(date.slice(5, 7)) - 1,
      Number(date.slice(8)),
      h! - 9,
      m!,
    ),
  );
};
const fill = (
  side: 'BUY' | 'SELL',
  quantity: number,
  priceMinor: number,
  at: Date,
  symbol = '7203',
): TradingFill => ({
  symbol,
  side,
  quantity,
  priceMinor,
  at: at.toISOString(),
});
const buy = { symbol: '7203', side: 'BUY' as const, quantity: 100, priceMinor: 2_500 };
const simulation = { mode: 'simulation' as const };
const empty = (now: Date) => tradingDayOf([], now);

describe('trading hours (Tokyo Stock Exchange)', () => {
  it('opens 9:00-11:30 and 12:30-15:30 on weekdays only', () => {
    for (const [time, open] of [
      ['08:59', false],
      ['09:00', true],
      ['11:29', true],
      ['11:30', false],
      ['12:30', true],
      ['15:29', true],
      ['15:30', false],
    ] as const)
      expect(marketOpen(tokyo(time)), time).toBe(open);
    expect(marketOpen(tokyo('10:00', '2026-10-04'))).toBe(false); // Sunday
    expect(marketOpen(tokyo('10:00', '2026-10-03'))).toBe(false); // Saturday
  });

  it('can be opened on other days for practice', () => {
    const allWeek = { ...DEFAULT_PAPER_TRADING_LIMITS, days: [0, 1, 2, 3, 4, 5, 6] };
    expect(marketOpen(tokyo('10:00', '2026-10-04'), allWeek)).toBe(true);
  });
});

describe('a paper trade', () => {
  it('is allowed within every limit', () => {
    const now = tokyo('10:00');
    expect(evaluatePaperTrade(buy, empty(now), now, simulation)).toEqual({
      allowed: true,
      blocks: [],
    });
  });

  it('is never a live trade', () => {
    const now = tokyo('10:00');
    const decision = evaluatePaperTrade(buy, empty(now), now, { mode: 'live' });
    expect(decision.allowed).toBe(false);
    expect(decision.blocks.map((b) => b.code)).toContain('live_trading_unsupported');
  });

  it('waits for the market to open', () => {
    const now = tokyo('12:00');
    expect(evaluatePaperTrade(buy, empty(now), now, simulation).blocks.map((b) => b.code)).toEqual([
      'market_closed',
    ]);
  });

  it('refuses an order larger than the per-order limit', () => {
    const now = tokyo('10:00');
    const decision = evaluatePaperTrade({ ...buy, quantity: 200 }, empty(now), now, simulation);
    expect(decision.blocks.map((b) => b.code)).toEqual(['order_too_large']);
    expect(decision.blocks[0]!.message).toContain('500,000円');
  });

  it('stops for the day once the realized loss reaches the limit', () => {
    const now = tokyo('14:00');
    const day = tradingDayOf(
      [fill('BUY', 100, 2_800, tokyo('09:10')), fill('SELL', 100, 2_490, tokyo('10:30'))],
      now,
    );
    expect(day.realizedPnlMinor).toBe(-31_000);
    expect(evaluatePaperTrade(buy, day, now, simulation).blocks.map((b) => b.code)).toEqual([
      'daily_loss_reached',
    ]);
  });

  it('counts only today toward the trade and loss limits', () => {
    const now = tokyo('10:00');
    const yesterday = Array.from({ length: 25 }, (_, i) =>
      fill(i % 2 ? 'SELL' : 'BUY', 1, 1_000, tokyo('10:00', '2026-10-02')),
    );
    const day = tradingDayOf(yesterday, now);
    expect(day.trades).toBe(0);
    expect(evaluatePaperTrade(buy, day, now, simulation).allowed).toBe(true);
  });

  it('stops after the daily number of trades', () => {
    const now = tokyo('13:00');
    const fills = Array.from({ length: DEFAULT_PAPER_TRADING_LIMITS.maxTradesPerDay }, (_, i) =>
      fill(i % 2 ? 'SELL' : 'BUY', 1, 1_000, tokyo('09:30')),
    );
    expect(
      evaluatePaperTrade(buy, tradingDayOf(fills, now), now, simulation).blocks.map((b) => b.code),
    ).toEqual(['too_many_trades']);
  });

  it('does not let holdings grow past the position limit', () => {
    const now = tokyo('10:00');
    const day = tradingDayOf([fill('BUY', 300, 2_500, tokyo('09:05'), '6758')], now);
    expect(evaluatePaperTrade({ ...buy, quantity: 100 }, day, now, simulation).allowed).toBe(true);
    const more = tradingDayOf(
      [fill('BUY', 300, 2_500, tokyo('09:05'), '6758'), fill('BUY', 80, 2_500, tokyo('09:06'))],
      now,
    );
    expect(evaluatePaperTrade(buy, more, now, simulation).blocks.map((b) => b.code)).toEqual([
      'position_too_large',
    ]);
  });

  it('never sells more than it holds', () => {
    const now = tokyo('10:00');
    const day = tradingDayOf([fill('BUY', 100, 2_500, tokyo('09:05'))], now);
    expect(
      evaluatePaperTrade({ ...buy, side: 'SELL', quantity: 100 }, day, now, simulation).allowed,
    ).toBe(true);
    expect(
      evaluatePaperTrade({ ...buy, side: 'SELL', quantity: 101 }, day, now, simulation).blocks.map(
        (b) => b.code,
      ),
    ).toEqual(['no_short_selling']);
  });

  it('computes realized profit with the average cost', () => {
    const now = tokyo('15:00');
    const day = tradingDayOf(
      [
        fill('BUY', 100, 2_000, tokyo('09:01')),
        fill('BUY', 100, 3_000, tokyo('09:02')),
        fill('SELL', 100, 2_700, tokyo('10:00')),
      ],
      now,
    );
    expect(day.realizedPnlMinor).toBe(20_000);
    expect(day.positions['7203']).toEqual({ quantity: 100, costMinor: 250_000 });
  });
});
