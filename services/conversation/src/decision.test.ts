import { describe, expect, it, vi } from 'vitest';
import { JevDecisionEngine } from './decision.js';

function response(body: unknown, ok = true): Response {
  return {
    ok,
    json: async () => body,
  } as Response;
}

describe('JevDecisionEngine', () => {
  it('never overrides a deterministic non-chat lane', async () => {
    const fetch = vi.fn();
    const engine = new JevDecisionEngine({
      apiKey: 'test',
      fetch: fetch as unknown as typeof globalThis.fetch,
    });
    const baseline = { lane: 'action' as const, reason: 'deterministic' };

    await expect(
      engine.refine({ text: 'do it', modality: 'text', baseline }),
    ).resolves.toEqual(baseline);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('upgrades an ambiguous turn to research at read-only confidence', async () => {
    const fetch = vi.fn(async () =>
      response({
        answers: {
          route: { type: 'choice', choice: 'research', confidence: 0.8 },
          goal_clear: { type: 'noul', noul: 0.95 },
        },
      }),
    );
    const engine = new JevDecisionEngine({
      apiKey: 'test',
      fetch: fetch as unknown as typeof globalThis.fetch,
    });

    const result = await engine.refine({
      text: '最近この会社に何かあった？',
      modality: 'text',
      baseline: { lane: 'chat', reason: 'fallback' },
    });
    expect(result.lane).toBe('research');
  });

  it('requires a higher confidence before delegating GUI control', async () => {
    const fetch = vi.fn(async () =>
      response({
        answers: {
          route: { type: 'choice', choice: 'computer', confidence: 0.8 },
          goal_clear: { type: 'noul', noul: 0.95 },
        },
      }),
    );
    const engine = new JevDecisionEngine({
      apiKey: 'test',
      fetch: fetch as unknown as typeof globalThis.fetch,
    });
    const baseline = { lane: 'chat' as const, reason: 'fallback' };

    await expect(
      engine.refine({ text: 'Safariでこれを開いて', modality: 'text', baseline }),
    ).resolves.toEqual(baseline);
  });

  it('does not auto-delegate an unclear goal', async () => {
    const fetch = vi.fn(async () =>
      response({
        answers: {
          route: { type: 'choice', choice: 'computer', confidence: 0.97 },
          goal_clear: { type: 'noul', noul: 0.4 },
        },
      }),
    );
    const engine = new JevDecisionEngine({
      apiKey: 'test',
      fetch: fetch as unknown as typeof globalThis.fetch,
    });
    const baseline = { lane: 'chat' as const, reason: 'fallback' };

    await expect(
      engine.refine({ text: 'あれやって', modality: 'voice', baseline }),
    ).resolves.toEqual(baseline);
  });

  it('fails closed when Jev is unavailable', async () => {
    const fetch = vi.fn(async () => {
      throw new Error('offline');
    });
    const engine = new JevDecisionEngine({
      apiKey: 'test',
      fetch: fetch as unknown as typeof globalThis.fetch,
    });
    const baseline = { lane: 'chat' as const, reason: 'fallback' };

    await expect(
      engine.refine({ text: 'something', modality: 'text', baseline }),
    ).resolves.toEqual(baseline);
  });
});
