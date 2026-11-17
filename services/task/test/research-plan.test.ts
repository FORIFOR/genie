import { describe, expect, it } from 'vitest';
import { planTask } from '../src/plan.js';

describe('the research plan', () => {
  it('keeps the four fixed steps for a question of fact', () => {
    const plan = planTask('research', { question: '毎日王冠の距離は？' });
    expect(plan.steps.map((step) => step.toolId)).toEqual([
      'research.plan',
      'research.search',
      'research.verify',
      'research.report',
    ]);
  });

  it('adds a step that looks into the chosen subject when a forecast is asked for', () => {
    const plan = planTask('research', { question: '次の日曜の重賞の予想をまとめて' });
    expect(plan.steps.map((step) => step.toolId)).toEqual([
      'research.plan',
      'research.search',
      'research.deepen',
      'research.verify',
      'research.report',
    ]);
    // Step numbers follow the order, so progress counts stay true.
    expect(plan.steps.map((step) => step.index)).toEqual([0, 1, 2, 3, 4]);
    expect(plan.steps.every((step) => step.risk === 'READ' && step.surface === 'cloud')).toBe(true);
  });
});
