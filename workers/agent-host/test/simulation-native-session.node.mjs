/** Lifecycle/IPC tests with a fake process and native device. No desktop input. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Writable, PassThrough } from 'node:stream';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { nativeSimulationConfirmation } from '../dist/simulation-native-checkout.js';

async function harness(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'genie-native-session-unit-'));
  const children = [],
    loads = [],
    applied = [],
    closed = [],
    beginnings = [];
  let active;
  const launch = (_exe, args) => {
    assert.equal(args[0], '--session');
    const child = new EventEmitter();
    child.pid = 10000 + children.length;
    child.exitCode = null;
    child.signalCode = null;
    child.sessionId = args[1];
    child.stderr = new PassThrough();
    child.kill = (signal) => {
      if (child.exitCode !== null || child.signalCode !== null) return false;
      child.signalCode = signal;
      queueMicrotask(() => child.emit('exit', null, signal));
      return true;
    };
    child.stdin = new Writable({
      write(data, _enc, callback) {
        (async () => {
          const command = JSON.parse(String(data));
          assert.equal(command.sessionId, child.sessionId);
          if (command.op === 'idle') {
            child.idle = true;
            return;
          }
          const checkout = JSON.parse(await readFile(command.path, 'utf8'));
          child.checkout = checkout;
          child.command = command;
          loads.push(checkout.quoteHash);
          active = child;
          await writeFile(
            join(checkout.directory, 'window.json'),
            JSON.stringify({
              sessionId: child.sessionId,
              commandId: command.commandId,
              pid: child.pid,
              quoteHash: checkout.quoteHash,
              ready: true,
              visible: true,
              windowId: options.windowForLoad?.(loads.length) ?? 777,
            }),
          );
        })().then(() => callback(), callback);
      },
    });
    children.push(child);
    return child;
  };
  const device = () => ({
    async claim() {},
    async begin(_goal, recipient, signal, expected) {
      assert.equal(recipient, 'local');
      assert.deepEqual(expected, { pid: active.pid, bundleId: 'org.genie.checkout.simulation' });
      beginnings.push(active.command.commandId);
      await options.begin?.(active, signal);
      return {
        id: active.command.commandId,
        pid: active.pid,
        windowId: options.frameWindow ?? 777,
        bundleId: 'org.genie.checkout.simulation',
        deliveryMode: 'background',
        elements: [
          {
            id: 'confirm',
            role: 'AXButton',
            name: `模擬注文を確定 ${active.checkout.quoteHash.slice(0, 12)}`,
          },
        ],
      };
    },
    async apply(frame, action, signal) {
      assert.equal(frame.id, active.command.commandId);
      assert.equal(action.elementId, 'confirm');
      const child = active;
      await options.apply?.(child, signal);
      signal.throwIfAborted();
      applied.push(child.checkout.quoteHash);
      await writeFile(
        join(child.checkout.directory, 'receipt.json'),
        JSON.stringify(child.checkout.candidate),
      );
      return {};
    },
    async close() {
      closed.push(active?.pid);
      if (options.closeError) throw Error('close_failed');
    },
  });
  const confirm = nativeSimulationConfirmation(
    { helper: '/fixture/helper', executable: '/fixture/app' },
    {
      platform: 'darwin',
      launch,
      device,
      status: async () => ({
        ready: true,
        deliveryMode: 'background',
        unattendedTest: false,
        ...options.status,
      }),
      idleMs: options.idleMs ?? 10000,
    },
  );
  t.after(async () => {
    for (const child of children) child.kill('SIGTERM');
    await rm(root, { recursive: true, force: true });
  });
  const checkout = async (index) => {
    const directory = join(root, String(index));
    await mkdir(directory);
    const quoteHash = index.toString(16).padStart(64, '0');
    const value = {
      directory,
      quoteHash,
      quote: {},
      candidate: { quoteHash, providerOrderId: `SIM-${index}` },
      authorizationExpiresAt: Date.now() + 60000,
    };
    await writeFile(join(directory, 'checkout.json'), JSON.stringify(value));
    return value;
  };
  return { confirm, checkout, children, loads, applied, closed, beginnings };
}
const signal = () => new AbortController().signal;

test('two orders retain one owned PID/window with distinct load handshakes and normal begin calls', async (t) => {
  const h = await harness(t);
  await h.confirm(await h.checkout(1), signal());
  await h.confirm(await h.checkout(2), signal());
  assert.equal(h.children.length, 1);
  assert.equal(h.applied.length, 2);
  assert.equal(h.closed.length, 2);
  assert.equal(new Set(h.beginnings).size, 2);
  assert.equal(h.children[0].idle, true);
  assert.equal(h.children[0].signalCode, null);
});

test('queued cancellation is prompt, skips its load and does not interrupt the active order', async (t) => {
  let release, entered;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  const h = await harness(t, {
    apply: async () => {
      entered();
      await gate;
    },
  });
  const first = h.confirm(await h.checkout(1), signal());
  await started;
  const cancel = new AbortController();
  const second = h.confirm(await h.checkout(2), cancel.signal);
  const third = h.confirm(await h.checkout(3), signal());
  cancel.abort(Error('queued_cancel'));
  await assert.rejects(second, /queued_cancel/);
  assert.equal(h.children[0].signalCode, null);
  assert.equal(h.loads.length, 1);
  release();
  await Promise.all([first, third]);
  assert.equal(h.children.length, 1);
  assert.deepEqual(
    h.applied.map((h) => Number.parseInt(h, 16)),
    [1, 3],
  );
});

test('active cancellation stops only its owned session and a subsequent order creates a new PID', async (t) => {
  let entered,
    first = true;
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  const h = await harness(t, {
    begin: async (_child, signal) => {
      if (!first) return;
      first = false;
      entered();
      await delay(10000, undefined, { signal });
    },
  });
  const cancel = new AbortController();
  const pending = h.confirm(await h.checkout(1), cancel.signal);
  await started;
  cancel.abort(Error('active_cancel'));
  await assert.rejects(pending, /active_cancel/);
  await h.confirm(await h.checkout(2), signal());
  assert.equal(h.children.length, 2);
  assert.equal(h.children[0].signalCode, 'SIGTERM');
  assert.deepEqual(
    h.applied.map((h) => Number.parseInt(h, 16)),
    [2],
  );
});

test('a changed native window under the same PID is refused before another begin or click', async (t) => {
  const h = await harness(t, { windowForLoad: (n) => (n === 1 ? 777 : 778) });
  await h.confirm(await h.checkout(1), signal());
  await assert.rejects(h.confirm(await h.checkout(2), signal()), /simulation_window_changed/);
  assert.equal(h.applied.length, 1);
  assert.equal(h.beginnings.length, 1);
  assert.equal(h.children[0].signalCode, 'SIGTERM');
});

test('wrong captured window and unattended helper are never clicked', async (t) => {
  const wrong = await harness(t, { frameWindow: 778 });
  await assert.rejects(wrong.confirm(await wrong.checkout(1), signal()), /simulation_wrong_target/);
  assert.equal(wrong.applied.length, 0);
  const unattended = await harness(t, { status: { unattendedTest: true } });
  await assert.rejects(
    unattended.confirm(await unattended.checkout(1), signal()),
    /simulation_production_helper_required/,
  );
  assert.equal(unattended.children.length, 0);
});

test('idle expiry closes the old process and never resurrects its PID', async (t) => {
  const h = await harness(t, { idleMs: 20 });
  await h.confirm(await h.checkout(1), signal());
  await delay(40);
  assert.equal(h.children[0].signalCode, 'SIGTERM');
  await h.confirm(await h.checkout(2), signal());
  assert.equal(h.children.length, 2);
});

test('device cleanup failure still terminates the owned window', async (t) => {
  const h = await harness(t, { closeError: true });
  await assert.rejects(h.confirm(await h.checkout(1), signal()), /close_failed/);
  assert.equal(h.children[0].signalCode, 'SIGTERM');
});
