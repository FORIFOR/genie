/**
 * 端末が仕事を取りに来る側。正本 §4.4・§21。
 *
 * 見るのは 4 つ:
 *   - 一度に 1 件だけ走らせる（外部への操作を重ねない）
 *   - 取ったものは必ず返す
 *   - 扱えないものを黙って成功にしない
 *   - 失敗を成功にしない
 */
import { describe, expect, it, vi } from 'vitest';
import { HostStepLoop, type StepTransport } from '../src/step-loop.js';
import type { HostStep, StepOutcome } from '../src/connector-steps.js';

const HOST = 'host-1';

const step = (over: Partial<HostStep> = {}): HostStep => ({
  id: 'req-1',
  toolId: 'mail.send',
  args: { to: ['a@example.com'] },
  approval: null,
  ...over,
});

function fakeTransport(queue: HostStep[]): StepTransport & {
  completed: { id: string; result: unknown }[];
  failed: { id: string; error: { code: string; message: string } }[];
} {
  const completed: { id: string; result: unknown }[] = [];
  const failed: { id: string; error: { code: string; message: string } }[] = [];
  return {
    completed,
    failed,
    async claim() {
      return queue.shift() ?? null;
    },
    async complete(id, _hostId, result) {
      completed.push({ id, result });
    },
    async fail(id, _hostId, error) {
      failed.push({ id, error });
    },
  };
}

const runner = (run: (s: HostStep) => Promise<StepOutcome>, handles = true) => ({
  handles: () => handles,
  run,
});

describe('the host step loop', () => {
  it('reports unknown transaction identity as a failed result without submitting again', async () => {
    const transport = fakeTransport([step({ toolId: 'transaction.submit' })]);
    transport.executionAllowed = async () => true;
    const unknown = {
      status: 'unknown',
      provider: 'fixture',
      mode: 'simulation',
      account: 'account',
      orderKey: 'order-1',
      quoteHash: 'a'.repeat(64),
    };
    const fail = vi.spyOn(transport, 'fail');
    const run = vi.fn(async () => ({
      ok: false,
      result: unknown,
      error: { code: 'transaction.result_unknown', message: '受付状況を照会してください。' },
    }));
    const loop = new HostStepLoop({ transport, runner: runner(run) });
    await loop.tick(HOST);
    expect(fail).toHaveBeenCalledWith(
      'req-1',
      HOST,
      expect.objectContaining({ code: 'transaction.result_unknown' }),
      unknown,
    );
    expect(await loop.tick(HOST)).toBe(false);
    expect(run).toHaveBeenCalledOnce();
    expect(transport.completed).toEqual([]);
  });

  it('checks fresh authority before dispatch, including cancellation after claim', async () => {
    const transport = fakeTransport([step({ toolId: 'transaction.submit' })]);
    const run = vi.fn(async () => ({ ok: true }));
    transport.executionAllowed = vi.fn(async () => false);
    const loop = new HostStepLoop({ transport, runner: runner(run) });
    await loop.tick(HOST);
    expect(transport.executionAllowed).toHaveBeenCalledWith('req-1', HOST, expect.any(AbortSignal));
    expect(run).not.toHaveBeenCalled();
    expect(transport.failed[0]?.error.code).toBe('host.cancelled');
  });

  it('requires revocation support for submit without breaking legacy transports', async () => {
    const transport = fakeTransport([step({ toolId: 'transaction.submit' }), step()]);
    const run = vi.fn(async () => ({ ok: true }));
    const loop = new HostStepLoop({ transport, runner: runner(run) });
    await loop.tick(HOST);
    expect(run).not.toHaveBeenCalled();
    expect(transport.failed[0]?.error.code).toBe('host.authority_unavailable');
    await loop.tick(HOST);
    expect(run).toHaveBeenCalledOnce();
  });

  it('does not run when the authority endpoint is missing or unavailable', async () => {
    for (const message of ['404 not found', 'fetch failed']) {
      const transport = fakeTransport([step()]);
      transport.executionAllowed = async () => {
        throw new Error(message);
      };
      const run = vi.fn(async () => ({ ok: true }));
      await new HostStepLoop({ transport, runner: runner(run) }).tick(HOST);
      expect(run).not.toHaveBeenCalled();
      expect(transport.failed).toHaveLength(1);
    }
  });

  it('propagates in-flight revocation and network loss to the runner signal', async () => {
    for (const lostConnection of [false, true]) {
      const transport = fakeTransport([step()]);
      let checks = 0;
      transport.executionAllowed = async () => {
        if (++checks === 1) return true;
        if (lostConnection) throw new Error('fetch failed');
        return false;
      };
      let received: AbortSignal | undefined;
      const loop = new HostStepLoop({
        transport,
        authorityPollMs: 1,
        runner: {
          handles: () => true,
          async run(_step, signal) {
            received = signal;
            await new Promise<void>((resolve) =>
              signal!.addEventListener('abort', () => resolve(), { once: true }),
            );
            return {
              ok: false,
              error: { code: 'transaction.result_unknown', message: '停止後は照会してください。' },
            };
          },
        },
      });
      await loop.tick(HOST);
      expect(received?.aborted).toBe(true);
      expect(transport.failed[0]?.error.code).toBe('transaction.result_unknown');
    }
  });

  it('aborts even while the authority transport is hung before fetch or ignores the signal', async () => {
    const transport = fakeTransport([step()]);
    let checks = 0;
    transport.executionAllowed = () =>
      ++checks === 1 ? Promise.resolve(true) : new Promise(() => {});
    let aborted = false;
    const loop = new HostStepLoop({
      transport,
      authorityPollMs: 1,
      authorityTimeoutMs: 5,
      runner: {
        handles: () => true,
        async run(_step, signal) {
          await new Promise<void>((resolve) =>
            signal!.addEventListener(
              'abort',
              () => {
                aborted = true;
                resolve();
              },
              { once: true },
            ),
          );
          return {
            ok: false,
            error: { code: 'transaction.result_unknown', message: '照会してください。' },
          };
        },
      },
    });
    await loop.tick(HOST);
    expect(aborted).toBe(true);
    expect(transport.failed[0]?.error.code).toBe('transaction.result_unknown');
  });

  it('preserves a receipt returned after cancellation and stops polling after completion', async () => {
    const transport = fakeTransport([step()]);
    let checks = 0;
    transport.executionAllowed = async () => ++checks === 1;
    const receipt = { status: 'accepted', providerOrderId: 'already-sent' };
    const loop = new HostStepLoop({
      transport,
      authorityPollMs: 1,
      runner: {
        handles: () => true,
        async run(_step, signal) {
          await new Promise<void>((resolve) =>
            signal!.addEventListener('abort', () => resolve(), { once: true }),
          );
          return { ok: true, result: receipt };
        },
      },
    });
    await loop.tick(HOST);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(checks).toBe(2);
    expect(transport.completed).toEqual([{ id: 'req-1', result: receipt }]);
    expect(transport.failed).toEqual([]);
  });

  it('returns the result of what it ran', async () => {
    const transport = fakeTransport([step()]);
    const loop = new HostStepLoop({
      transport,
      runner: runner(async () => ({ ok: true, result: { messageId: 'm1' } })),
    });

    expect(await loop.tick(HOST)).toBe(true);
    expect(transport.completed).toEqual([{ id: 'req-1', result: { messageId: 'm1' } }]);
    expect(transport.failed).toEqual([]);
  });

  it('says there is nothing to do rather than inventing work', async () => {
    const transport = fakeTransport([]);
    const loop = new HostStepLoop({ transport, runner: runner(async () => ({ ok: true })) });
    expect(await loop.tick(HOST)).toBe(false);
    expect(transport.completed).toEqual([]);
  });

  it('runs one step at a time', async () => {
    let release = (): void => {};
    const started: string[] = [];
    const transport = fakeTransport([step({ id: 'a' }), step({ id: 'b' })]);
    const loop = new HostStepLoop({
      transport,
      runner: runner(async (s) => {
        started.push(s.id);
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return { ok: true, result: null };
      }),
    });

    const first = loop.tick(HOST);
    await vi.waitFor(() => expect(started).toHaveLength(1));

    // 走っている間に次を取りに行かない。外部への操作が重なると取り返しがつかない。
    expect(await loop.tick(HOST)).toBe(false);
    expect(loop.busyWith).toBe('a');

    release();
    await first;
    expect(started).toEqual(['a']);
  });

  it('reports a failure as a failure', async () => {
    const transport = fakeTransport([step()]);
    const loop = new HostStepLoop({
      transport,
      runner: runner(async () => ({
        ok: false,
        error: { code: 'connector.insufficient_scope', message: '必要な許可が足りません。' },
      })),
    });

    await loop.tick(HOST);
    expect(transport.completed).toEqual([]);
    expect(transport.failed[0]!.error.code).toBe('connector.insufficient_scope');
  });

  it('hands back a step it cannot run, instead of holding on to it', async () => {
    const transport = fakeTransport([step({ toolId: 'crm.write' })]);
    const loop = new HostStepLoop({
      transport,
      runner: runner(async () => ({ ok: true }), false),
    });

    expect(await loop.tick(HOST)).toBe(true);
    // 放置すると cloud 側は走っていると思って待ち続ける
    expect(transport.failed[0]!.error.code).toBe('host.unsupported_step');
    expect(transport.completed).toEqual([]);
  });

  it('does not report success when the runner itself throws', async () => {
    const transport = fakeTransport([step()]);
    const seen: Error[] = [];
    const loop = new HostStepLoop({
      transport,
      runner: runner(async () => {
        throw new Error('keychain is locked');
      }),
      onError: (e) => seen.push(e),
    });

    await loop.tick(HOST);
    expect(transport.completed).toEqual([]);
    expect(transport.failed).toHaveLength(1);
    expect(seen[0]!.message).toContain('keychain');
    // 端末の中の言葉をそのまま外へ出さない（§7.2）
    expect(transport.failed[0]!.error.message).not.toContain('keychain');
  });

  it('frees itself after a step that threw, so the next one can run', async () => {
    const transport = fakeTransport([step({ id: 'a' }), step({ id: 'b' })]);
    let calls = 0;
    const loop = new HostStepLoop({
      transport,
      runner: runner(async () => {
        calls += 1;
        if (calls === 1) throw new Error('boom');
        return { ok: true, result: null };
      }),
    });

    await loop.tick(HOST);
    expect(loop.busyWith).toBeNull();
    await loop.tick(HOST);
    expect(transport.completed).toEqual([{ id: 'b', result: null }]);
  });

  it('keeps going when the server cannot be reached', async () => {
    let attempts = 0;
    const transport: StepTransport = {
      async claim() {
        attempts += 1;
        if (attempts < 3) throw new Error('network down');
        return null;
      },
      async complete() {},
      async fail() {},
    };
    const seen: Error[] = [];
    const loop = new HostStepLoop({
      transport,
      runner: runner(async () => ({ ok: true })),
      idleMs: 0,
      sleep: async () => {
        if (attempts >= 3) loop.stop();
      },
      onError: (e) => seen.push(e),
    });

    await loop.start(HOST);
    expect(seen.map((e) => e.message)).toEqual(['network down', 'network down']);
  });
});

describe('reporting the result after a restart', () => {
  const noWait = async () => undefined;

  it('retries a transient failure to report success, and keeps it a success', async () => {
    const transport = fakeTransport([step()]);
    let attempts = 0;
    const flaky: StepTransport = {
      ...transport,
      async complete(id, hostId, result) {
        attempts++;
        if (attempts < 3) throw new TypeError('fetch failed');
        await transport.complete(id, hostId, result);
      },
    };
    const loop = new HostStepLoop({
      transport: flaky,
      runner: runner(async () => ({ ok: true, result: 1 })),
      sleep: noWait,
    });
    expect(await loop.tick(HOST)).toBe(true);
    expect(attempts).toBe(3);
    expect(transport.completed).toEqual([{ id: 'req-1', result: 1 }]);
    expect(transport.failed).toEqual([]);
  });

  it('never turns a success it could not report into a failure', async () => {
    const transport = fakeTransport([step()]);
    const errors: string[] = [];
    const down: StepTransport = {
      ...transport,
      async complete() {
        throw new TypeError('fetch failed');
      },
    };
    const loop = new HostStepLoop({
      transport: down,
      runner: runner(async () => ({ ok: true, result: 1 })),
      sleep: noWait,
      onError: (e) => errors.push(e.message),
    });
    expect(await loop.tick(HOST)).toBe(true);
    expect(transport.failed).toEqual([]);
    expect(errors.some((m) => m.includes('could not be reported'))).toBe(true);
  });

  it('does not retry an error that is not transient', async () => {
    const transport = fakeTransport([step()]);
    let attempts = 0;
    const denied: StepTransport = {
      ...transport,
      async complete() {
        attempts++;
        throw new Error('403 forbidden');
      },
    };
    const loop = new HostStepLoop({
      transport: denied,
      runner: runner(async () => ({ ok: true, result: 1 })),
      sleep: noWait,
    });
    await loop.tick(HOST);
    expect(attempts).toBe(1);
  });
});
