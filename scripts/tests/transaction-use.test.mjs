import { test } from 'node:test';
import assert from 'node:assert/strict';
import { demoIntent, performTransaction } from '../transaction-use.mjs';

const record = () => ({
  version: 1,
  key: '11111111-1111-4111-8111-111111111111',
  taskId: null,
  request: { kind: 'transaction.order', input: { intent: demoIntent('pizza', 'stable-order') } },
});

test('lost task acceptance reuses the same persisted identity and never approves', async () => {
  const r = record(),
    calls = [];
  const request = async (...args) => {
    calls.push(args);
    if (calls.length === 1) throw Error('lost');
    return { id: 'task' };
  };
  await assert.rejects(performTransaction('start', r, request));
  await performTransaction('recover', r, request);
  assert.deepEqual(calls[0], calls[1]);
  assert.equal(r.taskId, 'task');
  await performTransaction('recover', r, request);
  assert.deepEqual(calls[2], ['/v1/tasks/task']);
});
test('an unrelated approval or non-order task cannot be approved through the order command', async () => {
  for (const task of [
    { kind: 'computer.run', status: 'WAITING_APPROVAL' },
    { kind: 'transaction.order', status: 'COMPLETED' },
    { kind: 'transaction.order', status: 'WAITING_APPROVAL' },
  ]) {
    const calls = [],
      r = { ...record(), taskId: 't' };
    const request = async (...args) => {
      calls.push(args);
      return args[0].endsWith('/approvals') ? { items: [{ id: 'owned' }] } : task;
    };
    await assert.rejects(performTransaction('approve', r, request, 'foreign'));
    assert.ok(calls.every((c) => c[1] !== 'POST'));
  }
});
test('approval submission does not claim an order was accepted', async () => {
  const calls = [],
    r = { ...record(), taskId: 't' };
  const request = async (...args) => {
    calls.push(args);
    return args[0].endsWith('/approvals')
      ? { items: [{ id: 'owned' }] }
      : { kind: 'transaction.order', status: 'WAITING_APPROVAL' };
  };
  const result = await performTransaction('approve', r, request, 'owned');
  assert.equal(result.status, 'APPROVAL_SENT');
  assert.equal(calls.filter((c) => c[1] === 'POST').length, 1);
  assert.deepEqual(calls.at(-1), [
    '/v1/tasks/t/approve',
    'POST',
    { approval_id: 'owned', decision: 'APPROVED' },
  ]);
});
