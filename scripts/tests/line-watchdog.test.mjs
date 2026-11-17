import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  commit,
  decide,
  FAILURES_TO_ALERT,
  initialState,
  INTERVAL_MS,
  probe,
  push,
  SLEEP_GAP_MS,
} from '../line-watchdog.mjs';

const down = { offline: false, problems: ['webhook'] };
const up = { offline: false, problems: [] };
const step = (state, result, at) => {
  const d = decide(state, result, at);
  return { d, state: commit(d) };
};

test('alerts once after consecutive failures, not on a single one', () => {
  assert.equal(FAILURES_TO_ALERT, 2);
  const first = step(initialState(), down, 0);
  assert.equal(first.d.text, null);
  const second = step(first.state, down, INTERVAL_MS);
  assert.match(second.d.text, /LINE の受け口/);
  const third = step(second.state, down, 2 * INTERVAL_MS);
  assert.equal(third.d.text, null);
});

test('one failure followed by success stays silent', () => {
  const first = step(initialState(), down, 0);
  const second = step(first.state, up, INTERVAL_MS);
  assert.equal(second.d.text, null);
  assert.equal(second.state.failures, 0);
  assert.equal(step(second.state, down, 2 * INTERVAL_MS).d.text, null);
});

test('tells recovery with how long it was down, then can alert again', () => {
  let s = step(initialState(), down, 0).state;
  s = step(s, down, INTERVAL_MS).state;
  const back = step(s, up, 20 * 60_000);
  assert.match(back.d.text, /約 20 分/);
  assert.equal(back.state.alerted, false);
  assert.equal(step(back.state, up, 25 * 60_000).d.text, null);
  const again = step(back.state, down, 30 * 60_000);
  assert.equal(again.d.text, null);
  assert.match(step(again.state, down, 35 * 60_000).d.text, /止まっています/);
});

test('a failed send is not marked as told, so the next check tries again', () => {
  const s = step(initialState(), down, 0).state;
  const unsent = decide(s, down, INTERVAL_MS);
  assert.ok(unsent.text);
  assert.equal(unsent.state.alerted, false);
  assert.ok(decide(unsent.state, down, 2 * INTERVAL_MS).text);
  // 戻った知らせも同じ
  const told = commit(unsent);
  const back = decide(told, up, 3 * INTERVAL_MS);
  assert.ok(back.text);
  assert.ok(decide(back.state, up, 4 * INTERVAL_MS).text);
});

test('does not judge while this Mac is offline', () => {
  const first = step(initialState(), down, 0).state;
  const offline = step(first, { offline: true, problems: [] }, INTERVAL_MS);
  assert.equal(offline.d.text, null);
  assert.equal(offline.state.failures, 1);
});

test('a failure right after waking starts the count again', () => {
  const first = step(initialState(), down, 0).state;
  const woke = step(first, down, SLEEP_GAP_MS + 1);
  assert.equal(woke.d.text, null);
  assert.equal(woke.state.failures, 1);
  assert.ok(step(woke.state, down, SLEEP_GAP_MS + 1 + INTERVAL_MS).d.text);
});

test('probe tells apart webhook, gateway, offline, and its own auth trouble', async () => {
  const fake = (webhook, gateway) => async (url) => {
    const answer = String(url).includes('webhook/test') ? webhook : gateway;
    if (answer instanceof Error) throw answer;
    return answer;
  };
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status });
  const ok = () => json({ success: true });
  const run = (webhook, gateway) =>
    probe({ token: 't', fetchImpl: fake(webhook, gateway), gateway: 'http://g' });
  // gateway の 401 は「動いている」
  assert.deepEqual(await run(ok(), new Response('', { status: 401 })), {
    offline: false,
    problems: [],
  });
  assert.deepEqual((await run(json({ success: false }), ok())).problems, ['webhook']);
  assert.deepEqual((await run(ok(), new Error('refused'))).problems, ['gateway']);
  assert.equal((await run(new Error('no network'), ok())).offline, true);
  const auth = await run(json({}, 401), ok());
  assert.deepEqual(auth.problems, []);
  assert.equal(auth.indeterminate, 401);
});

test('push sends to the one destination and reports refusal', async () => {
  const calls = [];
  await push({
    token: 't',
    to: 'U1',
    text: 'x',
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), body: JSON.parse(init.body) });
      return new Response('{}');
    },
  });
  assert.match(calls[0].url, /message\/push$/);
  assert.equal(calls[0].body.to, 'U1');
  await assert.rejects(
    push({
      token: 't',
      to: 'U1',
      text: 'x',
      fetchImpl: async () => new Response('', { status: 429 }),
    }),
  );
});
