import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs, perform, client, readiness } from '../computer-use.mjs';
const record = () => ({
  version: 1,
  key: '11111111-1111-4111-8111-111111111111',
  request: { kind: 'computer.run', input: { goal: 'draft', successCriteria: 'text visible' } },
  taskId: null,
});
test('requires goal, criteria, durable run file and explicit approval ID', () => {
  for (const args of [
    ['start'],
    ['start', '--goal', 'draft', '--run-file', 'x'],
    ['approve', '--run-file', 'x'],
  ])
    assert.throws(() => parseArgs(args));
  assert.equal(
    parseArgs(['start', '--goal', 'draft', '--criteria', 'visible', '--run-file', 'x']).goal,
    'draft',
  );
});
test('lost acceptance response: explicit recover reuses identical key and request, never approves', async () => {
  const r = record(),
    calls = [];
  let n = 0;
  const req = async (...args) => {
    calls.push(args);
    if (n++ === 0) throw Error('lost');
    return { id: 't', status: 'WAITING_APPROVAL' };
  };
  await assert.rejects(perform('start', r, req));
  assert.equal(r.taskId, null);
  await perform('recover', r, req);
  assert.equal(r.taskId, 't');
  assert.deepEqual(calls[0], calls[1]);
  assert.equal(calls.length, 2);
  assert.equal(calls[0][0], '/v1/tasks');
});
test('status and recover with known identity only read; missing identity never posts', async () => {
  const r = record(),
    calls = [];
  const req = async (...args) => {
    calls.push(args);
    return { id: 't', status: 'RUNNING' };
  };
  await assert.rejects(perform('status', r, req));
  assert.equal(calls.length, 0);
  r.taskId = 't';
  await perform('recover', r, req);
  await perform('status', r, req);
  assert.deepEqual(calls, [['/v1/tasks/t'], ['/v1/tasks/t']]);
});
test('approval belongs to current computer task and matching pending approval', async () => {
  const r = { ...record(), taskId: 't' },
    calls = [];
  const req = async (path, method, body) => {
    calls.push([path, method, body]);
    return path.endsWith('/approvals')
      ? { items: [{ id: 'a' }] }
      : { kind: 'computer.run', status: 'WAITING_APPROVAL' };
  };
  await assert.rejects(perform('approve', r, req, 'wrong'));
  assert.ok(calls.every((c) => c[1] !== 'POST'));
  const result = await perform('approve', r, req, 'a');
  assert.equal(result.status, 'APPROVAL_SENT');
  assert.deepEqual(calls.at(-1), [
    '/v1/tasks/t/approve',
    'POST',
    { approval_id: 'a', decision: 'APPROVED' },
  ]);
});
test('cancel only requests cancellation on same task, no success assertion', async () => {
  const r = { ...record(), taskId: 't' },
    calls = [];
  const result = await perform('cancel', r, async (...args) => {
    calls.push(args);
    return { status: 'CANCELLING' };
  });
  assert.equal(result.status, 'CANCELLING');
  assert.equal(calls[0][0], '/v1/tasks/t/cancel');
});
test('transport blocks redirects and does not retry errors', async () => {
  let calls = 0;
  const req = client('http://127.0.0.1:43123', 'local', async (url, opt) => {
    calls++;
    assert.equal(opt.redirect, 'error');
    return { ok: false, status: 500 };
  });
  await assert.rejects(req('/v1/tasks', 'POST', record().request, 'saved-key'));
  assert.equal(calls, 1);
});

const configuration = { project: 'owned-preview', model: 'gpt-6-sol', modelProvider: 'codex' };
const runningComputer = () => ({
  ...configuration,
  phase: 'ready',
  computerUse: true,
  computerDelivery: 'background',
  computerHelperUnattendedTest: false,
  computerHelper: {
    path: '/private/owned/Final.app/Contents/MacOS/Helper',
    error: null,
    status: { ready: true, deliveryMode: 'background', unattendedTest: false },
  },
  externalScreenAllowed: true,
  recipient: 'OpenAI / Codex: gpt-6-sol',
});
test('check uses the actual running helper and explicit screen recipient', () => {
  const control = runningComputer();
  const result = readiness(control, configuration);
  assert.equal(result.ready, true);
  assert.equal(result.helperPath, control.computerHelper.path);
  assert.deepEqual(result.permissions, control.computerHelper.status);
  assert.equal(result.recipient, control.recipient);
});
test('conversation cloud permission alone is not screen readiness', () => {
  const control = runningComputer();
  control.externalScreenAllowed = false;
  assert.equal(readiness(control, configuration).ready, false);
  assert.match(readiness(control, configuration).next, /allow-external-screen/);
  control.modelProvider = 'local';
  assert.equal(readiness(control, { ...configuration, modelProvider: 'local' }).ready, true);
});
test('check refuses stale, wrong, test-only or unavailable helper status', () => {
  const invalid = [
    { project: 'different' },
    { phase: 'stopping' },
    { computerUse: false },
    { model: 'different' },
    { modelProvider: 'local' },
    { computerDelivery: 'foreground' },
    { computerHelperUnattendedTest: true },
    { computerHelperUnattendedTest: null },
    { computerHelper: null },
    { computerHelper: { path: '/owned/helper', error: 'timeout', status: runningComputer().computerHelper.status } },
    { computerHelper: { path: '/owned/helper', status: { ready: true, deliveryMode: 'foreground', unattendedTest: false } } },
    { computerHelper: { path: '/owned/helper', status: { ready: true, deliveryMode: 'background' } } },
    { computerHelper: { path: '/owned/helper', status: { ready: 'true', deliveryMode: 'background', unattendedTest: false } } },
  ];
  for (const patch of invalid) assert.equal(readiness({ ...runningComputer(), ...patch }, configuration).ready, false, JSON.stringify(patch));
  assert.equal(readiness(null, configuration).ready, false);
});
