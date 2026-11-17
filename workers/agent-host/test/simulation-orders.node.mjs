import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { simulationOrderIntent, canonicalSha256 } from '@genie/contracts';
import { SimulationOrders } from '../dist/simulation-orders.js';
import { TransactionRuntime } from '../dist/transaction-runtime.js';

async function harness(t, confirm) {
  const root = await mkdtemp(join(tmpdir(), 'genie-simulation-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const adapter = new SimulationOrders({ root: join(root, 'provider'), confirm });
  const config = {
    journalDir: join(root, 'journal'),
    adapters: [adapter],
    // This test runs on the real clock; open the paper market all day, every day.
    tradingLimits: {
      maxOrderValueMinor: 1_000_000,
      maxDailyLossMinor: 1_000_000,
      maxTradesPerDay: 100,
      maxPositionValueMinor: 1_000_000,
      sessions: [{ start: '00:00', end: '24:00' }],
      days: [0, 1, 2, 3, 4, 5, 6],
    },
  };
  return { adapter, config, runtime: new TransactionRuntime(config) };
}
const prepare = (runtime, intent) =>
  runtime.run({ id: 'prepare', toolId: 'transaction.prepare', args: { intent } });
async function submit(runtime, args) {
  return runtime.run({
    id: 'submit',
    toolId: 'transaction.submit',
    args,
    approval: {
      approvalId: 'a',
      operationId: 'transaction.submit',
      decision: 'APPROVED',
      decidedBy: 'test-human',
      decidedAt: new Date(Date.now() - 1000).toISOString(),
      expiresAt: new Date(Date.now() + 60000).toISOString(),
      inputsHash: await canonicalSha256(args),
    },
  });
}
test('both food demos and paper fill require independent persisted receipt; preparing never confirms', async (t) => {
  let confirmations = 0;
  const h = await harness(t, async (checkout) => {
    confirmations++;
    assert.deepEqual(
      JSON.parse(await readFile(join(checkout.directory, 'checkout.json'), 'utf8')),
      checkout,
    );
    await writeFile(join(checkout.directory, 'receipt.json'), JSON.stringify(checkout.candidate), {
      flag: 'wx',
      mode: 0o600,
    });
  });
  for (const kind of ['pizza', 'burger', 'stock']) {
    const intent = simulationOrderIntent(kind, `order-${kind}`);
    const prepared = await prepare(h.runtime, intent);
    assert.equal(prepared.ok, true);
    const before = confirmations;
    const repeated = await prepare(h.runtime, intent);
    assert.deepEqual(prepared.result, repeated.result);
    assert.equal(confirmations, before);
    const out = await submit(h.runtime, prepared.result.submitArgs);
    assert.equal(out.ok, true, JSON.stringify(out));
    assert.equal(out.result.status, kind === 'stock' ? 'filled' : 'accepted');
    assert.equal(out.result.observation.details.paymentMethodRef, 'demo-no-charge');
    const retry = await submit(new TransactionRuntime(h.config), prepared.result.submitArgs);
    assert.equal(retry.ok, true);
    assert.equal(confirmations, before + 1);
  }
});
test('unconfirmed click stays unknown across runtime restart and never clicks again', async (t) => {
  let confirmations = 0;
  const h = await harness(t, async () => {
    confirmations++;
  });
  const p = await prepare(h.runtime, simulationOrderIntent('pizza', 'missing-receipt'));
  const first = await submit(h.runtime, p.result.submitArgs);
  assert.equal(first.error.code, 'transaction.result_unknown');
  const retry = await submit(new TransactionRuntime(h.config), p.result.submitArgs);
  assert.equal(retry.error.code, 'transaction.result_unknown');
  assert.equal(confirmations, 1);
});
test('fictional catalog cannot be used for live identities, custom items, or prices above the supplied budget', async (t) => {
  const h = await harness(t, async () => assert.fail('must not confirm'));
  const base = simulationOrderIntent('pizza', 'refused');
  for (const patch of [
    { mode: 'live' },
    { account: 'real' },
    { maxTotalMinor: 1 },
    { items: [{ ...base.items[0], id: 'real-pizza' }] },
  ]) {
    assert.equal((await prepare(h.runtime, { ...base, ...patch })).ok, false);
  }
});
