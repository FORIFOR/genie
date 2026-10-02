import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  patch: true,
  failure: { status: 'CANCELLED', artifactId: null } as { status: string; artifactId: null },
  failTaskArgs: [] as unknown[][],
  calls: [] as string[],
  handlers: new Map<string, (value: unknown) => void>(),
  cancelDuringStep: false,
}));
vi.mock('@temporalio/workflow', () => ({
  ApplicationFailure: { nonRetryable: (message: string) => new Error(message) },
  condition: async () => true,
  defineQuery: (name: string) => name,
  defineSignal: (name: string) => name,
  setHandler: (name: string, handler: (value: unknown) => void) =>
    state.handlers.set(name, handler),
  patched: (name: string) => name !== 'step-cancel-preserve-v1' || state.patch,
  workflowInfo: () => ({ runId: 'test' }),
  proxyActivities: () =>
    new Proxy(
      {},
      {
        get:
          (_target, name: string) =>
          async (...args: unknown[]) => {
            state.calls.push(name);
            if (name === 'executeStep') {
              if (state.cancelDuringStep)
                state.handlers.get('cancel')?.({ reason: 'user_requested' });
              throw new Error('activity StartToClose timeout');
            }
            if (name === 'failTask') {
              state.failTaskArgs.push(args);
              return state.failure;
            }
            return null;
          },
      },
    ),
}));
import { TaskWorkflow } from '../src/workflows.js';

const input = {
  taskId: 'task',
  tenantId: 'tenant',
  userId: 'user',
  kind: 'echo',
  input: { message: 'test', steps: 1 },
};
beforeEach(() => {
  state.patch = true;
  state.failure = { status: 'CANCELLED', artifactId: null };
  state.failTaskArgs = [];
  state.calls = [];
  state.handlers.clear();
  state.cancelDuringStep = false;
});

describe('an accepted stop survives a later step failure', () => {
  it('ends cancelled when the stop was committed before the step timed out', async () => {
    expect(await TaskWorkflow(input)).toEqual({ status: 'CANCELLED', artifactId: null });
    expect(state.failTaskArgs).toHaveLength(1);
    expect(state.failTaskArgs[0]![2]).toEqual({ preserveCancellation: true });
  });

  it('passes the stop reason when its signal arrived during the step', async () => {
    state.cancelDuringStep = true;
    expect(await TaskWorkflow(input)).toEqual({ status: 'CANCELLED', artifactId: null });
    expect(state.failTaskArgs[0]![2]).toEqual({
      preserveCancellation: true,
      cancellationReason: 'user_requested',
    });
    expect(state.calls).not.toContain('cancelTask');
  });

  it('still fails an ordinary step failure that nobody stopped', async () => {
    state.failure = { status: 'FAILED', artifactId: null };
    await expect(TaskWorkflow(input)).rejects.toThrow('activity StartToClose timeout');
    expect(state.failTaskArgs).toHaveLength(1);
  });

  it('keeps the original failure command when replaying histories without the marker', async () => {
    state.patch = false;
    await expect(TaskWorkflow(input)).rejects.toThrow('activity StartToClose timeout');
    expect(state.failTaskArgs).toHaveLength(1);
    expect(state.failTaskArgs[0]).toHaveLength(2);
  });
});
