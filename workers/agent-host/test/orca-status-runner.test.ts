import { describe, expect, it } from 'vitest';
import { OrcaStatusRunner } from '../src/coding/orca-status-runner.js';

const step = {
  id: 'step-1',
  toolId: 'coding.orca.status',
  args: { host_id: 'host-1' },
  approval: null,
};

describe('OrcaStatusRunner', () => {
  it('exposes only the read-only readiness tool', async () => {
    const runner = new OrcaStatusRunner('host-1', async () => ({
      reachable: true,
      state: 'ready',
    }));
    expect(runner.handles('coding.orca.status')).toBe(true);
    expect(runner.handles('coding.orca.search')).toBe(true);
    expect(runner.handles('coding.orca.launch')).toBe(false);
    expect(await runner.run(step)).toEqual({
      ok: true,
      result: { reachable: true, state: 'ready' },
    });
  });
});
