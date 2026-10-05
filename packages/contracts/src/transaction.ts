/** Experimental transaction boundary. Simulation evidence is never a live receipt. */
import { z } from 'zod';
import { Sha256Hex, Timestamp } from './primitives.js';
import { canonicalJson, canonicalSha256 } from './canonical.js';

const Ref = z.string().min(1).max(160);
const Minor = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const Quantity = z.number().int().positive().max(1_000_000);
export const TransactionMode = z.enum(['simulation', 'live']);
export type TransactionMode = z.infer<typeof TransactionMode>;
export const TransactionKind = z.enum(['delivery', 'stock_paper']);
export type TransactionKind = z.infer<typeof TransactionKind>;
export const TransactionDestination = z
  .object({ id: Ref, label: z.string().min(1).max(500) })
  .strict();
export const TransactionItem = z
  .object({
    id: Ref,
    label: z.string().min(1).max(200),
    quantity: Quantity,
    options: z.array(z.string().min(1).max(200)).max(30),
  })
  .strict();
export const TransactionQuoteItem = TransactionItem.extend({
  unitMinor: Minor,
  lineMinor: Minor,
}).strict();
export const PaperStockOrder = z
  .object({
    symbol: Ref,
    market: Ref,
    side: z.enum(['BUY', 'SELL']),
    quantity: Quantity,
    orderType: z.enum(['LIMIT', 'MARKET']),
    limitPriceMinor: Minor.optional(),
    timeInForce: z.enum(['DAY', 'GTC', 'IOC', 'FOK']),
  })
  .strict()
  .refine(
    (value) =>
      value.orderType === 'LIMIT'
        ? value.limitPriceMinor !== undefined && value.limitPriceMinor > 0
        : value.limitPriceMinor === undefined,
    'Limit orders need a price; market orders must not invent one',
  );

const Identity = {
  kind: TransactionKind,
  mode: TransactionMode,
  provider: Ref,
  account: Ref,
  orderKey: Ref,
};
const Content = {
  ...Identity,
  currency: z.string().regex(/^[A-Z]{3}$/),
  destination: TransactionDestination,
  paymentMethodRef: Ref,
  requestedTime: z.union([z.literal('asap'), Timestamp]).optional(),
  stock: PaperStockOrder.optional(),
};
function validKind(value: {
  kind: TransactionKind;
  mode: TransactionMode;
  stock?: unknown;
  requestedTime?: unknown;
}): boolean {
  return value.kind === 'stock_paper'
    ? value.mode === 'simulation' && value.stock !== undefined && value.requestedTime === undefined
    : value.stock === undefined && value.requestedTime !== undefined;
}
export const TransactionIntent = z
  .object({
    ...Content,
    items: z.array(TransactionItem).min(1).max(100),
    maxTotalMinor: Minor,
  })
  .strict()
  .refine(validKind, 'Paper stock is simulation only and needs explicit stock terms');
export type TransactionIntent = z.infer<typeof TransactionIntent>;

export const TransactionTotals = z
  .object({
    subtotalMinor: Minor,
    taxMinor: Minor,
    feeMinor: Minor,
    tipMinor: Minor,
    totalMinor: Minor,
  })
  .strict();
export const TransactionQuote = z
  .object({
    ...Content,
    quoteId: Ref,
    items: z.array(TransactionQuoteItem).min(1).max(100),
    totals: TransactionTotals,
    expiresAt: Timestamp,
  })
  .strict()
  .refine(validKind, 'Paper stock is simulation only and needs explicit stock terms');
export type TransactionQuote = z.infer<typeof TransactionQuote>;
export const TransactionSubmitArgs = z
  .object({
    intent: TransactionIntent,
    quote: TransactionQuote,
    quoteHash: Sha256Hex,
  })
  .strict();
export type TransactionSubmitArgs = z.infer<typeof TransactionSubmitArgs>;
export const TransactionPrepareArgs = z.object({ intent: TransactionIntent }).strict();
export const TransactionReconcileArgs = z
  .object({
    provider: Ref,
    mode: TransactionMode,
    account: Ref,
    orderKey: Ref,
  })
  .strict();
export type TransactionReconcileArgs = z.infer<typeof TransactionReconcileArgs>;

/** A retained lookup identity is not a receipt or proof of external cancellation. */
export const UnknownTransactionResult = TransactionReconcileArgs.extend({
  quoteHash: Sha256Hex,
  status: z.literal('unknown'),
}).strict();
export type UnknownTransactionResult = z.infer<typeof UnknownTransactionResult>;

export const OrderObservation = z
  .object({
    provider: Ref,
    mode: TransactionMode,
    account: Ref,
    orderKey: Ref,
    quoteHash: Sha256Hex,
    providerOrderId: Ref,
    observedAt: Timestamp,
    status: z.enum([
      'accepted',
      'preparing',
      'out_for_delivery',
      'delivered',
      'rejected',
      'cancelled',
      'expired',
      'partially_filled',
      'filled',
    ]),
    // Structured provider readback, not the planner's assertion that a click worked.
    details: z
      .object({
        currency: z.string().regex(/^[A-Z]{3}$/),
        totalMinor: Minor,
        destinationId: Ref,
        paymentMethodRef: Ref,
        requestedTime: z.union([z.literal('asap'), Timestamp]).optional(),
        stock: PaperStockOrder.optional(),
        items: z.array(TransactionQuoteItem).min(1).max(100),
      })
      .strict(),
    fills: z
      .array(z.object({ executionId: Ref, quantity: Quantity, priceMinor: Minor }).strict())
      .max(1000)
      .optional(),
  })
  .strict();
export type OrderObservation = z.infer<typeof OrderObservation>;

export interface TransactionResult {
  readonly mode: TransactionMode;
  readonly provider: string;
  readonly account: string;
  readonly orderKey: string;
  readonly quoteHash: string;
  readonly status: OrderObservation['status'] | 'unknown';
  readonly observation?: OrderObservation;
}

export class TransactionValidationError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

/** Money is in the currency's minor units throughout. Never infer a decimal exponent. */
export function validateTransactionQuote(
  raw: unknown,
  intent: TransactionIntent,
  now: number,
): TransactionQuote {
  const parsed = TransactionQuote.safeParse(raw);
  if (!parsed.success) throw new TransactionValidationError('invalid_quote');
  const quote = parsed.data;
  if (Date.parse(quote.expiresAt) <= now) throw new TransactionValidationError('expired_quote');
  const { maxTotalMinor: _budget, items: requestedItems, ...requested } = intent;
  const { quoteId: _id, expiresAt: _expiry, totals, items: priced, ...quoted } = quote;
  if (
    canonicalJson(requested) !== canonicalJson(quoted) ||
    canonicalJson(requestedItems) !==
      canonicalJson(priced.map(({ unitMinor: _unit, lineMinor: _line, ...item }) => item))
  )
    throw new TransactionValidationError('quote_changed');
  const safeSum = (values: number[]) => {
    const sum = values.reduce((total, value) => total + value, 0);
    if (!Number.isSafeInteger(sum)) throw new TransactionValidationError('invalid_quote');
    return sum;
  };
  if (
    new Set(priced.map((item) => item.id)).size !== priced.length ||
    priced.some(
      (item) =>
        !Number.isSafeInteger(item.unitMinor * item.quantity) ||
        item.unitMinor * item.quantity !== item.lineMinor,
    ) ||
    safeSum(priced.map((item) => item.lineMinor)) !== totals.subtotalMinor ||
    safeSum([totals.subtotalMinor, totals.taxMinor, totals.feeMinor, totals.tipMinor]) !==
      totals.totalMinor
  )
    throw new TransactionValidationError('invalid_quote');
  if (totals.totalMinor > intent.maxTotalMinor)
    throw new TransactionValidationError('budget_exceeded');
  if (
    quote.stock &&
    (priced.length !== 1 ||
      priced[0]?.id !== quote.stock.symbol ||
      priced[0]?.quantity !== quote.stock.quantity)
  )
    throw new TransactionValidationError('invalid_quote');
  return quote;
}

export async function validateTransactionSubmitArgs(
  raw: unknown,
  now: number,
): Promise<TransactionSubmitArgs> {
  const parsed = TransactionSubmitArgs.safeParse(raw);
  if (!parsed.success) throw new TransactionValidationError('invalid_args');
  validateTransactionQuote(parsed.data.quote, parsed.data.intent, now);
  if (parsed.data.quoteHash !== (await canonicalSha256(parsed.data.quote)))
    throw new TransactionValidationError('quote_hash_mismatch');
  return parsed.data;
}
