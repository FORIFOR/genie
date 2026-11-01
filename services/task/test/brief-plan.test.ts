import { describe, expect, it } from 'vitest';
import { isKnownTaskKind, isMeteredStep, planTask } from '../src/plan.js';

describe('morning brief task', () => {
  it('is one local read-only step that uses no model', () => {
    expect(isKnownTaskKind('brief.today')).toBe(true);
    const input = {
      date: '2026-10-06',
      calendar: { status: 'granted', events: [], fetched_at: '2026-10-06T00:00:00Z' },
      attention: { status: 'none', items: [] },
    };
    const plan = planTask('brief.today', input);
    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0]).toMatchObject({
      toolId: 'brief.compose',
      risk: 'READ',
      surface: 'local',
      args: input,
    });
    expect(isMeteredStep(plan.steps[0]!)).toBe(false);
    expect(plan.artifact.mimeType).toBe('application/vnd.genie.brief+json');
    expect(() => planTask('brief.today', { date: '2026-10-06' })).toThrow();
  });
});

describe('mail check task', () => {
  it('is one local read-only step that uses no model', () => {
    expect(isKnownTaskKind('mail.check')).toBe(true);
    const plan = planTask('mail.check', {});
    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0]).toMatchObject({ toolId: 'mail.check', risk: 'READ', surface: 'local' });
    expect(isMeteredStep(plan.steps[0]!)).toBe(false);
    expect(plan.artifact.mimeType).toBe('text/markdown');
  });
});
