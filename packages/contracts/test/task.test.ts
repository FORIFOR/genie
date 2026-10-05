import { describe, expect, it } from 'vitest';
import {
  CreateTaskRequest,
  TASK_STATUSES,
  TASK_TRANSITIONS,
  TERMINAL_TASK_STATUSES,
  Task,
  TaskError,
  TaskDockState,
  canTransition,
  dockStateFor,
  isTerminal,
} from '../src/task.js';
import { uuidv7 } from '../src/uuid.js';

describe('task state machine', () => {
  it('has a transition entry for every status', () => {
    for (const s of TASK_STATUSES) expect(TASK_TRANSITIONS[s]).toBeDefined();
  });

  it('never leaves a terminal status', () => {
    for (const s of TERMINAL_TASK_STATUSES) {
      expect(TASK_TRANSITIONS[s]).toEqual([]);
      expect(isTerminal(s)).toBe(true);
      expect(canTransition(s, 'RUNNING')).toBe(false);
    }
  });

  it('allows same-status transitions so activity retries are no-ops', () => {
    for (const s of TASK_STATUSES) expect(canTransition(s, s)).toBe(true);
  });

  it('models the approval round trip', () => {
    expect(canTransition('RUNNING', 'WAITING_APPROVAL')).toBe(true);
    expect(canTransition('WAITING_APPROVAL', 'RUNNING')).toBe(true);
    expect(canTransition('WAITING_APPROVAL', 'CANCELLED')).toBe(true);
    expect(canTransition('WAITING_APPROVAL', 'COMPLETED')).toBe(false);
  });

  it('routes cancellation through CANCELLING', () => {
    expect(canTransition('RUNNING', 'CANCELLED')).toBe(false);
    expect(canTransition('RUNNING', 'CANCELLING')).toBe(true);
    expect(canTransition('CANCELLING', 'CANCELLED')).toBe(true);
  });
});

describe('task dock state mapping', () => {
  it('covers every server status', () => {
    for (const s of TASK_STATUSES) expect(dockStateFor(s)).toBeTruthy();
  });

  it('collapses every running status into a single WORKING face', () => {
    // UI/UX §1.2「Show Work, Not Agents」: どの工程かは Work Surface の step が示す
    expect(dockStateFor('PENDING')).toBe('WORKING');
    expect(dockStateFor('RUNNING')).toBe('WORKING');
    expect(dockStateFor('CANCELLING')).toBe('WORKING');
    expect(dockStateFor('WAITING_APPROVAL')).toBe('WAITING_APPROVAL');
    expect(dockStateFor('COMPLETED')).toBe('RESULT');
    expect(dockStateFor('CANCELLED')).toBe('READY');
  });

  it('separates failures a retry can fix from ones needing a person', () => {
    // UI/UX §3・§21: 見せる next action が違うので同じ状態にしない
    const retryable = {
      code: 'common.unavailable' as const,
      message: 'x',
      step_index: 0,
      retryable: true,
      recovery: 'retry' as const,
    };
    const blocked = {
      code: 'plugin.permission_denied' as const,
      message: 'x',
      step_index: 0,
      retryable: false,
      recovery: 'grant_permission' as const,
    };
    expect(dockStateFor('FAILED', retryable)).toBe('FAILED_RECOVERABLE');
    expect(dockStateFor('FAILED', blocked)).toBe('FAILED_BLOCKED');
    // 情報が無いときは「再試行できるかもしれない」側に倒す
    expect(dockStateFor('FAILED')).toBe('FAILED_RECOVERABLE');
  });

  it('has no state the UI/UX spec does not declare', () => {
    // UI/UX §3 の Global Interaction State Machine と一致していること
    expect(new Set(TaskDockState.options)).toEqual(
      new Set([
        'HIDDEN',
        'READY',
        'LISTENING',
        'TYPING',
        'UNDERSTANDING',
        'WORKING',
        'WAITING_APPROVAL',
        'RESULT',
        'FAILED_RECOVERABLE',
        'FAILED_BLOCKED',
        'MINIMIZED',
      ]),
    );
  });
});

describe('task schemas', () => {
  it('retains an unconfirmed order lookup identity without accepting a receipt or external cancellation claim', () => {
    const transaction_result = {
      mode: 'simulation',
      provider: 'fixture',
      account: 'fixture-account',
      orderKey: 'order-1',
      quoteHash: 'a'.repeat(64),
      status: 'unknown',
    };
    const error = {
      code: 'task.step_failed',
      message: 'Unconfirmed',
      step_index: 1,
      retryable: false,
    };
    expect(TaskError.parse({ ...error, transaction_result }).transaction_result).toEqual(
      transaction_result,
    );
    for (const invalid of [
      { ...transaction_result, quoteHash: 'invalid' },
      { ...transaction_result, status: 'cancelled' },
      { ...transaction_result, observation: { status: 'accepted' } },
    ])
      expect(TaskError.safeParse({ ...error, transaction_result: invalid }).success).toBe(false);
    expect(TaskError.parse(error)).not.toHaveProperty('transaction_result');
  });

  it('defaults input to an empty object', () => {
    const parsed = CreateTaskRequest.parse({ kind: 'echo' });
    expect(parsed.input).toEqual({});
  });

  it('rejects an empty kind', () => {
    expect(CreateTaskRequest.safeParse({ kind: '' }).success).toBe(false);
  });

  it('accepts a full task record', () => {
    const now = new Date().toISOString();
    const parsed = Task.safeParse({
      id: uuidv7(),
      tenant_id: uuidv7(),
      created_by: uuidv7(),
      conversation_id: null,
      kind: 'echo',
      title: 'hello',
      status: 'RUNNING',
      input: { message: 'hi' },
      result_artifact_id: null,
      error: null,
      created_at: now,
      started_at: now,
      completed_at: null,
      updated_at: now,
    });
    expect(parsed.success).toBe(true);
  });
});
