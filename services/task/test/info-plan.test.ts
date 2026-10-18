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
    expect(() => planTask('info.lookup', { kind: 'horoscope' })).toThrow();
  });

  it('looks up quotes as markets with only the subject and symbols', () => {
    const step = planTask('info.lookup', {
      kind: 'quote',
      subject: 'トヨタの株価',
      symbols: '7203.T',
      holdings: 'must not travel',
    }).steps[0]!;
    expect(step.args).toEqual({ kind: 'markets', subject: 'トヨタの株価', symbols: '7203.T' });
  });

  it('passes the Mac location only for weather, rounded to two decimals', () => {
    const weather = planTask('info.lookup', {
      kind: 'weather',
      latitude: 35.68123,
      longitude: 139.76712,
    });
    expect(weather.steps[0]!.args).toMatchObject({ latitude: 35.68, longitude: 139.77 });
    const news = planTask('info.lookup', { kind: 'news', latitude: 35.68, longitude: 139.76 });
    expect(news.steps[0]!.args).not.toHaveProperty('latitude');
  });
});
