/**
 * 「電話して」から仕事へ（Oathra 連携）。Oathra は代役で、電話はかからない。
 *
 * 見ること:
 *   - 営業電話は、Oathra の連絡先で相手が一人に決まったときだけ phone.sales の仕事になる
 *   - 決まらなければ仕事にせず、直し方を notice で返す
 *   - 電話以外の action は、これまで通り「まだ自動では進められません」
 *   ./infra/db/with-test-db.sh pnpm --filter @genie/service-api-gateway test
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { type TokenResponse, uuidv7 } from '@genie/contracts';
import { phoneTaskFor, type OathraClient } from '@genie/service-phone';
import { makeTestApp, makeTokens, testDbConfig, type TestApp } from './support.js';
import type { App } from '../src/fastify.js';

const url = process.env['TEST_DATABASE_URL'];
const identityUrl = process.env['TEST_IDENTITY_DATABASE_URL'];

const oathra = {
  salesContext: vi.fn(async () => ({
    products: [{ id: 'p-1', name: 'デモ商品' }],
    contacts: [{ id: 'c-1', name: '田中', company: '田中工務店', callPermitted: true }],
  })),
} as unknown as OathraClient;

describe.skipIf(!url)('asking Genie to place a phone call', () => {
  let harness: TestApp;
  let app: App;
  let auth: { authorization: string };

  const turn = async (text: string) => {
    const started = await app.inject({
      method: 'POST',
      url: '/v1/conversations',
      headers: auth,
      payload: {},
    });
    const id = started.json<{ id: string }>().id;
    return app.inject({
      method: 'POST',
      url: `/v1/conversations/${id}/turns`,
      headers: auth,
      payload: { text },
    });
  };

  beforeAll(async () => {
    const tokens = await makeTokens();
    harness = await makeTestApp({
      dbConfig: testDbConfig(url!, identityUrl),
      tokens,
      phone: { taskFor: (_principal, text) => phoneTaskFor(text, oathra) },
    });
    app = harness.app;
    const issued = await app.inject({
      method: 'POST',
      url: '/v1/auth/dev/token',
      payload: { email: `p-${uuidv7()}@example.com`, display_name: 'P' },
    });
    auth = { authorization: `Bearer ${issued.json<TokenResponse>().access_token}` };
  });

  afterAll(async () => {
    await harness?.close();
  });

  it('turns a sales call with one resolved contact into a phone.sales task that waits for approval', async () => {
    const res = await turn('田中さんにデモ商品の資料送付について営業電話をかけて');
    expect(res.statusCode).toBe(202);
    const body = res.json<{ task_id: string | null; notice: string | null }>();
    expect(body.notice).toBeNull();
    expect(body.task_id).toBeTruthy();

    const task = await app.inject({
      method: 'GET',
      url: `/v1/tasks/${body.task_id!}`,
      headers: auth,
    });
    expect(task.json()).toMatchObject({
      kind: 'phone.sales',
      input: {
        contact_id: 'c-1',
        contact_name: '田中',
        product_id: 'p-1',
        product_name: 'デモ商品',
        goal: 'materials',
      },
    });
  });

  it('does not start a call it cannot resolve, and says how to fix it', async () => {
    const res = await turn('高橋さんに営業電話をかけて');
    expect(res.statusCode).toBe(202);
    const body = res.json<{ task_id: string | null; notice: string | null }>();
    expect(body.task_id).toBeNull();
    expect(body.notice).toContain('Oathra に登録し');
  });

  it('leaves other outward requests as they were', async () => {
    const res = await turn('見積を送信して');
    expect(res.json<{ task_id: string | null; notice: string | null }>()).toMatchObject({
      task_id: null,
      notice: 'この頼みごとは、まだ自動では進められません。',
    });
  });
});
