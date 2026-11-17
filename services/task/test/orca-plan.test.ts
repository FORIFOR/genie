import { describe, expect, it } from 'vitest';
import {
  approvalSummaryFor,
  isKnownTaskKind,
  planTask,
  requiresSingleAttempt,
} from '../src/plan.js';

describe('Orca status task', () => {
  const host_id = '123e4567-e89b-42d3-a456-426614174000';
  it('routes readiness to the local host as a read-only step', () => {
    expect(isKnownTaskKind('coding.orca.status')).toBe(true);
    expect(planTask('coding.orca.status', { host_id }).steps).toEqual([
      {
        index: 0,
        toolId: 'coding.orca.status',
        risk: 'READ',
        surface: 'local',
        message: 'この端末の Orca を確認しています',
        args: { host_id },
      },
    ]);
  });
  it('validates and routes project-scoped session search', () => {
    expect(isKnownTaskKind('coding.orca.search')).toBe(true);
    expect(
      planTask('coding.orca.search', {
        host_id,
        path: '/projects/app',
        agent: 'codex',
        query: 'auth',
      }).steps[0],
    ).toMatchObject({
      toolId: 'coding.orca.search',
      risk: 'READ',
      surface: 'local',
      args: { host_id, path: '/projects/app', agent: 'codex', query: 'auth' },
    });
    expect(() =>
      planTask('coding.orca.search', { host_id, path: '../escape', agent: 'codex', query: 'auth' }),
    ).toThrow();
  });
  it('requires approval and one attempt for an agent launch', () => {
    const step = planTask('coding.orca.launch', {
      host_id,
      path: '/projects/app',
      agent: 'codex',
      prompt: 'Implement auth',
    }).steps[0]!;
    expect(step).toMatchObject({
      toolId: 'coding.orca.launch',
      surface: 'local',
      requiresConfirmation: true,
    });
    expect(requiresSingleAttempt(step)).toBe(true);
    expect(approvalSummaryFor(step).details).toContainEqual({
      label: '指示',
      value: 'Implement auth',
    });
  });
  it('binds the optional fallback choice into the approval', () => {
    const input = {
      host_id,
      path: '/projects/app',
      agent: 'claude',
      fallback_agent: 'codex',
      prompt: 'Implement auth',
    };
    const step = planTask('coding.orca.launch', input).steps[0]!;
    expect(step.args).toMatchObject(input);
    expect(approvalSummaryFor(step).details).toContainEqual({
      label: '利用制限時の代替エージェント',
      value: 'codex',
    });
    expect(() => planTask('coding.orca.launch', { ...input, fallback_agent: 'claude' })).toThrow();
  });
});
