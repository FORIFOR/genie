/**
 * 画面操作を、1 回の承認のまま区切って続ける（目的ごとに 1 回の承認、2026-10-19）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({
  steps: [] as { requestKey?: string | undefined; segment?: unknown }[],
  /** 区切りごとの返し方。'ended' は上限で区切れた、'failed' は別の止まり方、'done' は終わった。 */
  outcomes: [] as ('ended' | 'failed' | 'done')[],
  patch: true,
}));
vi.mock('@temporalio/workflow', () => ({
  ApplicationFailure: {
    nonRetryable: (message: string, type?: string) => Object.assign(new Error(message), { type }),
  },
  condition: async () => true,
  defineQuery: (name: string) => name,
  defineSignal: (name: string) => name,
  setHandler: () => {},
  patched: (name: string) => name !== 'computer-run-segments-v1' || state.patch,
  workflowInfo: () => ({ runId: 'test' }),
  proxyActivities: () =>
    new Proxy(
      {},
      {
        get:
          (_object, name: string) =>
          async (
            _input: unknown,
            step: { requestKey?: string; args?: Record<string, unknown> },
          ) => {
            if (name === 'completeTask') return { status: 'COMPLETED', artifactId: null };
            if (name !== 'executeStep') return null;
            state.steps.push({ requestKey: step.requestKey, segment: step.args?.['segment'] });
            const outcome = state.outcomes.shift() ?? 'done';
            if (outcome === 'done') return { completed: true };
            // Temporal は activity の失敗を ActivityFailure で包み、元の種類は cause に残る
            throw Object.assign(new Error('activity failed'), {
              cause: Object.assign(new Error('stopped'), {
                type: outcome === 'ended' ? 'ComputerRunSegmentEnded' : 'ExternalActionFailed',
              }),
            });
          },
      },
    ),
}));
import { TaskWorkflow } from '../src/workflows.js';
import { COMPUTER_RUN_SEGMENTS, planTask } from '../src/plan.js';

const run = () =>
  TaskWorkflow({
    taskId: 't',
    tenantId: 'tenant',
    userId: 'u',
    kind: 'computer.run',
    input: {},
    plan: planTask('computer.run', { goal: 'Google Cloud で Speech-to-Text を有効にする手前まで' }),
  });

beforeEach(() => {
  state.steps = [];
  state.outcomes = [];
  state.patch = true;
});

describe('computer.run segments under one approval', () => {
  it('continues after a segment ends at its limit, each part with its own hand-off', async () => {
    state.outcomes = ['ended', 'ended', 'done'];
    await expect(run()).resolves.toMatchObject({ status: 'COMPLETED' });
    expect(state.steps).toEqual([
      { requestKey: undefined, segment: undefined },
      { requestKey: 'segment-1', segment: 1 },
      { requestKey: 'segment-2', segment: 2 },
    ]);
  });

  it('stops after the last allowed segment', async () => {
    state.outcomes = Array(COMPUTER_RUN_SEGMENTS + 2).fill('ended');
    await expect(run()).rejects.toThrow('activity failed');
    expect(state.steps).toHaveLength(COMPUTER_RUN_SEGMENTS);
  });

  it('does not continue after any other kind of stop', async () => {
    state.outcomes = ['failed', 'done'];
    await expect(run()).rejects.toThrow('activity failed');
    expect(state.steps).toHaveLength(1);
  });

  it('replays an old history without segments', async () => {
    state.patch = false;
    state.outcomes = ['ended', 'done'];
    await expect(run()).rejects.toThrow('activity failed');
    expect(state.steps).toHaveLength(1);
  });
});
