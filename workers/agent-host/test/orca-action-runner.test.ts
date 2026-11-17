import { describe, expect, it } from 'vitest';
import { canonicalSha256 } from '@genie/contracts';
import { OrcaActionRunner } from '../src/coding/orca-action-runner.js';
import { OrcaError } from '../src/coding/orca-adapter.js';

const hostId = '123e4567-e89b-42d3-a456-426614174000';
const sessionId = '123e4567-e89b-42d3-a456-426614174001';
const path = '/projects/app';

async function step(toolId: string, args: Record<string, unknown>) {
  return {
    id: 'request',
    toolId,
    args,
    approval: {
      approvalId: 'approval',
      operationId: toolId,
      decision: 'APPROVED' as const,
      decidedBy: 'user',
      decidedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      inputsHash: await canonicalSha256(args),
    },
  };
}

describe('OrcaActionRunner', () => {
  const calls: string[] = [];
  const port = {
    create: async (_root: string, _name: string) => {
      calls.push('create');
      return { path, registration: {} };
    },
    register: async () => {
      calls.push('register');
      return {};
    },
    launch: async () => {
      calls.push('launch');
      return { terminal: 'terminal-1' };
    },
    resume: async () => {
      calls.push('resume');
      return { terminal: 'terminal-2' };
    },
    search: async () => ({
      kind: 'results' as const,
      sessions: [
        {
          agent: 'codex' as const,
          sessionId,
          cwd: path,
          updatedAt: '2026-11-17T00:00:00Z',
          messageCount: 1,
        },
      ],
    }),
    activeAgents: async () => {
      calls.push('activeAgents');
      return [];
    },
  };

  it('requires a matching host and exact approved arguments', async () => {
    calls.length = 0;
    const runner = new OrcaActionRunner(hostId, port);
    const request = await step('coding.orca.launch', {
      host_id: hostId,
      path,
      agent: 'codex',
      prompt: 'Implement',
    });
    expect(
      await runner.run({ ...request, args: { ...request.args, prompt: 'Changed' } }),
    ).toMatchObject({ ok: false });
    expect(
      await runner.run({ ...request, args: { ...request.args, host_id: 'other' } }),
    ).toMatchObject({ ok: false });
    expect(calls).toEqual([]);
  });

  it('returns a launch receipt without claiming the coding work is complete', async () => {
    calls.length = 0;
    const runner = new OrcaActionRunner(hostId, port);
    const result = await runner.run(
      await step('coding.orca.launch', {
        host_id: hostId,
        path,
        agent: 'codex',
        prompt: 'Implement',
      }),
    );
    expect(result).toEqual({
      ok: true,
      result: { state: 'launched', terminal: 'terminal-1', agent: 'codex', path },
    });
    expect(calls).toEqual(['activeAgents', 'launch']);
  });

  it('resumes only an indexed same-project session', async () => {
    calls.length = 0;
    const runner = new OrcaActionRunner(hostId, port);
    const input = { host_id: hostId, path, agent: 'codex', query: 'auth', session_id: sessionId };
    expect(await runner.run(await step('coding.orca.resume', input))).toMatchObject({
      ok: true,
      result: { state: 'resumed', sessionId, terminal: 'terminal-2' },
    });
    expect(calls).toEqual(['activeAgents', 'resume']);
    calls.length = 0;
    expect(
      await runner.run(await step('coding.orca.resume', { ...input, session_id: hostId })),
    ).toMatchObject({ ok: false });
    expect(calls).toEqual([]);
  });

  it('returns the trust prompt terminal as a distinct state', async () => {
    const runner = new OrcaActionRunner(hostId, {
      ...port,
      launch: async () => {
        throw new OrcaError(
          'workspace_trust_required',
          '作業フォルダの信頼確認が必要です。',
          'terminal-trust',
        );
      },
    });
    expect(
      await runner.run(
        await step('coding.orca.launch', {
          host_id: hostId,
          path,
          agent: 'codex',
          prompt: 'Implement',
        }),
      ),
    ).toMatchObject({
      ok: false,
      error: { code: 'orca.workspace_trust_required' },
      result: { state: 'workspace_trust_required', terminal: 'terminal-trust' },
    });
  });

  it('routes an explicitly approved fallback only after a confirmed quota failure', async () => {
    calls.length = 0;
    const choices: string[] = [];
    const runner = new OrcaActionRunner(
      hostId,
      {
        ...port,
        launch: async (_path, selected) => {
          choices.push(selected);
          return { terminal: 'fallback-terminal' };
        },
      },
      async (selected) => (selected === 'claude' ? 'rate_limited' : 'available'),
    );
    const result = await runner.run(
      await step('coding.orca.launch', {
        host_id: hostId,
        path,
        agent: 'claude',
        fallback_agent: 'codex',
        prompt: 'Implement',
      }),
    );
    expect(result).toMatchObject({
      ok: true,
      result: {
        agent: 'codex',
        terminal: 'fallback-terminal',
        failover: { from: 'claude', reason: 'rate_limited' },
      },
    });
    expect(choices).toEqual(['codex']);
  });

  it('does not launch either agent when both approved choices are rate limited', async () => {
    const runner = new OrcaActionRunner(hostId, port, async () => 'rate_limited');
    calls.length = 0;
    expect(
      await runner.run(
        await step('coding.orca.launch', {
          host_id: hostId,
          path,
          agent: 'claude',
          fallback_agent: 'codex',
          prompt: 'Implement',
        }),
      ),
    ).toMatchObject({ ok: false });
    expect(calls).toEqual(['activeAgents']);
  });
});
