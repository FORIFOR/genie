/**
 * 電話（Oathra）の接続を預かる。Oathra は代役で、電話はかからない。
 *   ./infra/db/with-test-db.sh pnpm --filter @genie/service-api-gateway test
 *
 * 見ること: 預かる前に Oathra に確かめる・応答にトークンを出さない・
 * 鍵の無いサーバは預からない・本人の接続だけが見える。
 */
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { type TokenResponse, uuidv7 } from '@genie/contracts';
import { createDb, type DbHandle } from '@genie/db';
import {
  OathraError,
  PhoneConnectionStore,
  secretBox,
  type OathraClient,
  type OathraConnection,
} from '@genie/service-phone';
import { makeTestApp, makeTokens, testDbConfig, type TestApp } from './support.js';
import type { App } from '../src/fastify.js';

const url = process.env['TEST_DATABASE_URL'];
const identityUrl = process.env['TEST_IDENTITY_DATABASE_URL'];

const grant = {
  grant: {
    id: 'g-1',
    phones: ['+819000000002'],
    maxCalls: 10,
    maxSeconds: 180,
    expiresAt: Date.parse('2026-10-20T00:00:00Z'),
    allowSales: true,
    readInbound: false,
    status: 'ACTIVE',
  },
  remainingCalls: 9,
  remainingUsd: 27,
  ready: true,
  nextAction: 'submit_phone_request',
};

describe.skipIf(!url)('the phone connection', () => {
  let harness: TestApp;
  let keyless: TestApp;
  let db: DbHandle;
  let app: App;
  const seen: OathraConnection[] = [];
  const clientOf = vi.fn((connection: OathraConnection) => {
    seen.push(connection);
    return {
      connection: async () => {
        if (connection.grantId === 'revoked') throw new OathraError('phone_grant_not_found', 404);
        return grant;
      },
    } as unknown as OathraClient;
  });

  const signIn = async (target: App) => {
    const issued = await target.inject({
      method: 'POST',
      url: '/v1/auth/dev/token',
      payload: { email: `pc-${uuidv7()}@example.com`, display_name: 'PC' },
    });
    return { authorization: `Bearer ${issued.json<TokenResponse>().access_token}` };
  };

  const body = (grantId = 'g-1') => ({
    schemaVersion: 1,
    kind: 'oathra.agent-connection',
    baseUrl: 'https://oathra.example',
    token: 'agent-token-0123456789abcdef',
    agentId: 'phone-agent-1',
    grantId,
    grant: grant.grant,
  });

  beforeAll(async () => {
    const tokens = await makeTokens();
    db = createDb(testDbConfig(url!, identityUrl));
    const store = new PhoneConnectionStore({
      db,
      secrets: secretBox(randomBytes(32).toString('hex')),
    });
    harness = await makeTestApp({
      db,
      dbConfig: testDbConfig(url!, identityUrl),
      tokens,
      phoneConnections: { store, clientOf },
    });
    keyless = await makeTestApp({
      db,
      dbConfig: testDbConfig(url!, identityUrl),
      tokens,
      phoneConnections: { store: new PhoneConnectionStore({ db, secrets: null }), clientOf },
    });
    app = harness.app;
  });

  afterAll(async () => {
    await harness?.close();
    await keyless?.close();
    await db?.close();
  });

  it('確かめてから預かり、応答にトークンを出さない', async () => {
    const auth = await signIn(app);
    const put = await app.inject({
      method: 'PUT',
      url: '/v1/phone/connection',
      headers: auth,
      payload: body(),
    });
    expect(put.statusCode).toBe(200);
    expect(put.json()).toMatchObject({
      baseUrl: 'https://oathra.example',
      grantId: 'g-1',
      ready: true,
      remaining_calls: 9,
      allow_sales: true,
      read_inbound: false,
    });
    expect(put.body).not.toContain('agent-token');
    expect(seen.at(-1)).toEqual({
      baseUrl: 'https://oathra.example',
      token: 'agent-token-0123456789abcdef',
      grantId: 'g-1',
    });

    const get = await app.inject({ method: 'GET', url: '/v1/phone/connection', headers: auth });
    expect(get.json()).toMatchObject({ connected: true, reachable: true, grantId: 'g-1' });
    expect(get.body).not.toContain('agent-token');

    // ほかの利用者には見えない
    const other = await signIn(app);
    expect(
      (await app.inject({ method: 'GET', url: '/v1/phone/connection', headers: other })).json(),
    ).toEqual({
      connected: false,
    });

    const del = await app.inject({ method: 'DELETE', url: '/v1/phone/connection', headers: auth });
    expect(del.statusCode).toBe(204);
    expect(
      (await app.inject({ method: 'GET', url: '/v1/phone/connection', headers: auth })).json(),
    ).toEqual({
      connected: false,
    });
  });

  it('Oathra が断る接続・HTTPS でない接続・形の崩れた本文は預からない', async () => {
    const auth = await signIn(app);
    const refused = await app.inject({
      method: 'PUT',
      url: '/v1/phone/connection',
      headers: auth,
      payload: body('revoked'),
    });
    expect(refused.statusCode).toBe(400);
    expect(refused.body).not.toContain('agent-token');
    const plain = await app.inject({
      method: 'PUT',
      url: '/v1/phone/connection',
      headers: auth,
      payload: { ...body(), baseUrl: 'http://oathra.example' },
    });
    expect(plain.statusCode).toBe(400);
    const missing = await app.inject({
      method: 'PUT',
      url: '/v1/phone/connection',
      headers: auth,
      payload: { baseUrl: 'https://oathra.example' },
    });
    expect(missing.statusCode).toBe(400);
    expect(
      (await app.inject({ method: 'GET', url: '/v1/phone/connection', headers: auth })).json(),
    ).toEqual({
      connected: false,
    });
  });

  it('秘密を封じる鍵の無いサーバは預からない', async () => {
    const auth = await signIn(keyless.app);
    const res = await keyless.app.inject({
      method: 'PUT',
      url: '/v1/phone/connection',
      headers: auth,
      payload: body(),
    });
    expect(res.statusCode).toBe(503);
  });

  it('サインインしていなければ使えない', async () => {
    expect((await app.inject({ method: 'GET', url: '/v1/phone/connection' })).statusCode).toBe(401);
  });
});
