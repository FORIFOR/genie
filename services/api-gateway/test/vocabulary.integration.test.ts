/**
 * 個人の辞書。会話で登録・一覧・削除し、Mac は GET /v1/vocabulary で取りに来る。
 *
 * 見ること:
 *   - 「辞書に登録: X は Y」で登録され、仕事にはならない
 *   - 同じ聞こえ方は上書き。「辞書から X を消して」で消える
 *   - 普通の頼みは辞書にならず、いつもの仕事になる
 *   - 他人の辞書は見えない
 *   ./infra/db/with-test-db.sh pnpm --filter @genie/service-api-gateway test
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type TokenResponse, uuidv7 } from '@genie/contracts';
import { makeTestApp, makeTokens, testDbConfig, type TestApp } from './support.js';
import type { App } from '../src/fastify.js';

const url = process.env['TEST_DATABASE_URL'];
const identityUrl = process.env['TEST_IDENTITY_DATABASE_URL'];

describe.skipIf(!url)('personal vocabulary', () => {
  let harness: TestApp;
  let app: App;

  const signIn = async (name: string) => {
    const issued = await app.inject({
      method: 'POST',
      url: '/v1/auth/dev/token',
      payload: { email: `${name}-${uuidv7()}@example.com`, display_name: name },
    });
    return { authorization: `Bearer ${issued.json<TokenResponse>().access_token}` };
  };

  const say = async (auth: Record<string, string>, text: string) => {
    const id = (
      await app.inject({ method: 'POST', url: '/v1/conversations', headers: auth, payload: {} })
    ).json<{ id: string }>().id;
    return (
      await app.inject({
        method: 'POST',
        url: `/v1/conversations/${id}/turns`,
        headers: auth,
        payload: { text },
      })
    ).json<{ answer?: { text: string }; task_id?: string | null }>();
  };

  const entries = async (auth: Record<string, string>) =>
    (await app.inject({ method: 'GET', url: '/v1/vocabulary', headers: auth })).json<{
      items: { id: string; spoken: string; written: string }[];
    }>().items;

  beforeAll(async () => {
    harness = await makeTestApp({
      dbConfig: testDbConfig(url!, identityUrl),
      tokens: await makeTokens(),
      vocabulary: true,
    });
    app = harness.app;
  });

  afterAll(async () => {
    await harness?.close();
  });

  it('adds, updates, lists and removes by conversation', async () => {
    const me = await signIn('v');
    const added = await say(me, '辞書に登録: ジーニーは Genie');
    expect(added.answer?.text).toContain('「ジーニー」と聞こえたら「Genie」と書きます');
    expect(added.task_id ?? null).toBeNull();
    expect(await entries(me)).toEqual([
      expect.objectContaining({ spoken: 'ジーニー', written: 'Genie' }),
    ]);

    expect((await say(me, '「ジーニー」は「Genie AI」と書いて')).answer?.text).toContain(
      '書き換えました',
    );
    await say(me, 'カレンダーリンクと言ったら https://cal.example.com/me と入れて');
    const list = await say(me, '辞書を見せて');
    expect(list.answer?.text).toContain('ジーニー → Genie AI');
    expect(list.answer?.text).toContain('カレンダーリンク → https://cal.example.com/me');

    expect((await say(me, '辞書からジーニーを消して')).answer?.text).toContain('消しました');
    expect((await entries(me)).map((e) => e.spoken)).toEqual(['カレンダーリンク']);

    // 他人には見えない
    const other = await signIn('w');
    expect(await entries(other)).toEqual([]);
  });

  it('keeps ordinary requests ordinary', async () => {
    const me = await signIn('x');
    const res = await say(me, '競合を調べて');
    expect(res.task_id).toBeTruthy();
    expect(await entries(me)).toEqual([]);
  });

  it('adds and deletes over HTTP', async () => {
    const me = await signIn('y');
    const created = await app.inject({
      method: 'POST',
      url: '/v1/vocabulary',
      headers: me,
      payload: { spoken: 'おーぷんくろー', written: 'OpenClaw' },
    });
    expect(created.statusCode).toBe(201);
    const [entry] = await entries(me);
    const removed = await app.inject({
      method: 'DELETE',
      url: `/v1/vocabulary/${entry!.id}`,
      headers: me,
    });
    expect(removed.statusCode).toBe(204);
    expect(await entries(me)).toEqual([]);
  });

  it('reports chat channels as not configured when neither Slack nor LINE is set', async () => {
    const me = await signIn('z');
    const res = await app.inject({ method: 'GET', url: '/v1/channels/status', headers: me });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      slack: { configured: false, transport: null, socket: null },
      line: { configured: false },
      durableInbox: false,
      approvalButtons: false,
    });
    expect(
      (await app.inject({ method: 'GET', url: '/v1/channels/status' })).statusCode,
    ).toBe(401);
  });
});
