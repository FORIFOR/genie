import { describe, expect, it } from 'vitest';
import { planTask } from '../src/plan.js';

describe('computer.action plan', () => {
  it('plans read-only observation without confirmation', () => {
    const plan = planTask('computer.action', { action: 'observe' });
    expect(plan.steps).toEqual([
      expect.objectContaining({
        toolId: 'computer.observe',
        risk: 'READ',
        surface: 'local',
        requiresConfirmation: false,
      }),
    ]);
  });

  it('requires confirmation for mutating input', () => {
    const plan = planTask('computer.action', {
      action: 'click',
      x: 120,
      y: 240,
      expectChange: true,
    });
    expect(plan.steps[0]).toMatchObject({
      toolId: 'computer.click',
      risk: 'EXTERNAL_COMMIT',
      surface: 'local',
      requiresConfirmation: true,
      args: { x: 120, y: 240, expectChange: true },
    });
  });

  it('plans a bounded autonomous run behind one explicit approval', () => {
    const plan = planTask('computer.run', { goal: '設定画面を開く' });
    expect(plan.steps[0]).toMatchObject({
      toolId: 'computer.run',
      risk: 'EXTERNAL_COMMIT',
      surface: 'local',
      requiresConfirmation: true,
      args: { goal: '設定画面を開く', successCriteria: '設定画面を開く' },
    });
  });

  it('rejects unknown computer actions', () => {
    expect(() => planTask('computer.action', { action: 'shell' })).toThrow(
      'computer.action needs observe, click, type, or key',
    );
  });
});
