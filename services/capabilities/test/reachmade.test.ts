import { describe, expect, it, vi } from 'vitest';
import {
  AgentTeamCapability,
  CapabilityRouter,
  LaunchloomCapability,
  createEvidenceEnvelope,
  type CapabilityExecutionContext,
  type CapabilityIntent,
} from '../src/index.js';

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
}

function context(fetchImpl: typeof fetch): CapabilityExecutionContext {
  let tick = 0;
  return {
    fetch: fetchImpl,
    now: () => new Date(Date.UTC(2026, 8, 17, 0, 0, tick++)),
  };
}

const launchBrief = {
  name: 'Orbit',
  tagline: 'One useful launch kit',
  audience: 'Developers evaluating a local tool',
  description: 'A factual product description.',
  product_url: 'https://example.com',
  features: [{ title: 'Export', detail: 'Exports a local kit', evidence: 'Public test record', approved: true }],
  language: 'en',
  goal: 'github',
  channels: ['x'],
};

describe('Reachmade Capability Protocol', () => {
  it('refuses to call a completed result evidence-backed when no evidence exists', () => {
    expect(() => createEvidenceEnvelope({
      executionId: 'e1', intentId: 'i1', capabilityId: 'demo', status: 'completed', claim: 'done',
      startedAt: '2026-09-17T00:00:00.000Z', finishedAt: '2026-09-17T00:00:01.000Z',
    })).toThrow(/requires evidence/);
  });

  it('routes launch work to Launchloom and general reviewed work to Agent Team', () => {
    const router = new CapabilityRouter([
      new AgentTeamCapability({ baseUrl: 'http://127.0.0.1:8787', pollIntervalMs: 0 }),
      new LaunchloomCapability({ baseUrl: 'http://127.0.0.1:8788', pollIntervalMs: 0 }),
    ]);
    expect(router.route({ id: 'launch', objective: 'Create a landing page, film and social drafts' }).capability.id).toBe('launchloom');
    expect(router.route({ id: 'review', objective: 'Research this code change, implement it and review the artifact' }).capability.id).toBe('agent-team');
  });

  it('keeps remote product endpoints opt-in', () => {
    expect(() => new AgentTeamCapability({ baseUrl: 'https://agent.example.com' })).toThrow(/allowRemote/);
    expect(() => new LaunchloomCapability({ baseUrl: 'https://launch.example.com' })).toThrow(/allowRemote/);
  });
});

describe('Agent Team adapter', () => {
  it('converts a terminal run and artifact hash into an Evidence Envelope', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      if (url.endsWith('/api/runs') && init?.method === 'POST') return json({ run_id: 'run-1', status: 'queued' });
      if (url.endsWith('/api/runs/run-1')) return json({
        run_id: 'run-1', status: 'completed', artifacts: [
          { artifact_id: 'artifact-1', revision: 2, sha256: 'a'.repeat(64), path: 'deliverable.md' },
        ],
      });
      return json({ detail: 'not found' }, 404);
    });
    const capability = new AgentTeamCapability({ baseUrl: 'http://127.0.0.1:8787', pollIntervalMs: 0 });
    const intent: CapabilityIntent = { id: 'issue-42', objective: 'Implement the fix and review it' };
    const result = await capability.execute(intent, capability.plan(intent), context(fetchMock));
    expect(result.status).toBe('completed');
    expect(result.artifacts).toHaveLength(1);
    expect(result.artifacts[0]?.digest).toBe(`sha256:${'a'.repeat(64)}`);
    expect(result.evidence.some((e) => e.kind === 'hash')).toBe(true);
  });
});

describe('Launchloom adapter', () => {
  it('stops at the real storyboard review gate by default', async () => {
    const calls: string[] = [];
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input); calls.push(`${init?.method ?? 'GET'} ${url}`);
      if (url.endsWith('/api/campaigns') && init?.method === 'POST') return json({ id: 'campaign-1' });
      if (url.endsWith('/api/campaigns/campaign-1/build')) return json({ state: 'building' });
      if (url.endsWith('/api/campaigns/campaign-1')) return json({ id: 'campaign-1', state: 'awaiting_review', stage: 'plan', progress: 0.4 });
      return json({ detail: 'not found' }, 404);
    });
    const capability = new LaunchloomCapability({ baseUrl: 'http://127.0.0.1:8788', token: 'test-token', pollIntervalMs: 0 });
    const intent: CapabilityIntent = { id: 'launch-1', objective: 'Create launch assets', inputs: { brief: launchBrief } };
    const result = await capability.execute(intent, capability.plan(intent), context(fetchMock));
    expect(result.status).toBe('awaiting_approval');
    expect(result.claim).toMatch(/review gate/);
    expect(calls.some((call) => call.includes('/render'))).toBe(false);
    expect(calls.some((call) => call.includes('/submit'))).toBe(false);
  });

  it('renders only when approvePlan is explicit and still never publishes', async () => {
    let rendered = false;
    const calls: string[] = [];
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input); calls.push(`${init?.method ?? 'GET'} ${url}`);
      if (url.endsWith('/api/campaigns') && init?.method === 'POST') return json({ id: 'campaign-2' });
      if (url.endsWith('/api/campaigns/campaign-2/build')) return json({ state: 'building' });
      if (url.endsWith('/api/campaigns/campaign-2/render')) { rendered = true; return json({ state: 'rendering' }); }
      if (url.endsWith('/api/campaigns/campaign-2')) {
        return rendered
          ? json({ id: 'campaign-2', state: 'ready', outputs: { 'launch-kit.zip': '/artifacts/campaign-2/launch-kit.zip', 'landing.html': '/artifacts/campaign-2/landing.html' } })
          : json({ id: 'campaign-2', state: 'awaiting_review' });
      }
      return json({ detail: 'not found' }, 404);
    });
    const capability = new LaunchloomCapability({ baseUrl: 'http://127.0.0.1:8788', token: 'test-token', pollIntervalMs: 0 });
    const intent: CapabilityIntent = { id: 'launch-2', objective: 'Create launch assets', inputs: { brief: launchBrief, approvePlan: true } };
    const result = await capability.execute(intent, capability.plan(intent), context(fetchMock));
    expect(result.status).toBe('completed');
    expect(result.artifacts.map((a) => a.id)).toEqual(['launch-kit.zip', 'landing.html']);
    expect(calls.some((call) => call.includes('/render'))).toBe(true);
    expect(calls.some((call) => /release|publications|submit/.test(call))).toBe(false);
  });
});
