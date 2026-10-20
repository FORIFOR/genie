import { describe, expect, it } from 'vitest';
import { CompositeRunner } from '../src/runner.js';

describe('composite runner', () => {
  it('reports each finished step with its time and result kind, never its arguments', async () => {
    const finished: unknown[] = [];
    const runner = new CompositeRunner(
      [
        {
          handles: (toolId) => toolId === 'browser.open_official',
          run: async () => ({ ok: false, error: { code: 'browser.search_failed', message: 'x' } }),
        },
      ],
      (toolId, outcome, ms) => finished.push({ toolId, ok: outcome.ok, ms: typeof ms }),
    );
    const outcome = await runner.run({
      id: 's1',
      toolId: 'browser.open_official',
      args: { subject: 'PRIVATE' },
      approval: null,
    });
    expect(outcome.ok).toBe(false);
    expect(finished).toEqual([{ toolId: 'browser.open_official', ok: false, ms: 'number' }]);
    expect(JSON.stringify(finished)).not.toContain('PRIVATE');
  });
});
