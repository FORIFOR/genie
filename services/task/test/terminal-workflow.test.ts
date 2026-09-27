import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  handlers: new Map<string, (value: unknown) => void>(),
  calls: [] as string[],
  cancelDuringCompose: false,
  completion: { status: 'COMPLETED', artifactId: 'artifact' } as {
    status: string;
    artifactId: string | null;
  },
  cancellation: { status: 'CANCELLED', artifactId: null } as {
    status: string;
    artifactId: string | null;
  },
  patch: true,
}));
vi.mock('@temporalio/workflow', () => ({
  ApplicationFailure: { nonRetryable: (message: string) => new Error(message) },
  condition: async () => true,
  defineQuery: (name: string) => name,
  defineSignal: (name: string) => name,
  setHandler: (name: string, handler: (value: unknown) => void) =>
    state.handlers.set(name, handler),
  patched: (name: string) => name !== 'task-terminal-outcome-v1' || state.patch,
  workflowInfo: () => ({ runId: 'test' }),
  proxyActivities: () =>
    new Proxy(
      {},
      {
        get: (_target, name: string) => async () => {
          state.calls.push(name);
          if (name === 'composeArtifact') {
            if (state.cancelDuringCompose)
              state.handlers.get('cancel')?.({ reason: 'user_requested' });
            return 'artifact';
          }
          if (name === 'completeTask') return state.completion;
          if (name === 'cancelTask') return state.cancellation;
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
  state.handlers.clear();
  state.calls = [];
  state.cancelDuringCompose = false;
  state.patch = true;
  state.completion = { status: 'COMPLETED', artifactId: 'artifact' };
  state.cancellation = { status: 'CANCELLED', artifactId: null };
});
describe('terminal outcome is the committed outcome', () => {
  it('honours cancellation arriving while the artifact is composed', async () => {
    state.cancelDuringCompose = true;
    expect(await TaskWorkflow(input)).toEqual({ status: 'CANCELLED', artifactId: null });
    expect(state.calls).not.toContain('completeTask');
    expect(state.calls.filter((x) => x === 'cancelTask')).toHaveLength(1);
  });
  it('honours a committed cancellation request before its signal arrives', async () => {
    state.completion = { status: 'CANCELLING', artifactId: null };
    expect(await TaskWorkflow(input)).toEqual({ status: 'CANCELLED', artifactId: null });
    expect(state.calls).toContain('cancelTask');
  });
  it('returns the original persisted artifact on completion retry', async () => {
    state.completion = { status: 'COMPLETED', artifactId: 'original-artifact' };
    expect(await TaskWorkflow(input)).toEqual(state.completion);
  });
  it('does not report cancelled when completion already committed', async () => {
    state.cancelDuringCompose = true;
    state.cancellation = { status: 'COMPLETED', artifactId: 'committed-artifact' };
    expect(await TaskWorkflow(input)).toEqual(state.cancellation);
  });
  it('preserves the unpatched historical command path', async () => {
    state.patch = false;
    state.cancelDuringCompose = true;
    expect(await TaskWorkflow(input)).toEqual({ status: 'COMPLETED', artifactId: 'artifact' });
    expect(state.calls).not.toContain('cancelTask');
  });
});
