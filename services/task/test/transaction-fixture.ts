import { canonicalSha256 } from '@genie/contracts';
import { planTask, withTransactionQuote } from '../src/plan.js';

export const NOW = new Date('2026-10-01T10:00:00.000Z');
export async function transactionFixture() {
  const intent = {
    kind: 'delivery',
    mode: 'simulation',
    provider: 'delivery-sim',
    account: 'test-account',
    orderKey: 'order-1',
    currency: 'JPY',
    destination: { id: 'home', label: 'テストの配送先' },
    paymentMethodRef: 'test-card',
    requestedTime: 'asap',
    items: [{ id: 'curry', label: 'カレー', quantity: 2, options: ['辛口'] }],
    maxTotalMinor: 3000,
  };
  const { maxTotalMinor: _max, ...contents } = intent;
  const quote = {
    ...contents,
    quoteId: 'quote-1',
    items: [{ ...intent.items[0]!, unitMinor: 1000, lineMinor: 2000 }],
    totals: { subtotalMinor: 2000, taxMinor: 200, feeMinor: 100, tipMinor: 50, totalMinor: 2350 },
    expiresAt: '2026-10-01T10:02:00.000Z',
  };
  const quoteHash = await canonicalSha256(quote);
  const submitArgs = { intent, quote, quoteHash };
  const prepared = { quote, quoteHash, submitArgs };
  const plan = planTask('transaction.order', { intent });
  const step = withTransactionQuote(plan.steps[1]!, plan.steps, [prepared]);
  const result = {
    mode: intent.mode,
    provider: intent.provider,
    account: intent.account,
    orderKey: intent.orderKey,
    quoteHash,
    status: 'accepted',
    observation: {
      mode: intent.mode,
      provider: intent.provider,
      account: intent.account,
      orderKey: intent.orderKey,
      quoteHash,
      status: 'accepted',
      providerOrderId: 'receipt-1',
      observedAt: NOW.toISOString(),
      details: {
        currency: quote.currency,
        totalMinor: quote.totals.totalMinor,
        destinationId: quote.destination.id,
        paymentMethodRef: quote.paymentMethodRef,
        requestedTime: quote.requestedTime,
        items: quote.items,
      },
    },
  };
  return { intent, quote, quoteHash, submitArgs, prepared, plan, step, result };
}

export async function paperStockFixture() {
  const base = await transactionFixture();
  const { requestedTime: _time, ...delivery } = base.intent;
  const stock = {
    symbol: 'TEST',
    market: 'SIM',
    side: 'BUY',
    quantity: 2,
    orderType: 'LIMIT',
    limitPriceMinor: 5000,
    timeInForce: 'DAY',
  };
  const intent = {
    ...delivery,
    kind: 'stock_paper',
    provider: 'stock-sim',
    account: 'paper-account',
    destination: { id: 'paper-account', label: '模擬口座' },
    paymentMethodRef: 'paper-cash',
    items: [{ id: 'TEST', label: '模擬株式', quantity: 2, options: [] }],
    maxTotalMinor: 20000,
    stock,
  };
  const { maxTotalMinor: _max, ...contents } = intent;
  const quote = {
    ...contents,
    quoteId: 'stock-quote',
    items: [{ ...intent.items[0]!, unitMinor: 5000, lineMinor: 10000 }],
    totals: { subtotalMinor: 10000, taxMinor: 0, feeMinor: 100, tipMinor: 0, totalMinor: 10100 },
    expiresAt: base.quote.expiresAt,
  };
  const quoteHash = await canonicalSha256(quote);
  const submitArgs = { intent, quote, quoteHash },
    prepared = { quote, quoteHash, submitArgs };
  const plan = planTask('transaction.order', { intent }),
    step = withTransactionQuote(plan.steps[1]!, plan.steps, [prepared]);
  const observation = {
    mode: intent.mode,
    provider: intent.provider,
    account: intent.account,
    orderKey: intent.orderKey,
    quoteHash,
    status: 'filled',
    providerOrderId: 'paper-receipt',
    observedAt: NOW.toISOString(),
    details: {
      currency: quote.currency,
      totalMinor: quote.totals.totalMinor,
      destinationId: quote.destination.id,
      paymentMethodRef: quote.paymentMethodRef,
      stock,
      items: quote.items,
    },
    fills: [{ executionId: 'paper-fill', quantity: 2, priceMinor: 4990 }],
  };
  const result = {
    mode: intent.mode,
    provider: intent.provider,
    account: intent.account,
    orderKey: intent.orderKey,
    quoteHash,
    status: observation.status,
    observation,
  };
  return { intent, quote, quoteHash, submitArgs, prepared, plan, step, result };
}
