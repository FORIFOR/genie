import { describe, expect, it } from 'vitest';
import { isMeteredStep, planTask, requiresSingleAttempt } from '../src/plan.js';

describe('info.lookup plan', () => {
  it('reads current information on the device in one unconfirmed, unmetered step', () => {
    const plan = planTask('info.lookup', {
      kind: 'weather',
      when: 'tomorrow',
      question: '明日の天気教えて',
      context: 'must not travel',
    });
    expect(plan.steps).toHaveLength(1);
    const step = plan.steps[0]!;
    expect(step).toMatchObject({
      toolId: 'info.lookup',
      risk: 'READ',
      surface: 'local',
      args: { kind: 'weather', when: 'tomorrow', question: '明日の天気教えて' },
    });
    expect(step.requiresConfirmation).toBeFalsy();
    expect(step.args).not.toHaveProperty('context');
    expect(isMeteredStep(step)).toBe(false);
    expect(requiresSingleAttempt(step)).toBe(false);
    expect(plan.artifact.mimeType).toBe('application/vnd.genie.info+json');
  });

  it('refuses kinds it cannot look up', () => {
    expect(() => planTask('info.lookup', { kind: 'quote' })).toThrow();
  });
});
