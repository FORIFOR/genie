import { describe, expect, it } from 'vitest';
import { reachmadeRouterFromEnv } from '../src/routes/reachmade.js';

describe('Reachmade capability gateway configuration', () => {
  it('keeps the existing Genie gateway unchanged when no product capability is configured', () => {
    const router = reachmadeRouterFromEnv({});
    expect(router.list()).toEqual([]);
  });

  it('registers Agent Team and Launchloom from explicit local endpoints', () => {
    const router = reachmadeRouterFromEnv({
      REACHMADE_AGENT_TEAM_URL: 'http://127.0.0.1:8787',
      REACHMADE_LAUNCHLOOM_URL: 'http://127.0.0.1:8788',
      REACHMADE_LAUNCHLOOM_TOKEN: 'local-test-token',
    });
    expect(router.list().map((capability) => capability.id)).toEqual(['agent-team', 'launchloom']);
  });

  it('refuses remote product endpoints unless the operator explicitly opts in', () => {
    expect(() => reachmadeRouterFromEnv({
      REACHMADE_AGENT_TEAM_URL: 'https://agent.example.com',
    })).toThrow(/allowRemote/);

    const router = reachmadeRouterFromEnv({
      REACHMADE_AGENT_TEAM_URL: 'https://agent.example.com',
      REACHMADE_ALLOW_REMOTE_CAPABILITIES: 'true',
    });
    expect(router.list().map((capability) => capability.id)).toEqual(['agent-team']);
  });
});
