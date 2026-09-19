import { describe, it, expect, vi } from 'vitest';
import { HostStepLoop } from '../src/step-loop.js';
import type { HostStep } from '../src/connector-steps.js';
const step: HostStep = {
  id: 'request',
  taskId: 'task',
  toolId: 'execution.apply',
  args: {},
  approval: null,
};
describe('TaskDock stop reaches the actual running host step', () => {
  it('stops before invoking a cancelled task', async () => {
    const run = vi.fn();
    const complete = vi.fn();
    const fail = vi.fn(async () => {});
    await new HostStepLoop({
      transport: { claim: async () => step, shouldCancel: async () => true, complete, fail },
      runner: { handles: () => true, run },
    }).tick('host');
    expect(run).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
    expect(fail).toHaveBeenCalled();
  });
  it('fails closed when task ownership/status cannot be checked', async () => {
    const run = vi.fn();
    const complete = vi.fn();
    const fail = vi.fn(async () => {});
    await new HostStepLoop({
      transport: {
        claim: async () => step,
        shouldCancel: async () => {
          throw new Error('401');
        },
        complete,
        fail,
      },
      runner: { handles: () => true, run },
    }).tick('host');
    expect(run).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
  });
  it('aborts during execution and never reports success after cancellation', async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    const complete = vi.fn();
    const fail = vi.fn(async () => {});
    let checks = 0;
    const loop = new HostStepLoop({
      transport: {
        claim: async () => step,
        shouldCancel: async () => ++checks > 1,
        complete,
        fail,
      },
      runner: {
        handles: () => true,
        run: async (_step, s) => {
          signal = s;
          await new Promise<void>((resolve) =>
            s!.addEventListener('abort', () => resolve(), { once: true }),
          );
          return { ok: true };
        },
      },
    });
    try {
      const pending = loop.tick('host');
      await vi.advanceTimersByTimeAsync(1001);
      await pending;
      expect(signal?.aborted).toBe(true);
      expect(complete).not.toHaveBeenCalled();
      expect(fail).toHaveBeenCalledWith(
        'request',
        'host',
        expect.objectContaining({ code: 'execution.cancelled' }),
      );
    } finally {
      vi.useRealTimers();
    }
  });
});
