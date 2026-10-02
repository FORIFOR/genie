import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { canonicalSha256, validateTransactionSubmitArgs } from '@genie/contracts';
import { TransactionRuntime } from '../dist/transaction-runtime.js';
import { TransactionJournal } from '../dist/transaction-journal.js';
import { HostStepLoop } from '../dist/step-loop.js';
import { NativeVisionDevice } from '../dist/computer-vision-device.js';

const exec = promisify(execFile);
const stamp = Date.now();
function intent(extra = {}) {
  return {
    kind: 'delivery',
    mode: 'simulation',
    provider: 'fixture-pizza',
    account: 'fixture-user',
    orderKey: 'order-1',
    currency: 'JPY',
    maxTotalMinor: 1000,
    destination: { id: 'fixture-address', label: 'Simulation address' },
    paymentMethodRef: 'test-credit',
    requestedTime: 'asap',
    items: [{ id: 'pizza', label: 'Test pizza', quantity: 2, options: ['thin'] }],
    ...extra,
  };
}
function quote(request = intent(), extra = {}) {
  const { maxTotalMinor: _budget, items, ...base } = request;
  return {
    ...base,
    quoteId: 'quote-1',
    expiresAt: new Date(stamp + 60_000).toISOString(),
    items: items.map((item) => ({ ...item, unitMinor: 250, lineMinor: item.quantity * 250 })),
    totals: { subtotalMinor: 500, taxMinor: 50, feeMinor: 100, tipMinor: 0, totalMinor: 650 },
    ...extra,
  };
}
async function observation(q, extra = {}) {
  return {
    provider: q.provider,
    mode: q.mode,
    account: q.account,
    orderKey: q.orderKey,
    quoteHash: await canonicalSha256(q),
    providerOrderId: 'provider-order-1',
    observedAt: new Date(stamp).toISOString(),
    status: 'accepted',
    details: {
      currency: q.currency,
      totalMinor: q.totals.totalMinor,
      destinationId: q.destination.id,
      paymentMethodRef: q.paymentMethodRef,
      ...(q.requestedTime ? { requestedTime: q.requestedTime } : {}),
      ...(q.stock ? { stock: q.stock } : {}),
      items: q.items,
    },
    ...extra,
  };
}
async function approval(args, extra = {}) {
  return {
    approvalId: 'approval-1',
    operationId: 'transaction.submit',
    decision: 'APPROVED',
    decidedBy: 'human',
    decidedAt: new Date(stamp - 1000).toISOString(),
    expiresAt: new Date(stamp + 60_000).toISOString(),
    inputsHash: await canonicalSha256(args),
    ...extra,
  };
}
async function submitArgs(request = intent(), q = quote(request)) {
  return { intent: request, quote: q, quoteHash: await canonicalSha256(q) };
}
async function harness(t, overrides = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'genie-transaction-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const calls = { prepare: 0, inspect: 0, submit: 0, reconcile: 0 };
  const adapter = {
    provider: 'fixture-pizza',
    mode: 'simulation',
    kinds: ['delivery', 'stock_paper'],
    prepare: async (request, signal) => {
      calls.prepare++;
      return overrides.prepare ? overrides.prepare(request, signal) : quote(request);
    },
    inspect: async (q, signal) => {
      calls.inspect++;
      return overrides.inspect ? overrides.inspect(q, signal) : q;
    },
    submit: async (q, key, signal, expiresAt) => {
      calls.submit++;
      return overrides.submit ? overrides.submit(q, key, signal, expiresAt) : observation(q);
    },
    reconcile: async (q, key, signal) => {
      calls.reconcile++;
      return overrides.reconcile ? overrides.reconcile(q, key, signal) : observation(q);
    },
  };
  const config = {
    adapters: [adapter],
    journalDir: join(directory, 'journal'),
    now: () => new Date(stamp),
    ...overrides.config,
  };
  const runtime = new TransactionRuntime(config);
  return { runtime, config, directory, calls, adapter };
}

test('revoking a claimed task aborts the native helper consent wait without input, and leaves reconciliation-only history', async (t) => {
  // A protocol fixture stands in for the native dialog; this launches no UI and
  // does not claim to test AppKit consent rendering. The real device subprocess
  // cancellation path, transaction journal and host loop are used unchanged.
  const fixture = await mkdtemp(join(tmpdir(), 'genie-consent-cancel-'));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  const entered = join(fixture, 'entered');
  const applied = join(fixture, 'applied');
  const helper = join(fixture, 'helper');
  await writeFile(
    helper,
    `#!${process.execPath}\nconst fs=require('node:fs');let data='';process.stdin.on('data',c=>data+=c);process.stdin.on('end',()=>{const request=JSON.parse(data);if(request.op==='begin'){fs.writeFileSync(${JSON.stringify(entered)},String(process.pid));setInterval(()=>{},1000);}else if(request.op==='apply'){fs.writeFileSync(${JSON.stringify(applied)},'unexpected');process.exit(1);}else{process.stdout.write('{}');}});`,
    { mode: 0o700 },
  );
  const oldRoot = process.env.ASTRA_VISUAL_CONTEXT_DIR;
  process.env.ASTRA_VISUAL_CONTEXT_DIR = join(fixture, 'visual');
  t.after(() => {
    if (oldRoot === undefined) delete process.env.ASTRA_VISUAL_CONTEXT_DIR;
    else process.env.ASTRA_VISUAL_CONTEXT_DIR = oldRoot;
  });
  const device = new NativeVisionDevice(helper);
  const h = await harness(t, {
    submit: async (_q, _key, signal) => {
      await device.claim(`cancel-consent-${fixture}`);
      try {
        const frame = await device.begin('Simulation only', 'local', signal);
        await device.apply(frame, {}, signal, Date.now() + 1000);
        throw new Error('unreachable');
      } finally {
        await device.close();
      }
    },
    reconcile: async () => null,
  });
  const args = await submitArgs();
  let queued = {
    id: 'cancelled-native-step',
    toolId: 'transaction.submit',
    args,
    approval: await approval(args),
  };
  const failures = [];
  const transport = {
    async claim() {
      const result = queued;
      queued = null;
      return result;
    },
    async executionAllowed() {
      try {
        await stat(entered);
        return false;
      } catch (error) {
        if (error.code === 'ENOENT') return true;
        throw error;
      }
    },
    async complete() {
      assert.fail('a consent cancellation cannot be reported successful');
    },
    async fail(_id, _host, error) {
      failures.push(error);
    },
  };
  await new HostStepLoop({ transport, runner: h.runtime, authorityPollMs: 5 }).tick('host');
  assert.equal(failures[0]?.code, 'transaction.result_unknown');
  assert.equal(h.calls.submit, 1, 'adapter was waiting on consent, never re-entered');
  await assert.rejects(stat(applied), { code: 'ENOENT' });
  const pid = Number(await readFile(entered, 'utf8'));
  for (let i = 0; i < 100; i++) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error.code === 'ESRCH') break;
      throw error;
    }
    if (i === 99) assert.fail('native helper survived the task abort');
    await delay(5);
  }
  const restarted = new TransactionRuntime(h.config);
  const again = await submit(restarted, args, undefined, 'another-task');
  assert.equal(again.error.code, 'transaction.result_unknown');
  assert.equal(h.calls.submit, 1);
  assert.equal(h.calls.reconcile, 1);
});
async function submit(runtime, args, proof, id = 'task-1', signal) {
  return runtime.run(
    { id, toolId: 'transaction.submit', args, approval: proof ?? (await approval(args)) },
    signal,
  );
}
function reconcile(runtime, q, signal) {
  return runtime.run(
    {
      id: 'lookup',
      toolId: 'transaction.reconcile',
      approval: null,
      args: { provider: q.provider, mode: q.mode, account: q.account, orderKey: q.orderKey },
    },
    signal,
  );
}

test('prepare pins exact quote; submit writes a durable private claim before one provider input and preserves accepted status', async (t) => {
  let h;
  h = await harness(t, {
    submit: async (q, key, _signal, expiry) => {
      const attempt = await new TransactionJournal(h.config.journalDir).find(q);
      assert.ok(attempt, 'claim must be readable before the adapter can send');
      assert.equal(attempt.args.quote.orderKey, key);
      assert.equal(expiry, Date.parse(q.expiresAt));
      const claim = (await readdir(h.config.journalDir)).find((name) =>
        name.endsWith('.attempt.json'),
      );
      assert.equal((await stat(join(h.config.journalDir, claim))).mode & 0o777, 0o600);
      assert.equal((await stat(h.config.journalDir)).mode & 0o777, 0o700);
      return observation(q);
    },
  });
  const prepared = await h.runtime.run({
    id: 'prepare',
    toolId: 'transaction.prepare',
    args: { intent: intent() },
    approval: null,
  });
  assert.equal(prepared.ok, true);
  assert.equal(prepared.result.quoteHash, await canonicalSha256(prepared.result.quote));
  assert.equal(h.calls.submit, 0);
  const out = await submit(h.runtime, prepared.result.submitArgs);
  assert.equal(out.ok, true);
  assert.equal(out.result.status, 'accepted');
  assert.equal(out.result.mode, 'simulation');
  assert.equal(out.result.completed, undefined);
  assert.equal(out.result.observation.providerOrderId, 'provider-order-1');
  assert.equal(h.calls.submit, 1);
});

test('approval binds complete exact args including destination, budget, quantity, and requested time', async (t) => {
  const args = await submitArgs(),
    proof = await approval(args);
  const changes = [
    (v) => {
      v.intent.maxTotalMinor++;
    },
    (v) => {
      v.quote.destination.label = 'Other destination';
    },
    (v) => {
      v.quote.items[0].quantity++;
    },
    (v) => {
      v.intent.requestedTime = new Date(stamp + 600_000).toISOString();
    },
    (v) => {
      v.quote.currency = 'USD';
    },
  ];
  for (const change of changes) {
    const h = await harness(t),
      changed = structuredClone(args);
    change(changed);
    const out = await submit(h.runtime, changed, proof);
    assert.equal(out.error.code, 'transaction.approval_mismatch');
    assert.equal(h.calls.inspect, 0);
    assert.equal(h.calls.submit, 0);
  }
  for (const extra of [
    { inputsHash: undefined },
    { operationId: 'computer.run' },
    { decision: 'REJECTED' },
    { expiresAt: new Date(stamp - 1).toISOString() },
  ]) {
    const h = await harness(t);
    const out = await submit(h.runtime, args, { ...proof, ...extra });
    assert.equal(out.ok, false);
    assert.equal(h.calls.submit, 0);
  }
});

test('invalid money, currency/content substitutions, expired quotes, and over-budget totals never reach submit', async (t) => {
  const cases = [
    [
      'budget_exceeded',
      (a) => {
        a.intent.maxTotalMinor = 649;
      },
    ],
    [
      'quote_changed',
      (a) => {
        a.quote.currency = 'USD';
      },
    ],
    [
      'quote_changed',
      (a) => {
        a.quote.items[0].options = ['changed'];
      },
    ],
    [
      'expired_quote',
      (a) => {
        a.quote.expiresAt = new Date(stamp).toISOString();
      },
    ],
    [
      'invalid_quote',
      (a) => {
        a.quote.totals.totalMinor = 651;
      },
    ],
    [
      'invalid_args',
      (a) => {
        a.quote.totals.taxMinor = 0.1;
      },
    ],
    [
      'invalid_args',
      (a) => {
        a.quote.items[0].unitMinor = Number.MAX_SAFE_INTEGER + 1;
      },
    ],
    [
      'invalid_quote',
      (a) => {
        a.quote.items[0].unitMinor = Number.MAX_SAFE_INTEGER;
      },
    ],
    [
      'quote_hash_mismatch',
      (a) => {
        a.quoteHash = '0'.repeat(64);
      },
    ],
  ];
  for (const [expected, change] of cases) {
    const h = await harness(t),
      args = await submitArgs();
    change(args);
    if (expected !== 'quote_hash_mismatch') args.quoteHash = await canonicalSha256(args.quote);
    const out = await submit(h.runtime, args);
    assert.equal(out.error.code, `transaction.${expected}`, expected);
    assert.equal(h.calls.submit, 0);
  }
});

test('inspection changes, approval expiry, and cancellation stop before the attempt claim', async (t) => {
  for (const mode of ['price', 'stock', 'expiry', 'cancel']) {
    let now = stamp;
    const controller = new AbortController();
    const h = await harness(t, {
      config: { now: () => new Date(now) },
      inspect: async (q) => {
        if (mode === 'price') {
          q.totals.feeMinor++;
          q.totals.totalMinor++;
        }
        if (mode === 'stock') q.items[0].id = 'substitute';
        if (mode === 'expiry') now += 60_001;
        if (mode === 'cancel') controller.abort();
        return q;
      },
    });
    const args = await submitArgs();
    assert.equal((await submit(h.runtime, args, undefined, 'task', controller.signal)).ok, false);
    assert.equal(h.calls.submit, 0);
    assert.equal(await new TransactionJournal(h.config.journalDir).find(args.quote), null);
  }
});

test('unknown delivery is durable across new runtime and task IDs; submit can only reconcile it', async (t) => {
  const h = await harness(t, {
    submit: async () => {
      throw new Error('response lost after acceptance');
    },
    reconcile: async () => null,
  });
  const args = await submitArgs();
  const first = await submit(h.runtime, args);
  assert.equal(first.result.status, 'unknown');
  assert.equal(first.error.code, 'transaction.result_unknown');
  const second = await submit(new TransactionRuntime(h.config), args, undefined, 'new-task');
  assert.equal(second.result.status, 'unknown');
  assert.equal(h.calls.submit, 1);
  assert.equal(h.calls.reconcile, 1);
  const changed = structuredClone(args);
  changed.intent.maxTotalMinor++;
  assert.equal((await submit(h.runtime, changed)).error.code, 'transaction.order_key_conflict');
  assert.equal(h.calls.submit, 1);
  h.adapter.reconcile = async (q) => observation(q, { status: 'delivered' });
  const recovered = await reconcile(h.runtime, args.quote);
  assert.equal(recovered.result.status, 'delivered');
  assert.equal(h.calls.submit, 1);
});

test('authorization deadline is propagated to the adapter and aborts in-flight submit without resending', async (t) => {
  const actual = Date.now();
  let deadline,
    aborted = false;
  const h = await harness(t, {
    config: { now: () => new Date() },
    submit: async (_q, _key, signal, expiry) => {
      deadline = expiry;
      return new Promise((_resolve, reject) =>
        signal.addEventListener(
          'abort',
          () => {
            aborted = true;
            reject(new Error('deadline'));
          },
          { once: true },
        ),
      );
    },
  });
  const args = await submitArgs(
    intent(),
    quote(intent(), { expiresAt: new Date(actual + 60_000).toISOString() }),
  );
  const proof = await approval(args, {
    decidedAt: new Date(actual - 1).toISOString(),
    expiresAt: new Date(actual + 250).toISOString(),
  });
  const keepAlive = setInterval(() => {}, 100);
  try {
    const out = await submit(h.runtime, args, proof);
    assert.equal(out.result.status, 'unknown');
    assert.equal(deadline, actual + 250);
    assert.equal(aborted, true);
  } finally {
    clearInterval(keepAlive);
  }
  assert.equal(h.calls.submit, 1);
});

test('provider receipts must match quote identity, paid total, destination, options, and execution mode', async (t) => {
  for (const mutate of [
    (o) => {
      o.mode = 'live';
    },
    (o) => {
      o.account = 'other';
    },
    (o) => {
      o.quoteHash = '0'.repeat(64);
    },
    (o) => {
      o.details.totalMinor++;
    },
    (o) => {
      o.details.destinationId = 'other';
    },
    (o) => {
      o.details.requestedTime = new Date(stamp + 300_000).toISOString();
    },
    (o) => {
      o.details.paymentMethodRef = 'other-payment';
    },
    (o) => {
      o.observedAt = new Date(stamp - 1).toISOString();
    },
    (o) => {
      o.details.items[0].options = ['other'];
    },
    (o) => {
      o.status = 'filled';
    },
  ]) {
    const h = await harness(t, {
      submit: async (q) => {
        const o = await observation(q);
        mutate(o);
        return o;
      },
    });
    const out = await submit(h.runtime, await submitArgs());
    assert.equal(out.result.status, 'unknown');
    assert.equal(out.ok, false);
    assert.equal(h.calls.submit, 1);
  }
});

test('live provider and request-supplied URLs are unsupported; read-only reconcile never creates an order', async (t) => {
  const h = await harness(t);
  const request = intent({ mode: 'live' });
  const live = await h.runtime.run({
    id: 'live',
    toolId: 'transaction.prepare',
    approval: null,
    args: { intent: request },
  });
  assert.equal(live.error.code, 'transaction.unsupported_provider');
  const url = await h.runtime.run({
    id: 'url',
    toolId: 'transaction.prepare',
    approval: null,
    args: { intent: intent(), endpoint: 'http://127.0.0.1:1' },
  });
  assert.equal(url.error.code, 'transaction.invalid_args');
  const missing = await reconcile(h.runtime, quote());
  assert.equal(missing.error.code, 'transaction.no_attempt');
  assert.deepEqual(h.calls, { prepare: 0, inspect: 0, submit: 0, reconcile: 0 });
});

test('paper stock remains simulation and distinguishes acceptance, partial fills, full fills, and cancelled partials', async (t) => {
  const stock = {
    symbol: 'TEST',
    market: 'PAPER',
    side: 'BUY',
    quantity: 2,
    orderType: 'LIMIT',
    limitPriceMinor: 250,
    timeInForce: 'DAY',
  };
  const request = intent({
    kind: 'stock_paper',
    requestedTime: undefined,
    stock,
    items: [{ id: 'TEST', label: 'Paper Test', quantity: 2, options: [] }],
  });
  const q = quote(request),
    args = await submitArgs(request, q);
  for (const [status, quantities, accepted] of [
    ['partially_filled', [1], true],
    ['filled', [1, 1], true],
    ['cancelled', [1], true],
    ['filled', [1], false],
    ['partially_filled', [2], false],
    ['accepted', [1], false],
  ]) {
    const h = await harness(t);
    assert.equal((await submit(h.runtime, args)).result.status, 'accepted');
    h.adapter.reconcile = (quote) =>
      observation(quote, {
        status,
        fills: quantities.map((quantity, i) => ({
          executionId: `e${i}`,
          quantity,
          priceMinor: 249,
        })),
      });
    const out = await reconcile(h.runtime, q);
    assert.equal(out.ok, accepted, status + quantities);
    assert.equal(out.result.status, accepted ? status : 'unknown');
    assert.equal(h.calls.submit, 1);
  }
  const liveArgs = await submitArgs({ ...request, mode: 'live' }, { ...q, mode: 'live' });
  await assert.rejects(validateTransactionSubmitArgs(liveArgs, stamp));
});

test('durable receipt history rejects changed provider order IDs, regressed state, and lost partial executions', async (t) => {
  const h = await harness(t),
    args = await submitArgs();
  await submit(h.runtime, args);
  h.adapter.reconcile = (q) => observation(q, { status: 'delivered' });
  assert.equal((await reconcile(h.runtime, args.quote)).result.status, 'delivered');
  for (const change of [
    { status: 'accepted' },
    { status: 'cancelled' },
    { status: 'delivered', providerOrderId: 'other-order' },
  ]) {
    h.adapter.reconcile = (q) => observation(q, change);
    assert.equal(
      (await reconcile(new TransactionRuntime(h.config), args.quote)).result.status,
      'unknown',
    );
  }
  assert.equal(h.calls.submit, 1);
  const stock = {
    symbol: 'TEST',
    market: 'PAPER',
    side: 'BUY',
    quantity: 2,
    orderType: 'LIMIT',
    limitPriceMinor: 250,
    timeInForce: 'DAY',
  };
  const request = intent({
    kind: 'stock_paper',
    requestedTime: undefined,
    stock,
    items: [{ id: 'TEST', label: 'Paper', quantity: 2, options: [] }],
  });
  const paper = await harness(t),
    paperArgs = await submitArgs(request, quote(request));
  await submit(paper.runtime, paperArgs);
  const fill = { executionId: 'e1', quantity: 1, priceMinor: 249 };
  paper.adapter.reconcile = (q) => observation(q, { status: 'partially_filled', fills: [fill] });
  assert.equal((await reconcile(paper.runtime, paperArgs.quote)).result.status, 'partially_filled');
  paper.adapter.reconcile = (q) => observation(q, { status: 'cancelled', fills: [] });
  assert.equal((await reconcile(paper.runtime, paperArgs.quote)).result.status, 'unknown');
  paper.adapter.reconcile = (q) => observation(q, { status: 'cancelled', fills: [fill] });
  assert.equal((await reconcile(paper.runtime, paperArgs.quote)).result.status, 'cancelled');
});

test('multiple processes atomically claim the same order once; a crash after provider acceptance recovers read-only', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'genie-transaction-process-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const runtimeURL = new URL('../dist/transaction-runtime.js', import.meta.url).href;
  const configPath = join(directory, 'args.json'),
    helper = join(directory, 'worker.mjs');
  const args = await submitArgs();
  await writeFile(configPath, JSON.stringify({ args, approval: await approval(args), stamp }));
  await writeFile(
    helper,
    `import { TransactionRuntime } from ${JSON.stringify(runtimeURL)};
import { readFile, appendFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
const [root, mode, task] = process.argv.slice(2), data = JSON.parse(await readFile(join(root, 'args.json')));
const receipt = (q) => ({ provider:q.provider, mode:q.mode, account:q.account, orderKey:q.orderKey,
 quoteHash:data.args.quoteHash, providerOrderId:'real-fixture-receipt', observedAt:new Date(data.stamp).toISOString(), status:'accepted',
 details:{currency:q.currency,totalMinor:q.totals.totalMinor,destinationId:q.destination.id,paymentMethodRef:q.paymentMethodRef,requestedTime:q.requestedTime,items:q.items} });
const adapter = {provider:'fixture-pizza',mode:'simulation',kinds:['delivery'], prepare:async()=>data.args.quote,
 inspect:async(q)=>{await delay(50);return q},
 submit:async(q)=>{ const files=await readdir(join(root,'journal')); if(!files.some(f=>f.endsWith('.attempt.json'))) throw Error('no durable claim');
 await appendFile(join(root,'provider-inputs'),task+'\\n'); if(mode==='crash') process.exit(17); await delay(25);return receipt(q)},
 reconcile:async(q)=>{try{await readFile(join(root,'provider-inputs'));return receipt(q)}catch{return null}}};
const runtime = new TransactionRuntime({adapters:[adapter],journalDir:join(root,'journal'),now:()=>new Date(data.stamp)});
const out=await runtime.run({id:task,toolId:'transaction.submit',args:data.args,approval:data.approval});
process.stdout.write(JSON.stringify(out));
`,
  );
  const outputs = await Promise.all(
    Array.from({ length: 4 }, (_, i) =>
      exec(process.execPath, [helper, directory, 'normal', `task-${i}`]),
    ),
  );
  assert.equal(
    (await readFile(join(directory, 'provider-inputs'), 'utf8')).trim().split('\n').length,
    1,
  );
  assert.ok(
    outputs.every((output) =>
      ['accepted', 'unknown'].includes(JSON.parse(output.stdout).result.status),
    ),
  );
  // A distinct identity tests crash recovery without deleting any prior claim.
  args.intent.orderKey = args.quote.orderKey = 'crash-order';
  args.quoteHash = await canonicalSha256(args.quote);
  await writeFile(configPath, JSON.stringify({ args, approval: await approval(args), stamp }));
  await assert.rejects(
    exec(process.execPath, [helper, directory, 'crash', 'crashed-task']),
    (error) => error.code === 17,
  );
  const recovered = JSON.parse(
    (await exec(process.execPath, [helper, directory, 'normal', 'new-recovery-task'])).stdout,
  );
  assert.equal(recovered.result.status, 'accepted');
  assert.equal(
    (await readFile(join(directory, 'provider-inputs'), 'utf8')).trim().split('\n').length,
    2,
  );
});

test('a corrupt durable claim blocks a fresh attempt rather than silently forgetting it', async (t) => {
  const h = await harness(t),
    args = await submitArgs();
  await submit(h.runtime, args);
  const file = (await readdir(h.config.journalDir)).find((entry) =>
    entry.endsWith('.attempt.json'),
  );
  await writeFile(join(h.config.journalDir, file), '{broken');
  assert.equal(
    (await submit(new TransactionRuntime(h.config), args, undefined, 'another-task')).ok,
    false,
  );
  assert.equal(h.calls.submit, 1);
});
