import { describe, expect, it } from 'vitest';
import {
  planExecution,
  withPreparedExecution,
  executionApprovalCard,
} from '../src/execution-plan.js';
import { isMeteredStep, requiresSingleAttempt, planTask } from '../src/plan.js';
describe('immutable execution before approval', () => {
  const prepared = {
    version: 1,
    id: 'id',
    status: 'ready',
    intent: { operation: 'mail.draft' },
    capability: { id: 'api:gmail' },
    details: [
      { label: '宛先', value: 'a@example.com' },
      { label: '本文', value: 'full body' },
    ],
  };
  it('creates prepare then single-attempt approved apply', () => {
    const plan = planTask('execution.run', { goal: 'メールの下書きを保存して' });
    expect(plan.steps.map((s) => s.toolId)).toEqual(['execution.prepare', 'execution.apply']);
    expect(isMeteredStep(plan.steps[0]!)).toBe(true);
    expect(requiresSingleAttempt(plan.steps[1]!)).toBe(true);
    const effective = withPreparedExecution(plan.steps[1]!, [prepared]);
    expect(effective.args).toEqual({ prepared });
    expect(executionApprovalCard(effective)?.details).toEqual(prepared.details);
    expect(executionApprovalCard(effective)?.impact.reversible).toBe(false);
  });
  it.each(['needs_input', 'unavailable'])('does not ask approval or write for %s', (status) => {
    const step = withPreparedExecution(planExecution({ goal: 'x' }).steps[1]!, [
      { ...prepared, status },
    ]);
    expect(step.toolId).toBe('execution.report');
    expect(step.requiresConfirmation).toBe(false);
  });
  it('refuses missing preparation rather than approving raw model prose', () => {
    expect(() => withPreparedExecution(planExecution({ goal: 'x' }).steps[1]!, [])).toThrow();
    expect(() => executionApprovalCard(planExecution({ goal: 'x' }).steps[1]!)).toThrow();
  });
});
