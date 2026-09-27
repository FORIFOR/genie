import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
const base = process.env.GENIE_VISION_TEST_DIST
  ? pathToFileURL(path.resolve(process.env.GENIE_VISION_TEST_DIST) + '/').href
  : new URL('../dist/', import.meta.url).href;
const { CloudModelBudget, CloudBudgetError } = await import(new URL('cloud-vision-budget.js', base));
const { ComputerVisionRuntime } = await import(new URL('computer-vision.js', base));
const { VisionFailure } = await import(new URL('computer-vision-policy.js', base));

const ledgerPath = () => join(mkdtempSync(join(tmpdir(), 'genie-budget-')), 'ledger.json');
const march = Date.UTC(2026, 2, 15);
const april = Date.UTC(2026, 3, 1);

test('a run is free-tier only unless paid is explicitly turned on', () => {
  const budget = new CloudModelBudget({ statePath: ledgerPath(), now: () => march });
  assert.equal(budget.tier, 'free');
  assert.equal(new CloudModelBudget({ statePath: ledgerPath(), tier: 'paid' }).tier, 'paid');
});
// 「無料枠のみ」は、鍵が無料枠の鍵であって初めて意味がある。
test('a key from a billed project is not treated as the free tier', () => {
  const budget = new CloudModelBudget({ statePath: ledgerPath(), billedProject: true, now: () => march });
  assert.throws(() => budget.authorize(), (e) => e.code === 'billed_project_not_free');
  const paid = new CloudModelBudget({ statePath: ledgerPath(), billedProject: true, tier: 'paid', now: () => march });
  assert.doesNotThrow(() => paid.authorize());
});
test('once the provider says the allowance is gone, the month stops asking', () => {
  const statePath = ledgerPath();
  const budget = new CloudModelBudget({ statePath, now: () => march });
  budget.authorize();
  budget.exhausted();
  assert.throws(() => budget.authorize(), (e) => e.code === 'free_quota_exhausted');
  // 別の走行（別のインスタンス）でも、同じ月なら掛けない。
  assert.throws(
    () => new CloudModelBudget({ statePath, now: () => march }).authorize(),
    (e) => e.code === 'free_quota_exhausted',
  );
  // 月が変われば数え直す。使い切った印は前の月のものとして残る。
  assert.doesNotThrow(() => new CloudModelBudget({ statePath, now: () => april }).authorize());
});
test('per-task and per-month call limits stop before the call, not after', () => {
  const statePath = ledgerPath();
  const budget = new CloudModelBudget({ statePath, taskCallLimit: 2, monthlyCallLimit: 3, now: () => march });
  budget.beginTask();
  budget.authorize(); budget.record();
  budget.authorize(); budget.record();
  assert.throws(() => budget.authorize(), (e) => e.code === 'task_call_limit');
  budget.beginTask();
  budget.authorize(); budget.record();
  budget.beginTask();
  assert.throws(() => budget.authorize(), (e) => e.code === 'month_call_limit');
});
test('cost limits are judged including the call about to be made', () => {
  const budget = new CloudModelBudget({
    statePath: ledgerPath(), tier: 'paid', pricePerCallUsd: 0.4,
    taskCostLimitUsd: 1, monthlyCostLimitUsd: 10, now: () => march,
  });
  budget.beginTask();
  budget.authorize(); budget.record();
  budget.authorize(); budget.record();
  // 3 回目で 1.2 ドル。上限 1 ドルを越えるので、掛ける前に止める。
  assert.throws(() => budget.authorize(), (e) => e.code === 'task_cost_limit');
});
test('the ledger keeps no key and no screen content, and is owner-only', () => {
  const statePath = ledgerPath();
  const budget = new CloudModelBudget({ statePath, pricePerCallUsd: 0.01, now: () => march });
  budget.record();
  const saved = readFileSync(statePath, 'utf8');
  assert.deepEqual(Object.keys(JSON.parse(saved)).sort(), ['calls', 'costUsd', 'month']);
  assert.equal(statSync(statePath).mode & 0o077, 0);
});
test('a corrupt ledger does not become free rein', () => {
  const statePath = ledgerPath();
  writeFileSync(statePath, 'not json');
  const budget = new CloudModelBudget({ statePath, monthlyCallLimit: 1, now: () => march });
  budget.authorize(); budget.record();
  assert.throws(() => budget.authorize(), (e) => e.code === 'month_call_limit');
});

/* ここから下は、歯止めが**走行の経路に本当に挟まっている**ことの確認。 */
function cloudHarness(budget, decide) {
  const frame = (n) => ({
    id: `cv-00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
    bundleId: 'test.app', pid: 42, windowId: 10, capturedAt: Date.now(),
    width: 1000, height: 500, bounds: { x: 0, y: 0, width: 1000, height: 500 },
    sha256: String(n).padStart(64, '0'),
  });
  let n = 1, calls = 0;
  return {
    stats: () => ({ calls }),
    runtime: new ComputerVisionRuntime({
      enabled: true,
      model: { async run(step) { calls++; return decide(step); } },
      selectModel: async () => 'gemini_api',
      allowExternalPixels: true,
      device: () => ({
        async claim() {},
        async begin() { return frame(n); },
        async capture() { return frame(++n); },
        async apply() { return {}; },
        async close() {},
      }),
      ...(budget ? { budget } : {}),
    }),
  };
}
const step = () => ({
  id: `r-${Math.random()}`, toolId: 'computer.run', args: { goal: 'Open the panel' },
  approval: {
    approvalId: 'a', operationId: 'computer.run', decision: 'APPROVED', decidedBy: 'user',
    decidedAt: new Date(Date.now() - 1000).toISOString(),
    expiresAt: new Date(Date.now() + 600_000).toISOString(),
  },
});
// 歯止めの設定が無いままクラウドへ画面を出さない。
test('a cloud model without a budget never sends a screenshot', async () => {
  const h = cloudHarness(undefined, () => ({ ok: true, result: {} }));
  assert.match((await h.runtime.run(step())).error.code, /budget_required/);
  assert.equal(h.stats().calls, 0);
});
test('an exhausted month refuses before the first model call', async () => {
  const statePath = ledgerPath();
  const budget = new CloudModelBudget({ statePath });
  budget.exhausted();
  const h = cloudHarness(budget, () => ({ ok: true, result: {} }));
  assert.match((await h.runtime.run(step())).error.code, /free_quota_exhausted/);
  assert.equal(h.stats().calls, 0);
});
// 提供元が「使い切った」と言ったら、その走行で掛け直さない。次の走行も掛けない。
test('a provider quota refusal stops the run and the month', async () => {
  const statePath = ledgerPath();
  const budget = new CloudModelBudget({ statePath });
  const h = cloudHarness(budget, () => ({ ok: false, error: { code: 'llm.quota_exhausted' } }));
  assert.match((await h.runtime.run(step())).error.code, /free_quota_exhausted/);
  assert.equal(h.stats().calls, 1);
  assert.throws(() => new CloudModelBudget({ statePath }).authorize(), (e) => e.code === 'free_quota_exhausted');
});
test('a local model needs no budget and is never counted', async () => {
  const statePath = ledgerPath();
  const budget = new CloudModelBudget({ statePath });
  const frame = { id: 'x' };
  const h = {
    runtime: new ComputerVisionRuntime({
      enabled: true,
      model: { async run() { return { ok: false, error: { code: 'model_failed' } }; } },
      selectModel: async () => 'local',
      allowExternalPixels: false,
      device: () => ({
        async claim() {}, async begin() { return { ...frame }; },
        async capture() { return { ...frame }; }, async apply() { return {}; }, async close() {},
      }),
      budget,
    }),
  };
  await h.runtime.run(step());
  assert.equal(budget.usage().monthCalls, 0);
});
