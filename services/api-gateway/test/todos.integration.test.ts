/**
 * 締切のある「やること」。会話（Task Dock と LINE の同じ入口 handleTurn）で置き・見て・済ませる。
 *
 * 見ること:
 *   - 「金曜までに見積書を出す」で置き、締切の朝 9:00 の知らせを予約で作る（確かめずに。言い直しを返事に書く）
 *   - 同じ名前で言い直すと締切だけ変わる（2 つにしない）。前の知らせは取り消して、新しい日に作り直す
 *   - 「見積書出した」で済みにし、締切の知らせも取り消す
 *   - Genie への頼み（「金曜までに調べてまとめて」）は、やることにしない
 *   - 締切の近いものは「今の作業どうなってる？」の確かめてほしいものに出る
 *   ./infra/db/with-test-db.sh pnpm --filter @genie/service-api-gateway test
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type TokenResponse, uuidv7 } from '@genie/contracts';
import { withTenant } from '@genie/db';
import { ScheduleStore, TodoService, TodoStore } from '@genie/service-schedule';
import { makeTestApp, makeTokens, testDbConfig, type TestApp } from './support.js';
import type { App } from '../src/fastify.js';

const url = process.env['TEST_DATABASE_URL'];
const identityUrl = process.env['TEST_IDENTITY_DATABASE_URL'];

describe.skipIf(!url)('to-dos with a deadline', () => {
  let harness: TestApp;
  let app: App;
  let auth: { authorization: string };
  let tenantId: string;
  let userId: string;

  const conversation = async () =>
    (
      await app.inject({ method: 'POST', url: '/v1/conversations', headers: auth, payload: {} })
    ).json<{ id: string }>().id;

  const say = async (id: string, text: string) => {
    const res = await app.inject({
      method: 'POST',
      url: `/v1/conversations/${id}/turns`,
      headers: auth,
      payload: { text },
    });
    expect(res.statusCode).toBeLessThan(300);
    return res.json<{ answer?: { text: string }; task_id?: string | null }>();
  };

  const todos = () =>
    withTenant(harness.db, tenantId, (tx) =>
      tx
        .selectFrom('todos')
        .select(['id', 'title', 'status', 'reminder_job_id'])
        .select((eb) => eb.fn('to_char', [eb.ref('due_date'), eb.val('YYYY-MM-DD')]).as('due'))
        .where('user_id', '=', userId)
        .orderBy('created_at')
        .execute(),
    );
  const job = (id: string | null) =>
    withTenant(harness.db, tenantId, (tx) =>
      tx
        .selectFrom('scheduled_jobs')
        .select(['status', 'payload', 'next_run_at', 'conversation_id'])
        .where('id', '=', id ?? uuidv7())
        .executeTakeFirst(),
    );

  beforeAll(async () => {
    harness = await makeTestApp({
      dbConfig: testDbConfig(url!, identityUrl),
      tokens: await makeTokens(),
      schedules: {},
    });
    app = harness.app;
    const issued = await app.inject({
      method: 'POST',
      url: '/v1/auth/dev/token',
      payload: { email: `todo-${uuidv7()}@example.com`, display_name: 'T' },
    });
    const access = issued.json<TokenResponse>().access_token;
    auth = { authorization: `Bearer ${access}` };
    const claims = JSON.parse(Buffer.from(access.split('.')[1]!, 'base64url').toString()) as {
      tid: string;
      sub: string;
    };
    tenantId = claims.tid;
    userId = claims.sub;
  });

  afterAll(async () => {
    await harness?.close();
  });

  it('keeps a to-do with its deadline, reminds on the morning, and closes it when done', async () => {
    const id = await conversation();
    const added = await say(id, '11/27までに見積書を出す');
    expect(added.task_id ?? null).toBeNull();
    expect(added.answer?.text).toMatch(/やることに入れました：「見積書を出す」（11\/27\(.\)まで）/);
    expect(added.answer?.text).toContain('9:00 にこのトークでお知らせします');
    let rows = await todos();
    expect(rows).toEqual([expect.objectContaining({ title: '見積書を出す', status: 'open' })]);
    const first = await job(rows[0]!.reminder_job_id);
    expect(first).toMatchObject({
      status: 'active',
      conversation_id: id,
      payload: { kind: 'reminder', text: '今日が締切：見積書を出す' },
    });
    // 締切の日の 9:00（日本時間）
    expect(new Date(first!.next_run_at!).toISOString()).toMatch(/-27T00:00:00\.000Z$/);

    // 言い直し: 締切だけ変わり、知らせは作り直す
    const moved = await say(id, '11/30までに見積書を出す');
    expect(moved.answer?.text).toMatch(/締切を 11\/27\(.\) から 11\/30\(.\) に変えました/);
    rows = await todos();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.due).toMatch(/-11-30$/);
    expect((await job(rows[0]!.reminder_job_id))?.status).toBe('active');
    expect(
      (
        await withTenant(harness.db, tenantId, (tx) =>
          tx
            .selectFrom('scheduled_jobs')
            .select('status')
            .where('payload', '@>', JSON.stringify({ text: '今日が締切：見積書を出す' }) as never)
            .where('status', '=', 'cancelled')
            .execute(),
        )
      ).length,
    ).toBe(1);

    const listed = await say(id, 'やることは？');
    expect(listed.answer?.text).toMatch(/1\. 見積書を出す（11\/30\(.\)まで）/);

    const done = await say(id, '見積書出した');
    expect(done.answer?.text).toContain('「見積書を出す」を済みにしました');
    rows = await todos();
    expect(rows[0]!.status).toBe('done');
    expect((await job(rows[0]!.reminder_job_id))?.status).toBe('cancelled');
    expect((await say(id, 'やることは？')).answer?.text).toContain('やることはありません');
  });

  it('does not turn a request for Genie into a to-do', async () => {
    const id = await conversation();
    const before = (await todos()).length;
    await say(id, '金曜までに競合を調べてまとめて');
    expect(await todos()).toHaveLength(before);
  });

  it('lists close deadlines among what needs the user', async () => {
    const id = await conversation();
    await say(id, '今日中に経費精算する');
    const service = new TodoService(new TodoStore(harness.db), new ScheduleStore(harness.db));
    expect(await service.attention({ tenantId, userId })).toContain(
      'やること「経費精算する」は今日が締切です',
    );
    await say(id, '経費精算した');
  });
});
