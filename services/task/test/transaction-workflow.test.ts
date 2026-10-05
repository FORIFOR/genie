import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TaskStep } from '../src/plan.js';
import { transactionFixture } from './transaction-fixture.js';

const state = vi.hoisted(() => ({
  handlers: new Map<string, (value: unknown) => void>(),
  calls: [] as { name: string; args: unknown[] }[],
  prepared: null as unknown,
  result: null as unknown,
  approvalError: false,
  instructionDuringApproval: false,
  cancelDuringAccept: false,
  afterHostResume: '' as '' | 'cancel' | 'instruct',
  offlineOnce: false,
  submitError: null as Error | null,
  cancelDuringExecute: false,
  failurePatch: true,
  fallbackPatch: true,
  failureOutcome: { status: 'FAILED', artifactId: null } as {
    status: string;
    artifactId: string | null;
  },
}));
vi.mock('@temporalio/workflow', () => ({
  ApplicationFailure: { nonRetryable: (message: string) => new Error(message) },
  condition: async () => {
    if (state.instructionDuringApproval)
      state.handlers.get('instruct')?.({ requestId: 'changed', text: '数量を増やして' });
    state.handlers.get('approve')?.({ approvalId: 'approval', decision: 'APPROVED' });
    return true;
  },
  defineQuery: (name: string) => name,
  defineSignal: (name: string) => name,
  setHandler: (name: string, handler: (value: unknown) => void) =>
    state.handlers.set(name, handler),
  patched: (name: string) =>
    name === 'transaction-cancel-failure-v1'
      ? state.failurePatch
      : name === 'transaction-unknown-fallback-v1'
        ? state.fallbackPatch
        : true,
  workflowInfo: () => ({ runId: 'test' }),
  proxyActivities: () =>
    new Proxy(
      {},
      {
        get:
          (_target, name: string) =>
          async (...args: unknown[]) => {
            state.calls.push({ name, args });
            const step = args[1] as TaskStep;
            if (name === 'requestApprovalIfNeeded' && step.toolId === 'transaction.submit') {
              if (state.approvalError) throw new Error('expired quote');
              return { approvalId: 'approval' };
            }
            if (name === 'acceptApproval' && state.cancelDuringAccept)
              state.handlers.get('cancel')?.({ reason: 'user_requested' });
            if (name === 'hostAvailable') return true;
            if (name === 'resumeFromHost' && state.afterHostResume)
              state.handlers.get(state.afterHostResume)?.(
                state.afterHostResume === 'cancel'
                  ? { reason: 'user_requested' }
                  : { requestId: 'changed-after-offline', text: '数量を変えて' },
              );
            if (
              name === 'executeStep' &&
              step.toolId === 'transaction.submit' &&
              state.offlineOnce
            ) {
              state.offlineOnce = false;
              throw { type: 'HostOffline' };
            }
            if (name === 'executeStep' && step.toolId === 'transaction.submit') {
              if (state.cancelDuringExecute)
                state.handlers.get('cancel')?.({ reason: 'user_requested' });
              if (state.submitError) throw state.submitError;
            }
            if (name === 'executeStep')
              return step.toolId === 'transaction.prepare' ? state.prepared : state.result;
            if (name === 'composeArtifact') return 'artifact';
            if (name === 'completeTask') return { status: 'COMPLETED', artifactId: 'artifact' };
            if (name === 'cancelTask') return { status: 'CANCELLED', artifactId: null };
            if (name === 'failTask') return state.failureOutcome;
            return null;
          },
      },
    ),
}));
import { TaskWorkflow } from '../src/workflows.js';

beforeEach(() => {
  state.calls = [];
  state.handlers.clear();
  state.prepared = null;
  state.result = null;
  state.approvalError = false;
  state.instructionDuringApproval = false;
  state.cancelDuringAccept = false;
  state.afterHostResume = '';
  state.offlineOnce = false;
  state.submitError = null;
  state.cancelDuringExecute = false;
  state.failurePatch = true;
  state.fallbackPatch = true;
  state.failureOutcome = { status: 'FAILED', artifactId: null };
});
async function setup() {
  const fixture = await transactionFixture();
  state.prepared = fixture.prepared;
  state.result = fixture.result;
  return {
    fixture,
    input: {
      taskId: 'task',
      tenantId: 'tenant',
      userId: 'user',
      kind: 'transaction.order',
      input: { intent: fixture.intent },
    },
  };
}
describe('transaction workflow approval ordering', () => {
  async function unknownFailure() {
    const f = await setup();
    const { observation: _observation, ...identity } = f.fixture.result;
    const transactionResult = { ...identity, status: 'unknown' };
    state.submitError = new Error('Activity task failed', {
      cause: Object.assign(new Error('注文結果は未確認です。再注文せず照会してください。'), {
        details: ['再送していません。', { transactionResult }],
      }),
    });
    return { ...f, transactionResult };
  }

  it.each([false, true])(
    'returns persisted cancellation with unknown order identity when cancel signal arrived=%s',
    async (signalled) => {
      const { input, transactionResult, fixture } = await unknownFailure();
      state.cancelDuringExecute = signalled;
      // false models the DB stop reaching the host before the workflow signal.
      state.failureOutcome = { status: 'CANCELLED', artifactId: null };
      expect(await TaskWorkflow(input)).toEqual(state.failureOutcome);
      const failure = state.calls.find((call) => call.name === 'failTask')!;
      expect(failure.args[1]).toMatchObject({
        message: '注文結果は未確認です。再注文せず照会してください。',
        transaction_result: transactionResult,
        retryable: false,
      });
      expect(failure.args[2]).toEqual({
        preserveCancellation: true,
        ...(signalled ? { cancellationReason: 'user_requested' } : {}),
        transactionSubmission: { stepIndex: 1, args: fixture.submitArgs },
      });
      expect(state.calls.filter((call) => call.name === 'executeStep')).toHaveLength(2);
      expect(
        state.calls.some((call) =>
          ['composeArtifact', 'completeTask', 'cancelTask'].includes(call.name),
        ),
      ).toBe(false);
    },
  );

  it('does not claim cancellation if persistence reports an already committed completion', async () => {
    const { input } = await unknownFailure();
    state.cancelDuringExecute = true;
    state.failureOutcome = { status: 'COMPLETED', artifactId: 'original-receipt' };
    expect(await TaskWorkflow(input)).toEqual(state.failureOutcome);
  });

  it('retains the unpatched failure command and old void activity result during replay', async () => {
    const { input } = await unknownFailure();
    state.failurePatch = false;
    state.cancelDuringExecute = true;
    state.failureOutcome = undefined as unknown as typeof state.failureOutcome;
    await expect(TaskWorkflow(input)).rejects.toThrow('Activity task failed');
    const failure = state.calls.find((call) => call.name === 'failTask')!;
    expect(failure.args).toHaveLength(2);
    expect(failure.args[1]).not.toHaveProperty('transaction_result');
    expect(state.calls.some((call) => call.name === 'cancelTask')).toBe(false);
  });

  it('offers only the scheduled approved args for persisted-claim lookup after a lost activity result', async () => {
    const { input, fixture } = await setup();
    state.submitError = Object.assign(new Error('Activity timed out'), { type: 'TimeoutFailure' });
    state.failureOutcome = { status: 'CANCELLED', artifactId: null };
    expect(await TaskWorkflow(input)).toEqual(state.failureOutcome);
    const failure = state.calls.find((call) => call.name === 'failTask')!;
    expect(failure.args[1]).not.toHaveProperty('transaction_result');
    expect(failure.args[2]).toMatchObject({
      transactionSubmission: { stepIndex: 1, args: fixture.submitArgs },
    });
    expect(state.calls.filter((call) => call.name === 'executeStep')).toHaveLength(2);
  });

  it('does not change the first cancellation patch command when replaying before the lookup fallback patch', async () => {
    const { input } = await unknownFailure();
    state.fallbackPatch = false;
    await expect(TaskWorkflow(input)).rejects.toThrow('Activity task failed');
    expect(state.calls.find((call) => call.name === 'failTask')!.args[2]).toEqual({
      preserveCancellation: true,
    });
  });

  it('keeps an unconfirmed order as failure when no cancellation was persisted', async () => {
    const { input, transactionResult } = await unknownFailure();
    await expect(TaskWorkflow(input)).rejects.toThrow('Activity task failed');
    expect(state.calls.find((call) => call.name === 'failTask')!.args[1]).toMatchObject({
      transaction_result: transactionResult,
    });
    expect(state.calls.some((call) => call.name === 'cancelTask')).toBe(false);
  });

  it('honours stop received during approval acceptance before dispatch', async () => {
    const { input } = await setup();
    state.cancelDuringAccept = true;
    expect(await TaskWorkflow(input)).toEqual({ status: 'CANCELLED', artifactId: null });
    expect(state.calls.filter((call) => call.name === 'executeStep')).toHaveLength(1);
  });
  it.each(['cancel', 'instruct'] as const)(
    'rechecks %s after the host resumes without another submit attempt',
    async (change) => {
      const { input } = await setup();
      state.offlineOnce = true;
      state.afterHostResume = change;
      if (change === 'cancel')
        expect(await TaskWorkflow(input)).toEqual({ status: 'CANCELLED', artifactId: null });
      else await expect(TaskWorkflow(input)).rejects.toThrow('追加指示');
      expect(state.calls.filter((call) => call.name === 'executeStep')).toHaveLength(2);
      expect(state.calls.some((call) => call.name === 'completeTask')).toBe(false);
    },
  );
  it('shows and dispatches the same fixed quote, then titles the observed acceptance accurately', async () => {
    const { fixture, input } = await setup();
    expect(await TaskWorkflow(input)).toEqual({ status: 'COMPLETED', artifactId: 'artifact' });
    const shown = state.calls.find(
      (call) =>
        call.name === 'requestApprovalIfNeeded' &&
        (call.args[1] as TaskStep).toolId === 'transaction.submit',
    );
    const sent = state.calls.find(
      (call) =>
        call.name === 'executeStep' && (call.args[1] as TaskStep).toolId === 'transaction.submit',
    );
    expect((shown!.args[1] as TaskStep).args).toEqual(fixture.submitArgs);
    expect(sent!.args[1]).toEqual(shown!.args[1]);
    expect(state.calls.find((call) => call.name === 'composeArtifact')!.args[1]).toMatchObject({
      title: 'シミュレーション: 注文を受け付けました（配達・約定完了ではありません）',
    });
    expect(state.calls.filter((call) => call.name === 'executeStep')).toHaveLength(2);
  });
  it.each(['missing quote', 'expired quote', 'changed instruction', 'unknown result'])(
    'records failure and never reports completion for %s',
    async (scenario) => {
      const { fixture, input } = await setup();
      if (scenario === 'missing quote') state.prepared = {};
      if (scenario === 'expired quote') state.approvalError = true;
      if (scenario === 'changed instruction') state.instructionDuringApproval = true;
      if (scenario === 'unknown result')
        state.result = { ...fixture.result, status: 'unknown', observation: undefined };
      await expect(TaskWorkflow(input)).rejects.toThrow();
      expect(state.calls.some((call) => call.name === 'failTask')).toBe(true);
      expect(
        state.calls.some((call) => ['composeArtifact', 'completeTask'].includes(call.name)),
      ).toBe(false);
      if (scenario !== 'unknown result')
        expect(state.calls.filter((call) => call.name === 'executeStep')).toHaveLength(1);
      if (scenario !== 'unknown result')
        expect(state.calls.find((call) => call.name === 'failTask')!.args[2]).not.toHaveProperty(
          'transactionSubmission',
        );
    },
  );
});
