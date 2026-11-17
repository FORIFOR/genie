import { beforeEach, describe, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({
  calls: [] as string[],
  fail: true,
  videoPatch: true,
  generalPatch: true,
}));
vi.mock('@temporalio/workflow', () => ({
  ApplicationFailure: { nonRetryable: (message: string) => new Error(message) },
  condition: async () => true,
  defineQuery: (name: string) => name,
  defineSignal: (name: string) => name,
  setHandler: () => {},
  patched: (name: string) =>
    (name !== 'video-render-single-attempt-v1' || state.videoPatch) &&
    (name !== 'general-generation-single-attempt-v1' || state.generalPatch),
  workflowInfo: () => ({ runId: 'test' }),
  proxyActivities: (options: { retry?: { maximumAttempts?: number } }) =>
    new Proxy(
      {},
      {
        get: (_object, name: string) => async (_input: unknown, step: { toolId?: string }) => {
          if (name !== 'executeStep') return null;
          // Model the Temporal retry policy at the activity boundary, including a
          // timeout where the activity catch block could not run.
          const attempts = options.retry?.maximumAttempts ?? 1;
          for (let i = 0; i < attempts; i++) {
            state.calls.push(step.toolId!);
            if (!state.fail) return {};
          }
          throw new Error('activity timed out after provider accepted request');
        },
      },
    ),
}));
import { TaskWorkflow } from '../src/workflows.js';
import type { TaskPlan } from '../src/plan.js';

beforeEach(() => {
  state.calls = [];
  state.fail = true;
  state.videoPatch = true;
  state.generalPatch = true;
});
describe('paid activity timeout policy', () => {
  it.each([
    'llm.answer',
    'llm.compose',
    'general.answer',
    'general.compose',
    'search.web',
    'research.plan',
    'research.search',
    'research.deepen',
    'research.verify',
    'research.report',
    'meeting.transcribe',
    'meeting.summarize',
    'meeting.bundle',
  ])('does not automatically submit %s again', async (toolId) => {
    const plan: TaskPlan = {
      steps: [{ index: 0, toolId, risk: 'READ', surface: 'cloud', message: 'test', args: {} }],
      artifact: { type: 'DOCUMENT', title: 'Test', format: 'markdown' } as never,
    };
    await expect(
      TaskWorkflow({ taskId: 't', tenantId: 'tenant', userId: 'u', kind: 'test', input: {}, plan }),
    ).rejects.toThrow('timed out');
    expect(state.calls).toEqual([toolId]);
  });
  it('preserves retry for an ordinary connector read', async () => {
    const plan: TaskPlan = {
      steps: [
        {
          index: 0,
          toolId: 'calendar.list',
          risk: 'READ',
          surface: 'local',
          message: 'test',
          args: {},
        },
      ],
      artifact: {} as never,
    };
    await expect(
      TaskWorkflow({ taskId: 't', tenantId: 'tenant', userId: 'u', kind: 'test', input: {}, plan }),
    ).rejects.toThrow();
    expect(state.calls).toHaveLength(5);
  });

  it.each([
    { patched: true, attempts: 1 },
    { patched: false, attempts: 5 },
  ])(
    'video timeout uses $attempts attempt(s) with new marker=$patched',
    async ({ patched, attempts }) => {
      state.videoPatch = patched;
      const plan: TaskPlan = {
        steps: [
          {
            index: 0,
            toolId: 'video.render',
            risk: 'REVERSIBLE_WRITE',
            surface: 'cloud',
            message: '動画を書き出す',
            args: { project_id: 'video-project' },
          },
        ],
        artifact: { type: 'OTHER', title: 'Video', mimeType: 'video/mp4' },
      };
      await expect(
        TaskWorkflow({
          taskId: 't',
          tenantId: 'tenant',
          userId: 'u',
          kind: 'video',
          input: {},
          plan,
        }),
      ).rejects.toThrow('timed out');
      expect(state.calls).toEqual(Array(attempts).fill('video.render'));
    },
  );
});

it('retains the old activity command when replaying a general-generation history', async () => {
  state.generalPatch = false;
  const plan: TaskPlan = {
    steps: [
      {
        index: 0,
        toolId: 'general.compose',
        risk: 'READ',
        surface: 'cloud',
        message: 'test',
        args: {},
      },
    ],
    artifact: { type: 'DOCUMENT', title: 'Test', mimeType: 'text/markdown' },
  };
  await expect(
    TaskWorkflow({ taskId: 't', tenantId: 'tenant', userId: 'u', kind: 'test', input: {}, plan }),
  ).rejects.toThrow();
  expect(state.calls).toEqual(Array(5).fill('general.compose'));
});
