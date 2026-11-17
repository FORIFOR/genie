import { describe, expect, it } from 'vitest';
import { quotaOnScreen } from '../src/coding/orca-adapter.js';
import {
  OrcaSupervisor,
  type OrcaSupervisionJob,
  type OrcaSupervisionTransport,
} from '../src/coding/orca-supervisor.js';

const job: OrcaSupervisionJob = {
  requestId: 'request-1',
  taskId: 'task-1',
  path: '/projects/app',
  agent: 'claude',
  fallbackAgent: 'codex',
  prompt: 'Implement auth',
  terminal: 'term_123e4567-e89b-42d3-a456-426614174000',
  approvalExpiresAt: '2026-11-18T00:00:00Z',
  switchingSince: null,
};

function fixture(override: Partial<OrcaSupervisionJob> = {}) {
  const calls: string[] = [];
  let active = [job.terminal];
  const transport: OrcaSupervisionTransport = {
    list: async () => [{ ...job, ...override }],
    begin: async () => {
      calls.push('begin');
      return true;
    },
    finish: async (_host, _request, outcome) => {
      calls.push(`finish:${outcome.state}`);
    },
  };
  const port = {
    observe: async () => 'quota' as const,
    activeAgents: async () => active,
    closeForHandoff: async () => {
      calls.push('close');
      active = [];
    },
    launch: async (_path: string, agent: string, prompt: string) => {
      calls.push(`launch:${agent}`);
      expect(prompt).toContain('First inspect current files and Git status');
      return { terminal: 'term_223e4567-e89b-42d3-a456-426614174000' };
    },
  };
  return { calls, transport, port };
}

describe('Orca late quota supervisor', () => {
  it('recognizes only rendered agent errors, not an echoed instruction', () => {
    expect(quotaOnScreen(["❯ You've hit your weekly limit"], 'claude')).toBe(false);
    expect(quotaOnScreen(["  ⎿  You've hit your weekly limit · resets tomorrow"], 'claude')).toBe(
      true,
    );
  });

  it('closes the quota-blocked primary before launching the approved fallback once', async () => {
    const { calls, transport, port } = fixture();
    const supervisor = new OrcaSupervisor({
      hostId: 'host-1',
      transport,
      port,
      quotaProbe: async () => 'available',
      now: () => Date.parse('2026-11-17T00:00:00Z'),
    });
    await supervisor.tick();
    expect(calls).toEqual(['begin', 'close', 'launch:codex', 'finish:switched']);
  });

  it('ends observation when the first turn is idle and leaves the terminal alone', async () => {
    const { calls, transport, port } = fixture();
    let now = Date.parse('2026-11-17T00:00:00Z');
    const supervisor = new OrcaSupervisor({
      hostId: 'host-1',
      transport,
      port: { ...port, observe: async () => 'idle' as const },
      now: () => now,
    });
    await supervisor.tick();
    expect(calls).toEqual([]);
    now += 21_000;
    await supervisor.tick();
    expect(calls).toEqual(['finish:finished']);
  });

  it('does not mistake a brief pre-response idle for a completed turn', async () => {
    const { calls, transport, port } = fixture();
    let now = Date.parse('2026-11-17T00:00:00Z');
    let state: 'idle' | 'quota' = 'idle';
    const supervisor = new OrcaSupervisor({
      hostId: 'host-1',
      transport,
      port: { ...port, observe: async () => state },
      quotaProbe: async () => 'available',
      now: () => now,
    });
    await supervisor.tick();
    state = 'quota';
    now += 4_000;
    await supervisor.tick();
    expect(calls).toEqual(['begin', 'close', 'launch:codex', 'finish:switched']);
  });

  it('reports an unexplained process exit without starting another agent', async () => {
    const { calls, transport, port } = fixture();
    const supervisor = new OrcaSupervisor({
      hostId: 'host-1',
      transport,
      port: { ...port, observe: async () => 'exited' as const },
      now: () => Date.parse('2026-11-17T00:00:00Z'),
    });
    await supervisor.tick();
    expect(calls).toEqual(['finish:uncertain']);
  });

  it('does not start a second agent when the first switch was interrupted', async () => {
    const { calls, transport, port } = fixture({ switchingSince: '2026-11-17T00:00:00Z' });
    const supervisor = new OrcaSupervisor({
      hostId: 'host-1',
      transport,
      port,
      now: () => Date.parse('2026-11-17T00:03:00Z'),
    });
    await supervisor.tick();
    expect(calls).toEqual(['finish:uncertain']);
  });

  it('keeps the original terminal if the alternate provider is unavailable', async () => {
    const { calls, transport, port } = fixture();
    const supervisor = new OrcaSupervisor({
      hostId: 'host-1',
      transport,
      port,
      quotaProbe: async () => 'rate_limited',
      now: () => Date.parse('2026-11-17T00:00:00Z'),
    });
    await supervisor.tick();
    expect(calls).toEqual(['finish:blocked']);
  });

  it('retries reporting a launched replacement without starting another one', async () => {
    const { calls, transport, port } = fixture();
    let first = true;
    const supervisor = new OrcaSupervisor({
      hostId: 'host-1',
      port,
      transport: {
        ...transport,
        list: async () => (first ? [job] : []),
        finish: async (_host, _request, outcome) => {
          calls.push(`finish:${outcome.state}`);
          if (first) {
            first = false;
            throw new Error('reply lost');
          }
        },
      },
      quotaProbe: async () => 'available',
      now: () => Date.parse('2026-11-17T00:00:00Z'),
    });
    await expect(supervisor.tick()).rejects.toThrow('reply lost');
    await supervisor.tick();
    expect(calls).toEqual(['begin', 'close', 'launch:codex', 'finish:switched', 'finish:switched']);
  });
});
