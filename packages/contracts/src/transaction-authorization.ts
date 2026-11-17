/** Experimental bounded consent. Issuing it requires an explicit human API action. */
import { z } from 'zod';
import { canonicalJson } from './canonical.js';
import { Timestamp } from './primitives.js';
import { TransactionIntent, validateTransactionSubmitArgs } from './transaction.js';

const Minor = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const MAX_TRANSACTION_AUTHORIZATION_TTL_MS = 30 * 24 * 60 * 60_000;
export const TransactionAuthorizationScope = z
  .object({
    kind: TransactionIntent.shape.kind,
    mode: z.literal('simulation'),
    provider: TransactionIntent.shape.provider,
    account: TransactionIntent.shape.account,
    currency: TransactionIntent.shape.currency,
    destination: TransactionIntent.shape.destination,
    paymentMethodRef: TransactionIntent.shape.paymentMethodRef,
    requestedTime: TransactionIntent.shape.requestedTime,
    stock: TransactionIntent.shape.stock,
    items: TransactionIntent.shape.items,
  })
  .strict()
  .refine(
    (value) =>
      value.kind === 'stock_paper'
        ? value.stock !== undefined && value.requestedTime === undefined
        : value.stock === undefined && value.requestedTime !== undefined,
    'Scope must preserve all delivery or paper stock terms',
  );
export type TransactionAuthorizationScope = z.infer<typeof TransactionAuthorizationScope>;

export const TransactionAuthorizationSpec = z
  .object({
    scope: TransactionAuthorizationScope,
    maxPerOrderMinor: Minor,
    maxTotalMinor: Minor,
    maxOrders: z.number().int().min(1).max(1000),
    expiresAt: Timestamp,
  })
  .strict()
  .refine(
    (value) => value.maxPerOrderMinor <= value.maxTotalMinor,
    'The per-order limit cannot exceed the total budget',
  );
export type TransactionAuthorizationSpec = z.infer<typeof TransactionAuthorizationSpec>;

export const TransactionAuthorization = z
  .object({
    id: z.uuid(),
    createdBy: z.uuid(),
    createdAt: Timestamp,
    status: z.enum(['ACTIVE', 'REVOKED']),
    revokedAt: Timestamp.nullable(),
    spec: TransactionAuthorizationSpec,
    usedOrders: z.number().int().nonnegative().max(1000),
    usedTotalMinor: Minor,
  })
  .strict();
export type TransactionAuthorization = z.infer<typeof TransactionAuthorization>;

export function transactionAuthorizationScope(
  intent: TransactionIntent,
): TransactionAuthorizationScope {
  const { orderKey: _key, maxTotalMinor: _budget, ...scope } = intent;
  return TransactionAuthorizationScope.parse(scope);
}

export type TransactionAuthorizationEvaluation =
  | { allowed: true; amountMinor: number }
  | {
      allowed: false;
      reason: 'expired' | 'scope_changed' | 'per_order_limit' | 'order_limit' | 'total_limit';
    };

/** Invalid quotes fail; a valid order outside a grant requires a new user decision. */
export async function evaluateTransactionAuthorization(
  rawSpec: unknown,
  rawArgs: unknown,
  usage: { usedOrders: number; usedTotalMinor: number },
  now: number,
): Promise<TransactionAuthorizationEvaluation> {
  const spec = TransactionAuthorizationSpec.parse(rawSpec);
  const args = await validateTransactionSubmitArgs(rawArgs, now);
  z.object({ usedOrders: z.number().int().nonnegative(), usedTotalMinor: Minor })
    .strict()
    .parse(usage);
  if (Date.parse(spec.expiresAt) <= now) return { allowed: false, reason: 'expired' };
  const { orderKey: _key, maxTotalMinor: _budget, ...scope } = args.intent;
  if (canonicalJson(scope) !== canonicalJson(spec.scope))
    return { allowed: false, reason: 'scope_changed' };
  const amountMinor = args.quote.totals.totalMinor;
  if (amountMinor > spec.maxPerOrderMinor || args.intent.maxTotalMinor > spec.maxPerOrderMinor)
    return { allowed: false, reason: 'per_order_limit' };
  if (usage.usedOrders >= spec.maxOrders) return { allowed: false, reason: 'order_limit' };
  // Subtraction avoids overflowing safe integer arithmetic when adding another order.
  if (amountMinor > spec.maxTotalMinor - usage.usedTotalMinor)
    return { allowed: false, reason: 'total_limit' };
  return { allowed: true, amountMinor };
}
