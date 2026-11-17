/** Read-only live onboarding probe. Never seeds or sends mail; prints counts only. */
import { cloudClient } from './cloud.js';
import assert from 'node:assert/strict';
import { InitialProfile, WorkArtifactBatch } from '@genie/contracts';
import { credentialRef, TokenStore, type SecretStore } from '@genie/oauth';
import { ConnectorRuntime } from './connector-steps.js';
import { saveLiveReadGrant } from './live-oauth.js';
import { runInitialProfile } from './initial-profile.js';

async function main(): Promise<void> {
  const base = process.env['ASTRA_API_URL'];
  if (!base || !/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(base))
    throw new Error('isolated localhost gateway required');
  const provider = process.env['ASTRA_LIVE_PROVIDER'] === 'microsoft' ? 'microsoft' : 'google';
  const values = new Map<string, string>();
  const secrets: SecretStore = {
    get: async (key) => values.get(key) ?? null,
    set: async (key, value) => {
      values.set(key, value);
    },
    delete: async (key) => {
      values.delete(key);
    },
  };
  let phase = 'read_grant';
  try {
    await saveLiveReadGrant(provider, new TokenStore(secrets));
    phase = 'sign_in';
    const login = await fetch(`${base}/v1/auth/dev/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        email: `initial-live-${crypto.randomUUID()}@astra.local`,
        display_name: 'Initial profile validation',
      }),
    });
    assert.equal(login.ok, true);
    const { access_token } = (await login.json()) as { access_token: string };
    const transport = cloudClient(base, access_token, async (input, init) => {
      const response = await fetch(input, init);
      if (!response.ok) {
        console.error(JSON.stringify({ request_failed: true, status: response.status }));
      }
      return response;
    });
    let artifactCount = 0;
    let reads = 0;
    const cloud = async (path: string, method: string, body?: unknown): Promise<unknown> => {
      phase = `${method} ${path}`;
      if (path === '/v1/work/initial-profile/artifacts') {
        const batch = WorkArtifactBatch.parse((body as { batch: unknown }).batch);
        for (const artifact of batch.artifacts) {
          assert.equal(artifact.body_excerpt, null);
          assert.equal(artifact.provenance.excerpt, null);
          assert.equal(artifact.semantic, null); // Findings travel separately; raw bodies never do.
        }
        artifactCount += batch.artifacts.length;
      }
      return transport(path, method, body);
    };
    const connectors = new ConnectorRuntime({
      secrets,
      credentialRefFor: credentialRef,
      grantedScopes: () => ['email.read', 'calendar.read'],
      fetch: async (input, init) => {
        // The refreshed read token is the only credential available to this runtime.
        assert.equal(
          (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase(),
          'GET',
        );
        const url = new URL(input instanceof Request ? input.url : String(input));
        assert.notEqual(url.searchParams.get('format'), 'full');
        assert.ok(!url.searchParams.get('$select')?.split(',').includes('body'));
        reads += 1;
        return fetch(input, init);
      },
    });
    phase = 'analyse';
    const started = performance.now();
    const begun = InitialProfile.parse(
      ((await cloud('/v1/work/initial-profile', 'POST', { provider })) as { profile: unknown })
        .profile,
    );
    await runInitialProfile({ cloud, connectors, refreshGrants: async () => {} });
    const ready = InitialProfile.parse(
      ((await cloud('/v1/work/initial-profile', 'GET')) as { profile: unknown }).profile,
    );
    phase = `ready_status:${ready.status};outcomes:${ready.outcomes.map((o) => `${o.source}:${o.status}`).join(',')}`;
    assert.equal(ready.status, 'ready');
    assert.equal(ready.outcomes.length, 2);
    assert.ok(ready.outcomes.every((outcome) => outcome.status === 'synced'));
    // This read-only harness intentionally has no local analyzer. It must not
    // claim that body analysis happened merely because metadata was synchronized.
    assert.equal(ready.analysis?.status, 'unavailable');
    assert.equal(ready.analysis?.analyzed_count, 0);
    const analysisMs = Math.round(performance.now() - started);
    phase = 'confirm_and_resume';
    await cloud('/v1/work/initial-profile', 'PUT', ready.sections);
    const confirmed = InitialProfile.parse(
      ((await cloud('/v1/work/initial-profile', 'GET')) as { profile: unknown }).profile,
    );
    assert.equal(confirmed.status, 'confirmed');
    assert.deepEqual(confirmed.sections, ready.sections);
    const resumed = InitialProfile.parse(
      ((await cloud('/v1/work/initial-profile', 'POST', { provider })) as { profile: unknown })
        .profile,
    );
    assert.equal(resumed.id, begun.id);
    const readsBefore = reads;
    await runInitialProfile({ cloud, connectors, refreshGrants: async () => {} });
    assert.equal(reads, readsBefore);
    await cloud('/v1/work/context', 'GET');
    console.log(
      JSON.stringify({
        gate: 'INITIAL_PROFILE_LIVE_API',
        result: 'PASS',
        provider,
        analysis_ms: analysisMs,
        read_requests: reads,
        artifacts: artifactCount,
        outcomes: ready.outcomes,
        confirmed: true,
        repeated_reads: 0,
        native_ui: 'NOT_MEASURED',
      }),
    );
  } catch (error) {
    if (
      error instanceof Error &&
      /^(GET|POST|PUT) \/v1\/[a-z/-]+ failed with \d+$/.test(error.message)
    )
      phase = error.message;
    // Provider errors may contain account data; never emit raw response/error text.
    console.error(
      JSON.stringify({ gate: 'INITIAL_PROFILE_LIVE_API', result: 'FAIL', provider, phase }),
    );
    process.exitCode = 1;
  } finally {
    values.clear();
  }
}
await main();
