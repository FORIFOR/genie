/**
 * 議事録・貼った文から、予定とやることの候補を拾って見せ、本人が選んだものだけ入れる（Genie Schedule Intelligence）。
 *
 * 見ること:
 *   - 議事録を貼ると、候補を番号つきで見せる（まだ入れない）。元の文を残す
 *   - 「2 と 3 を入れて」で、やることだけ置く（締切の朝の知らせつき）。予定は 1 件ずつ確かめると言う
 *   - 「1 を入れて」で、予定 1 件をカレンダーに入れる頼みへ回す（いつもの確かめを通す）
 *   - 「候補はいらない」で何も入れない。答えのない「全部入れて」は候補の話にしない
 *   ./infra/db/with-test-db.sh pnpm --filter @genie/service-api-gateway test
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type TokenResponse, uuidv7 } from '@genie/contracts';
import { withTenant } from '@genie/db';
import { makeTestApp, makeTokens, testDbConfig, type TestApp } from './support.js';
import type { App } from '../src/fastify.js';

const url = process.env['TEST_DATABASE_URL'];
const identityUrl = process.env['TEST_IDENTITY_DATABASE_URL'];

// 2026-11-05（木）12:00 JST に止めた時計
const NOW = Date.parse('2026-11-05T12:00:00+09:00');

const MINUTES = [
  '議事録 11/5 24Call 定例',
  '・次回の定例は来週水曜14時から15時に行う',
  '・金曜までに見積書提出',
  '・11/20までに契約書のドラフトを送付する',
].join('\n');

describe.skipIf(!url)('schedule candidates from minutes', () => {
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

  const candidates = (conversationId: string) =>
    withTenant(harness.db, tenantId, (tx) =>
      tx
        .selectFrom('schedule_candidates')
        .select(['position', 'kind', 'title', 'status', 'excerpt', 'source'])
        .where('conversation_id', '=', conversationId)
        .orderBy('created_at')
        .orderBy('position')
        .execute(),
    );
  const todos = () =>
    withTenant(harness.db, tenantId, (tx) =>
      tx
        .selectFrom('todos')
        .select(['title', 'status', 'reminder_job_id'])
        .where('user_id', '=', userId)
        .where('status', '=', 'open')
        .orderBy('due_date')
        .execute(),
    );

  beforeAll(async () => {
    harness = await makeTestApp({
      dbConfig: testDbConfig(url!, identityUrl),
      tokens: await makeTokens(),
      schedules: { now: () => NOW },
      understand: [],
    });
    app = harness.app;
    const issued = await app.inject({
      method: 'POST',
      url: '/v1/auth/dev/token',
      payload: { email: `cand-${uuidv7()}@example.com`, display_name: 'C' },
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

  it('proposes candidates from pasted minutes and adds only what the user picks', async () => {
    const id = await conversation();
    const proposed = await say(id, MINUTES);
    expect(proposed.task_id ?? null).toBeNull();
    const text = proposed.answer?.text ?? '';
    expect(text).toContain('候補が 3 件見つかりました（まだ入れていません）');
    expect(text).toContain('1. 次回の定例（11/11(水) 14:00〜15:00）');
    expect(text).toContain('2. 見積書提出（11/6(金)まで）');
    expect(text).toContain('元の文:「・金曜までに見積書提出」');
    expect(await todos()).toEqual([]);
    expect(await candidates(id)).toEqual([
      expect.objectContaining({ position: 1, kind: 'event', status: 'pending', source: 'text' }),
      expect.objectContaining({
        position: 2,
        kind: 'todo',
        title: '見積書提出',
        status: 'pending',
      }),
      expect.objectContaining({ position: 3, kind: 'todo', status: 'pending' }),
    ]);

    // やることだけ選ぶ → 置く（締切の朝の知らせつき）
    const picked = await say(id, '2と3を入れて');
    expect(picked.answer?.text).toContain('やることに入れました');
    expect(picked.answer?.text).toContain('・見積書提出（11/6(金)まで）');
    const open = await todos();
    expect(open.map((t) => t.title)).toEqual(['見積書提出', '契約書のドラフトを送付']);
    expect(open.every((t) => t.reminder_job_id)).toBe(true);

    // 無い番号は、そう言う
    expect((await say(id, '5を入れて')).answer?.text).toContain('候補に 5 はありません');

    // 予定 1 件 → カレンダーに入れる頼みへ回す（候補は added になる）
    await say(id, '1を入れて');
    expect((await candidates(id)).map((c) => c.status)).toEqual(['added', 'added', 'added']);
  });

  it('drops the proposal on "候補はいらない" and ignores "全部入れて" with nothing proposed', async () => {
    const id = await conversation();
    await say(id, MINUTES);
    expect((await say(id, '候補はいらない')).answer?.text).toContain('入れずにおきます');
    expect((await candidates(id)).every((c) => c.status === 'dismissed')).toBe(true);

    const other = await conversation();
    const before = (await todos()).length;
    await say(other, '全部入れて');
    expect(await candidates(other)).toEqual([]);
    expect(await todos()).toHaveLength(before);
  });

  it('says so when asked to pick out dates and there are none', async () => {
    const id = await conversation();
    const answer = await say(
      id,
      'この中の予定と締切を拾って\n今日はおつかれさまでした。資料ありがとうございます。',
    );
    expect(answer.answer?.text).toContain('見つかりませんでした');
  });
});
