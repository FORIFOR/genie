import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CHECKOUT_SERVICES, CheckoutHandoffResult } from '@genie/contracts';
import { CheckoutAssistanceRuntime, nativeCheckoutOpener } from '../dist/checkout-assistance.js';
import { checkoutAssistanceRequest } from '../../../services/conversation/dist/checkout-request.js';
import { planTask } from '../../../services/task/dist/plan.js';
import { formatCheckoutArtifact } from '../../../services/task/dist/checkout-artifact.js';

const step = (service = 'dominos_jp', extra = {}) => ({
  id: 'handoff-1',
  toolId: 'checkout.open',
  approval: null,
  args: { service },
  ...extra,
});
test('both official services request foreground navigation using fixed executable/HTTPS URLs only', async () => {
  for (const service of ['mcdelivery_jp', 'dominos_jp']) {
    const calls = [];
    const opener = nativeCheckoutOpener('darwin', async (...args) => {
      calls.push(args);
      return { stdout: '', stderr: '' };
    });
    const result = await new CheckoutAssistanceRuntime(opener).run(step(service));
    assert.equal(result.ok, true);
    assert.deepEqual(calls[0].slice(0, 2), [
      '/usr/bin/open',
      ['-u', CHECKOUT_SERVICES[service].url],
    ]);
    assert.equal(calls[0][2].timeout, 10000);
    assert.equal(CheckoutHandoffResult.parse(result.result).navigation, 'requested');
    assert.equal(result.result.orderStatus, 'not_submitted');
    assert.equal(result.result.prepared, false);
    assert.equal(result.result.authentication, 'not_checked');
    assert.equal(result.result.receipt, 'not_checked');
    assert.equal(result.result.automatedCheckout, 'unsupported');
    assert.equal(result.result.browserOpened, undefined);
  }
});
test('caller URLs, schemes, provider spoofing and submit instructions never reach OS', async () => {
  let calls = 0;
  const runtime = new CheckoutAssistanceRuntime({
    request: async () => {
      calls++;
    },
  });
  for (const args of [
    { service: 'dominos_jp', url: 'https://evil.example' },
    { service: 'dominos_jp', url: 'javascript:alert(1)' },
    { service: 'dominos_jp', url: 'file:///tmp/example' },
    { service: 'https://internetorder.dominos.jp/delivery' },
    { service: 'mcdelivery_jp', submit: true },
    { service: 'stock_paper' },
  ])
    assert.equal(
      (await runtime.run(step(undefined, { args }))).error.code,
      'checkout.invalid_args',
    );
  assert.equal(calls, 0);
  assert.equal(runtime.handles('transaction.submit'), false);
  assert.equal(runtime.handles('computer.run'), false);
  assert.equal((await runtime.run(step(undefined, { toolId: 'transaction.submit' }))).ok, false);
  assert.equal(calls, 0);
});
test('spawn/timeout failures keep unknown navigation separate from a definitely unsubmitted order', async () => {
  for (const error of [new Error('spawn ENOENT'), new Error('timeout')]) {
    const runtime = new CheckoutAssistanceRuntime({
      request: async () => {
        throw error;
      },
    });
    const result = await runtime.run(step());
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'checkout.open_unconfirmed');
    assert.equal(CheckoutHandoffResult.parse(result.result).navigation, 'request_unconfirmed');
    assert.equal(result.result.orderStatus, 'not_submitted');
    assert.equal(result.result.prepared, false);
  }
});
test('pre-cancel sends nothing and cancellation after OS acceptance never claims visible page', async () => {
  const before = new AbortController();
  before.abort();
  let calls = 0;
  const runtime = new CheckoutAssistanceRuntime({
    request: async () => {
      calls++;
    },
  });
  assert.equal((await runtime.run(step(), before.signal)).ok, false);
  assert.equal(calls, 0);
  const during = new AbortController();
  const aborted = await new CheckoutAssistanceRuntime({
    request: async () => {
      during.abort();
    },
  }).run(step(), during.signal);
  assert.equal(aborted.result.navigation, 'request_unconfirmed');
  assert.equal(aborted.result.orderStatus, 'not_submitted');
});
test('unsupported OS refuses without launching a generic fallback', async () => {
  let calls = 0;
  const opener = nativeCheckoutOpener('linux', async () => {
    calls++;
    return { stdout: '', stderr: '' };
  });
  const result = await new CheckoutAssistanceRuntime(opener).run(step());
  assert.equal(result.ok, false);
  assert.equal(result.result.prepared, false);
  assert.equal(calls, 0);
});
test('task re-use remains a site handoff and cannot upgrade to a paid order', async () => {
  let calls = 0;
  const runtime = new CheckoutAssistanceRuntime({
    request: async () => {
      calls++;
    },
  });
  for (let i = 0; i < 2; i++) {
    const out = await runtime.run(step());
    assert.equal(out.result.orderStatus, 'not_submitted');
    assert.equal(out.result.automatedCheckout, 'unsupported');
  }
  assert.equal(calls, 2); // Only navigation may repeat. No order API or generic computer runner exists here.
});
test('recognized request reaches task plan, host and truthful artifact without any checkout driver', async () => {
  const service = checkoutAssistanceRequest('ドミノでピザを注文して');
  assert.equal(service, 'dominos_jp');
  const plan = planTask('checkout.assist', { service });
  const calls = [];
  const runtime = new CheckoutAssistanceRuntime({
    request: async (selected) => {
      calls.push(selected);
    },
  });
  const outcome = await runtime.run({ ...plan.steps[0], id: 'home-step', approval: null });
  const artifact = formatCheckoutArtifact('checkout.assist', { service }, [outcome.result]);
  assert.deepEqual(calls, ['dominos_jp']);
  assert.match(artifact.title, /未注文/);
  assert.match(artifact.markdown, /カートの準備も行っていません/);
  assert.equal(outcome.result.orderStatus, 'not_submitted');
  assert.equal(outcome.result.prepared, false);
});
