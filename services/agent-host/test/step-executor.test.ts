import { describe, expect, it, vi } from 'vitest';
import type { HostBridge } from '../src/bridge.js';
import { HostStepCancelled, HostStepExecutor, HostStepFailed } from '../src/step-executor.js';

describe('host failed transaction outcome', () => {
  it('retains unknown business identity across the executor without completing or resubmitting', async () => {
    const result = {
      status: 'unknown',
      provider: 'fixture',
      mode: 'simulation',
      account: 'account',
      orderKey: 'order-1',
      quoteHash: 'a'.repeat(64),
    };
    const bridge = {
      hasOnlineHost: vi.fn(async () => true),
      request: vi.fn(async () => ({ id: 'request-1' })),
      get: vi.fn(async () => ({
        id: 'request-1',
        status: 'FAILED',
        result,
        error: { code: 'transaction.result_unknown', message: '照会してください。' },
      })),
    };
    const executor = new HostStepExecutor({ bridge: bridge as unknown as HostBridge });
    const error = await executor
      .execute(
        { tenantId: 'tenant', taskId: 'task', userId: 'user' },
        { index: 1, toolId: 'transaction.submit', args: {} },
      )
      .then(
        () => undefined,
        (error) => error,
      );
    expect(error).toBeInstanceOf(HostStepFailed);
    expect(error).toMatchObject({ code: 'transaction.result_unknown', result });
    expect(bridge.request).toHaveBeenCalledOnce();
    expect(bridge.get).toHaveBeenCalledOnce();
  });
});

describe('a stopped task does not keep waiting for the device', () => {
  const task = { tenantId: 'tenant', taskId: 'task', userId: 'user' };
  const step = { index: 0, toolId: 'llm.answer', args: {} };
  const settle = (promise: Promise<unknown>): Promise<unknown> =>
    promise.then(
      () => undefined,
      (error) => error,
    );

  it('ends the wait as cancelled, not failed or offline, once the unclaimed request is withdrawn', async () => {
    const withdrawn = [false, false, true];
    const bridge = {
      hasOnlineHost: vi.fn(async () => true),
      request: vi.fn(async () => ({ id: 'request-1' })),
      get: vi.fn(async () => ({ id: 'request-1', status: 'PENDING' })),
      withdrawUnclaimed: vi.fn(async () => withdrawn.shift() ?? true),
    };
    const sleep = vi.fn(async () => {});
    const executor = new HostStepExecutor({ bridge: bridge as unknown as HostBridge, sleep });
    const error = await settle(executor.execute(task, step));
    expect(error).toBeInstanceOf(HostStepCancelled);
    expect((error as Error).name).toBe(HostStepCancelled.TYPE);
    expect(bridge.withdrawUnclaimed).toHaveBeenCalledTimes(3);
    expect(bridge.withdrawUnclaimed).toHaveBeenCalledWith('tenant', 'request-1');
    // Two polls waited; the third ended the wait instead of running to the 10-minute limit.
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it('never withdraws a request the device has claimed and still takes its result', async () => {
    const states = [
      { id: 'request-1', status: 'CLAIMED' },
      { id: 'request-1', status: 'CLAIMED' },
      { id: 'request-1', status: 'DONE', result: { sent: true } },
    ];
    const bridge = {
      hasOnlineHost: vi.fn(async () => true),
      request: vi.fn(async () => ({ id: 'request-1' })),
      get: vi.fn(async () => states.shift()),
      withdrawUnclaimed: vi.fn(async () => true),
    };
    const executor = new HostStepExecutor({
      bridge: bridge as unknown as HostBridge,
      sleep: async () => {},
    });
    expect(await executor.execute(task, step)).toMatchObject({ result: { sent: true } });
    expect(bridge.withdrawUnclaimed).not.toHaveBeenCalled();
  });
});
