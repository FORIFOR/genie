import { describe, expect, it } from 'vitest';
import { canonicalSha256 } from '../src/canonical.js';
import { simulationOrderIntent } from '../src/transaction-simulation.js';
import {
  TransactionAuthorizationSpec,
  evaluateTransactionAuthorization,
  transactionAuthorizationScope,
} from '../src/transaction-authorization.js';

const now = Date.parse('2026-10-02T00:00:00Z');
async function fixture(kind: 'pizza' | 'stock' = 'pizza') {
  const intent = simulationOrderIntent(kind, 'order-1');
  const { maxTotalMinor: _max, items, ...contents } = intent;
  const quote = {
    ...contents,
    quoteId: 'quote-1',
    items: items.map((item) => ({ ...item, unitMinor: 100, lineMinor: item.quantity * 100 })),
    totals: {
      subtotalMinor: items[0]!.quantity * 100,
      taxMinor: 0,
      feeMinor: 0,
      tipMinor: 0,
      totalMinor: items[0]!.quantity * 100,
    },
    expiresAt: new Date(now + 60_000).toISOString(),
  };
  const args = { intent, quote, quoteHash: await canonicalSha256(quote) };
  const spec = {
    scope: transactionAuthorizationScope(intent),
    maxPerOrderMinor: intent.maxTotalMinor,
    maxTotalMinor: 3000,
    maxOrders: 2,
    expiresAt: new Date(now + 3600_000).toISOString(),
  };
  return { args, spec };
}
const empty = { usedOrders: 0, usedTotalMinor: 0 };
describe('bounded transaction authorization evaluator', () => {
  it('requires both a valid exact quote and the explicitly granted scope', async () => {
    const { args, spec } = await fixture();
    expect(await evaluateTransactionAuthorization(spec, args, empty, now)).toEqual({
      allowed: true,
      amountMinor: 100,
    });
    for (const changed of [
      { ...spec.scope, provider: 'another' },
      { ...spec.scope, account: 'another' },
      { ...spec.scope, currency: 'USD' },
      { ...spec.scope, destination: { ...spec.scope.destination, id: 'another' } },
      { ...spec.scope, paymentMethodRef: 'another' },
      { ...spec.scope, requestedTime: new Date(now + 3600_000).toISOString() },
      { ...spec.scope, items: spec.scope.items.map((item) => ({ ...item, quantity: 2 })) },
      {
        ...spec.scope,
        items: spec.scope.items.map((item) => ({ ...item, options: ['different'] })),
      },
    ])
      expect(
        await evaluateTransactionAuthorization({ ...spec, scope: changed }, args, empty, now),
      ).toEqual({ allowed: false, reason: 'scope_changed' });
    await expect(
      evaluateTransactionAuthorization(spec, { ...args, quoteHash: '0'.repeat(64) }, empty, now),
    ).rejects.toThrow('quote_hash_mismatch');
  });
  it('keeps per-order, total, count and expiry boundaries separate without unsafe arithmetic', async () => {
    const { args, spec } = await fixture();
    expect(
      await evaluateTransactionAuthorization({ ...spec, maxPerOrderMinor: 99 }, args, empty, now),
    ).toMatchObject({ allowed: false, reason: 'per_order_limit' });
    expect(
      await evaluateTransactionAuthorization(spec, args, { usedOrders: 2, usedTotalMinor: 0 }, now),
    ).toMatchObject({ allowed: false, reason: 'order_limit' });
    expect(
      await evaluateTransactionAuthorization(
        spec,
        args,
        { usedOrders: 1, usedTotalMinor: 2950 },
        now,
      ),
    ).toMatchObject({ allowed: false, reason: 'total_limit' });
    expect(
      await evaluateTransactionAuthorization(
        { ...spec, expiresAt: new Date(now).toISOString() },
        args,
        empty,
        now,
      ),
    ).toMatchObject({ allowed: false, reason: 'expired' });
    expect(
      await evaluateTransactionAuthorization(
        { ...spec, maxTotalMinor: Number.MAX_SAFE_INTEGER },
        args,
        { usedOrders: 1, usedTotalMinor: Number.MAX_SAFE_INTEGER - 99 },
        now,
      ),
    ).toMatchObject({ allowed: false, reason: 'total_limit' });
    for (const bad of [
      { ...spec, maxOrders: 0 },
      { ...spec, maxOrders: 1.1 },
      { ...spec, maxTotalMinor: Number.MAX_SAFE_INTEGER + 1 },
      { ...spec, maxPerOrderMinor: 0.5 },
      { ...spec, scope: { ...spec.scope, mode: 'live' } },
    ])
      expect(TransactionAuthorizationSpec.safeParse(bad).success).toBe(false);
  });
  it('paper stock constraints bind side, market, limit price, time-in-force and quantity', async () => {
    const { args, spec } = await fixture('stock');
    expect((await evaluateTransactionAuthorization(spec, args, empty, now)).allowed).toBe(true);
    for (const stock of [
      { ...spec.scope.stock!, side: 'SELL' },
      { ...spec.scope.stock!, market: 'other' },
      { ...spec.scope.stock!, limitPriceMinor: 99 },
      { ...spec.scope.stock!, timeInForce: 'IOC' },
      { ...spec.scope.stock!, quantity: 1 },
    ])
      expect(
        await evaluateTransactionAuthorization(
          { ...spec, scope: { ...spec.scope, stock } },
          args,
          empty,
          now,
        ),
      ).toMatchObject({ allowed: false, reason: 'scope_changed' });
  });
});
