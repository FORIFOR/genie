import { describe, expect, it } from 'vitest';
import { planTask, withInstructions } from '../src/plan.js';

describe('withInstructions', () => {
  it('appends follow-up instructions to the request of a step that has not run yet', () => {
    const step = { index: 1, toolId: 'general.answer', risk: 'READ' as const, surface: 'local' as const, message: '回答', args: { request: '資料を直して', skill: null } };
    const next = withInstructions(step, ['テストも追加して', 'ダークモードも確認して']);
    expect(next.args['request']).toBe('資料を直して\n\n追加の指示:\n- テストも追加して\n- ダークモードも確認して');
    expect(next.args['follow_up_instructions']).toEqual(['テストも追加して', 'ダークモードも確認して']);
    expect(step.args['request']).toBe('資料を直して');
    expect(withInstructions(step, [])).toBe(step);
  });

  it('keeps the echo plan unchanged unless the approval is asked to come first', () => {
    const normal = planTask('echo', { message: 'm', require_approval: true });
    expect(normal.steps.map((s) => s.toolId)).toEqual(['noop.echo', 'noop.commit']);
    const first = planTask('echo', { message: 'm', require_approval: true, approval_first: true });
    expect(first.steps.map((s) => [s.index, s.toolId])).toEqual([[0, 'noop.commit'], [1, 'noop.echo']]);
  });
});
