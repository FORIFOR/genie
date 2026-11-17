import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ComputerVisionRuntime } from '../dist/computer-vision.js';
import { decisionOf, VisionFailure } from '../dist/computer-vision-policy.js';
import { visionPromptFor } from '../dist/computer-vision-prompts.js';

const now = Date.now();
const origin = 'https://www.mcdonalds.co.jp';
const frame = {
  id: 'cv-00000000-0000-4000-8000-000000000001',
  bundleId: 'com.apple.Safari',
  pid: 42,
  windowId: 10,
  capturedAt: now,
  width: 1000,
  height: 500,
  bounds: { x: 0, y: 0, width: 1000, height: 500 },
  sha256: 'a'.repeat(64),
  deliveryMode: 'background',
  backgroundSession: 's',
  documentOrigin: origin,
  allowedOrigins: [origin],
};
const approval = {
  approvalId: 'a',
  operationId: 'computer.run',
  decision: 'APPROVED',
  decidedBy: 'user',
  decidedAt: new Date(now - 1000).toISOString(),
  expiresAt: new Date(now + 600_000).toISOString(),
};
const reference = '838f307e-0086-403e-b5ce-89e3e52afcb3';
function harness(options = {}) {
  const calls = [];
  const device = {
    async claim() {},
    async begin() {
      if (options.beginError) throw options.beginError;
      return frame;
    },
    async capture() {
      calls.push('capture');
      throw Error('No capture after credential preparation');
    },
    async apply() {
      calls.push('apply');
      throw Error('No generic input');
    },
    async prepareRegistration(scope, signal, expiry) {
      calls.push('native');
      assert.equal(scope.id, frame.id);
      assert.equal(expiry, Date.parse(approval.expiresAt));
      if (options.nativeError) throw options.nativeError;
      return { credentialRef: options.reference ?? reference };
    },
    async close() {
      calls.push('close');
    },
  };
  const runtime = new ComputerVisionRuntime({
    enabled: true,
    selectModel: async () => 'local',
    allowExternalPixels: false,
    device: () => device,
    now: () => now,
    model: {
      async run(step) {
        calls.push('model');
        return {
          ok: true,
          result: {
            action: options.action ?? 'register',
            frameId: frame.id,
            reason: 'Empty registration form visible',
          },
        };
      },
    },
  });
  return {
    calls,
    run: (args = {}) =>
      runtime.run({
        id: 'registration-fixture',
        toolId: 'computer.run',
        approval,
        args: {
          goal: 'Prepare registration',
          allowedOrigins: [origin],
          registrationAssist: true,
          ...args,
        },
      }),
  };
}
test('selection cancellation and vanished targets explain why preparation never began', async () => {
  for (const [code, message] of [
    ['user_cancelled', /確認がキャンセル/],
    ['target_changed', /選んだ窓が閉じた/],
    ['document_origin_target_unavailable', /操作できる公式サイトの窓/],
    ['origin_provider_consent_required', /外部モデルへ送る確認/],
  ]) {
    const h = harness({ beginError: new VisionFailure(code) });
    const result = await h.run();
    assert.equal(result.ok, false);
    assert.equal(result.error.code, `computer.vision.${code}`);
    assert.match(result.error.message, message);
    assert.deepEqual(h.calls, ['close']);
    assert.deepEqual(result.result.audit, []);
  }
});
test('native preparation ends the visual run without photographing or claiming account creation', async () => {
  const h = harness();
  const result = await h.run();
  assert.equal(result.ok, true);
  assert.equal(result.result.completed, false);
  assert.equal(result.result.status, 'awaiting_user_registration');
  assert.deepEqual(result.result.registration, { credentialRef: reference });
  assert.deepEqual(h.calls, ['model', 'native', 'close']);
});
test('a model cannot activate native registration outside the explicit plan', async () => {
  const h = harness();
  const result = await h.run({ registrationAssist: undefined });
  assert.equal(result.ok, false);
  assert.match(result.error.code, /registration_not_authorized/);
  assert.deepEqual(h.calls, ['model', 'close']);
});
test('unsupported or unbound registration origins stop before capture/model/native work', async () => {
  for (const allowedOrigins of [
    undefined,
    [],
    ['https://other.example'],
    [origin, 'https://other.example'],
  ]) {
    const h = harness();
    const result = await h.run({ allowedOrigins });
    assert.equal(result.ok, false);
    assert.deepEqual(h.calls, []);
  }
});
test('a visual done cannot substitute for native preparation', async () => {
  const h = harness({ action: 'done' });
  const result = await h.run();
  assert.equal(result.ok, false);
  assert.match(result.error.code, /registration_not_prepared/);
  assert.deepEqual(h.calls, ['model', 'close']);
});
test('an invalid native result is rejected with no further capture or retry', async () => {
  const h = harness({ reference: 'not-a-reference' });
  const result = await h.run();
  assert.equal(result.ok, false);
  assert.match(result.error.code, /registration_result_invalid/);
  assert.deepEqual(h.calls, ['model', 'native', 'close']);
});
test('register cannot carry generated secrets or generic text fields', () => {
  for (const added of [
    { text: 'not-a-real-password' },
    { password: 'not-a-real-password' },
    { target: [1, 2, 3, 4] },
  ]) {
    assert.throws(() => decisionOf({ action: 'register', reason: 'visible', ...added }, frame));
  }
  const prompt = visionPromptFor('llm.plan_computer_action', { registrationAssist: true });
  assert.match(prompt, /native process/);
  assert.match(prompt, /Do not accept terms/);
});
test('lost native acknowledgement preserves an unknown effect and never retries', async () => {
  const h = harness({ nativeError: new VisionFailure('helper_unavailable') });
  const result = await h.run();
  assert.equal(result.ok, false);
  assert.match(result.error.message, /一部が届いている場合/);
  assert.equal(result.result.audit.at(-1).delivery, 'unknown');
  assert.deepEqual(h.calls, ['model', 'native', 'close']);
});
test('native cancellation before storage does not claim an input was sent', async () => {
  const h = harness({ nativeError: new VisionFailure('registration_cancelled') });
  const result = await h.run();
  assert.equal(result.ok, false);
  assert.equal(result.result.audit.length, 0);
  assert.doesNotMatch(result.error.message, /すでに|一部が届いて/);
});
