/**
 * 確かめ中（「家計簿に付けますか？」）は DB に置く。再起動しても「はい」が効き、ほかのテナントからは見えない。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type TokenResponse, uuidv7 } from '@genie/contracts';
import { PendingStore } from '@genie/service-understand';
import { makeTestApp, makeTokens, testDbConfig, type TestApp } from './support.js';

const url = process.env['TEST_DATABASE_URL'];
describe.skipIf(!url)('pending confirmations in the database', () => {
  let h: TestApp;
  const people: { tenantId: string; conversationId: string }[] = [];
  beforeAll(async () => {
    h = await makeTestApp({
      dbConfig: testDbConfig(url!, process.env['TEST_IDENTITY_DATABASE_URL']),
      tokens: await makeTokens(),
    });
    for (const name of ['a', 'b']) {
      const access = (
        await h.app.inject({
          method: 'POST',
          url: '/v1/auth/dev/token',
          payload: { email: `pending-${name}-${uuidv7()}@example.com`, display_name: name },
        })
      ).json<TokenResponse>().access_token;
      const tid = (
        JSON.parse(Buffer.from(access.split('.')[1]!, 'base64url').toString()) as { tid: string }
      ).tid;
      const conversationId = (
        await h.app.inject({
          method: 'POST',
          url: '/v1/conversations',
          headers: { authorization: `Bearer ${access}` },
          payload: {},
        })
      ).json<{ id: string }>().id;
      people.push({ tenantId: tid, conversationId });
    }
  });
  afterAll(async () => {
    await h?.close();
  });

  it('keeps one confirmation per conversation, expires it, and keeps tenants apart', async () => {
    const [a, b] = people as [(typeof people)[0], (typeof people)[0]];
    const now = Date.parse('2026-10-27T00:00:00Z');
    const expense = {
      amount: 2480,
      currency: 'JPY',
      category: '食費',
      merchant: 'スーパー',
      spentOn: '2026-10-22',
      source: 'line',
      imageSha256: null,
    };
    const store = new PendingStore(h.db);
    await store.set(a.tenantId, a.conversationId, {
      kind: 'expense',
      expense,
      expiresAt: now + 600_000,
    });
    // 再起動（新しい置き場）でも読める
    expect(await new PendingStore(h.db).get(a.tenantId, a.conversationId, now)).toEqual({
      kind: 'expense',
      expense,
      expiresAt: now + 600_000,
    });
    // 上書き（直した内容）
    await store.set(a.tenantId, a.conversationId, {
      kind: 'expense',
      expense: { ...expense, amount: 1980 },
      expiresAt: now + 600_000,
    });
    expect(
      (await store.get(a.tenantId, a.conversationId, now)) as { expense: { amount: number } },
    ).toMatchObject({ expense: { amount: 1980 } });
    // ほかのテナントの会話 id を使っても見えない
    expect(await store.get(b.tenantId, a.conversationId, now)).toBeNull();
    // 期限が過ぎたら無い
    expect(await store.get(a.tenantId, a.conversationId, now + 700_000)).toBeNull();
    expect(await store.get(a.tenantId, a.conversationId, now)).toBeNull();
  });
});
