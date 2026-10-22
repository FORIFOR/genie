/**
 * 予約（時間になったら知らせる・頼む）。会話で作り、見回り（ScheduleRunner）で動かす。
 * 時間は DB の next_run_at を進めて「期限が来た」ことにする（待たない）。
 *
 * 見ること:
 *   - 予約の言い方は、作る前に言い直して確かめる。「はい」で動き、「いいえ」で消える
 *   - 時間になったら、お知らせは Mac へのお知らせに、頼みごとは仕事になる（Task Dock と同じ入口）
 *   - 1 回だけのものは済んだら done、繰り返しは次の時刻へ
 *   - 寝ていて過ぎた回は 1 回だけ追いつき、遅れを添える（過ぎた回を全部やり直さない）
 *   - 途中で落ちた回はやり直さず、知らせる
 *   - 一覧と取り消しは会話でも HTTP でもできる
 *   ./infra/db/with-test-db.sh pnpm --filter @genie/service-api-gateway test
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type TokenResponse, uuidv7 } from '@genie/contracts';
import { withTenant } from '@genie/db';
import { sql } from 'kysely';
import { makeTestApp, makeTokens, testDbConfig, type TestApp } from './support.js';
import type { App } from '../src/fastify.js';

const url = process.env['TEST_DATABASE_URL'];
const identityUrl = process.env['TEST_IDENTITY_DATABASE_URL'];

type Schedule = {
  id: string;
  name: string;
  status: string;
  kind: string;
  text: string;
  next_run_at: string | null;
  last_status: string | null;
};
type Notice = { id: string; kind: string; title: string; body: string; task_id: string | null };

describe.skipIf(!url)('scheduled requests', () => {
  let harness: TestApp;
  let app: App;
  let auth: { authorization: string };
  let tenantId: string;

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
    return res.json<{
      answer?: { text: string };
      needs_clarification?: boolean;
      task_id?: string | null;
    }>();
  };

  const schedules = async (all = false) =>
    (
      await app.inject({
        method: 'GET',
        url: `/v1/schedules${all ? '?all=1' : ''}`,
        headers: auth,
      })
    ).json<{ items: Schedule[] }>().items;

  const notices = async () =>
    (await app.inject({ method: 'GET', url: '/v1/notices', headers: auth })).json<{
      items: Notice[];
    }>().items;

  const ack = (ids: string[]) =>
    app.inject({ method: 'POST', url: '/v1/notices/ack', headers: auth, payload: { ids } });

  /** 時間を進める代わりに、予定時刻を過去へずらす。 */
  const makeDue = (jobId: string, ago = "1 second") =>
    withTenant(harness.db, tenantId, (tx) =>
      tx
        .updateTable('scheduled_jobs')
        .set({ next_run_at: sql`now() - ${ago}::interval` })
        .where('id', '=', jobId)
        .execute(),
    );

  const create = async (text: string) => {
    const id = await conversation();
    const proposed = await say(id, text);
    expect(proposed.needs_clarification).toBe(true);
    const confirmed = await say(id, 'はい');
    expect(confirmed.answer?.text).toContain('予約しました');
    const job = (await schedules()).find((s) => s.text && text.includes(s.text.slice(0, 3)));
    return { conversationId: id, job: job! };
  };

  beforeAll(async () => {
    const tokens = await makeTokens();
    harness = await makeTestApp({
      dbConfig: testDbConfig(url!, identityUrl),
      tokens,
      schedules: {},
    });
    app = harness.app;
    const issued = await app.inject({
      method: 'POST',
      url: '/v1/auth/dev/token',
      payload: { email: `s-${uuidv7()}@example.com`, display_name: 'S' },
    });
    const access = issued.json<TokenResponse>().access_token;
    auth = { authorization: `Bearer ${access}` };
    tenantId = (
      JSON.parse(Buffer.from(access.split('.')[1]!, 'base64url').toString()) as { tid: string }
    ).tid;
  });

  afterAll(async () => {
    await harness?.close();
  });

  it('says a reminder back before making it, and makes nothing until confirmed', async () => {
    const id = await conversation();
    const proposed = await say(id, '30分後に会議だって教えて');
    expect(proposed.needs_clarification).toBe(true);
    expect(proposed.answer?.text).toMatch(/\d{1,2}:\d{2} に「会議」をお知らせします/);
    expect(proposed.answer?.text).toContain('よろしいですか');
    expect(proposed.task_id ?? null).toBeNull();
    // 確かめる前は一覧に出ない（動いていない）
    expect(await schedules()).toEqual([]);

    const declined = await say(id, 'いいえ');
    expect(declined.answer?.text).toContain('やめました');
    expect(await schedules(true)).toEqual([
      expect.objectContaining({ status: 'cancelled' }),
    ]);
  });

  it('leaves a notice for the Mac when a reminder comes due, once', async () => {
    const { job } = await create('30分後に会議だって教えて');
    expect(job).toMatchObject({ status: 'active', kind: 'reminder', text: '会議' });
    const next = Date.parse(job.next_run_at!);
    expect(next - Date.now()).toBeGreaterThan(25 * 60_000);

    // まだ時間ではない
    expect(await harness.schedules!.tick()).toBe(0);
    await makeDue(job.id);
    expect(await harness.schedules!.tick()).toBe(1);
    expect(await harness.schedules!.tick()).toBe(0);

    const pending = await notices();
    expect(pending).toEqual([expect.objectContaining({ kind: 'reminder', title: '会議' })]);
    expect((await ack(pending.map((n) => n.id))).json()).toEqual({ acknowledged: 1 });
    expect(await notices()).toEqual([]);

    // 1 回だけのものは終わり
    const all = await schedules(true);
    expect(all.find((s) => s.id === job.id)).toMatchObject({ status: 'done', last_status: 'ok' });
    const runs = await app.inject({
      method: 'GET',
      url: `/v1/schedules/${job.id}/runs`,
      headers: auth,
    });
    expect(runs.json<{ items: unknown[] }>().items).toEqual([
      expect.objectContaining({ status: 'ok', delivery_status: 'delivered' }),
    ]);
  });

  it('asks through the same entrance as the Task Dock when a recurring request comes due', async () => {
    const { job } = await create('毎朝8時に競合を調べて');
    expect(job).toMatchObject({ status: 'active', kind: 'task', text: '競合を調べて' });

    await makeDue(job.id);
    expect(await harness.schedules!.tick()).toBe(1);
    const [started] = await notices();
    expect(started).toMatchObject({ kind: 'scheduled_task' });
    expect(started!.task_id).toBeTruthy();
    const task = await app.inject({
      method: 'GET',
      url: `/v1/tasks/${started!.task_id!}`,
      headers: auth,
    });
    expect(task.json()).toMatchObject({ kind: 'research' });
    await ack([started!.id]);

    // 繰り返しは次の時刻へ（明日以降の 8:00）
    const after = (await schedules()).find((s) => s.id === job.id)!;
    expect(after.status).toBe('active');
    expect(Date.parse(after.next_run_at!)).toBeGreaterThan(Date.now());
  });

  it('catches up once after a long sleep and says how late it is', async () => {
    const { job } = await create('毎朝8時に今日の予定を教えて');
    // 3 時間寝ていた（その間に過ぎた回は 1 つ）
    await makeDue(job.id, '3 hours');
    expect(await harness.schedules!.tick()).toBe(1);
    expect(await harness.schedules!.tick()).toBe(0);
    const [late] = await notices();
    expect(late).toMatchObject({ kind: 'reminder', title: '今日の予定' });
    expect(late!.body).toContain('遅れました');
    await ack([late!.id]);
    const after = (await schedules()).find((s) => s.id === job.id)!;
    expect(Date.parse(after.next_run_at!)).toBeGreaterThan(Date.now());
  });

  it('does not redo a run that stopped midway, and says so', async () => {
    const { job } = await create('毎朝8時に競合のニュースを調べて');
    const tasksBefore = (
      await app.inject({ method: 'GET', url: '/v1/tasks', headers: auth })
    ).json<{ items: unknown[] }>().items.length;
    // 走り始めたところで落ちた（20 分前から running のまま）
    await withTenant(harness.db, tenantId, async (tx) => {
      await tx
        .insertInto('scheduled_runs')
        .values({
          id: uuidv7(),
          tenant_id: tenantId,
          job_id: job.id,
          scheduled_for: sql<Date>`now() - interval '20 minutes'`,
          started_at: sql<Date>`now() - interval '20 minutes'`,
          status: 'running',
        })
        .execute();
      await tx
        .updateTable('scheduled_jobs')
        .set({ running_at: sql`now() - interval '20 minutes'` })
        .where('id', '=', job.id)
        .execute();
    });
    await harness.schedules!.tick();
    const [problem] = await notices();
    expect(problem).toMatchObject({ kind: 'schedule_problem' });
    expect(problem!.title).toContain('途中で');
    await ack([problem!.id]);
    const tasksAfter = (
      await app.inject({ method: 'GET', url: '/v1/tasks', headers: auth })
    ).json<{ items: unknown[] }>().items.length;
    expect(tasksAfter).toBe(tasksBefore);
    const runs = await app.inject({
      method: 'GET',
      url: `/v1/schedules/${job.id}/runs`,
      headers: auth,
    });
    expect(runs.json<{ items: { status: string }[] }>().items[0]!.status).toBe('interrupted');
  });

  it('lists and cancels by conversation, and pauses and resumes over HTTP', async () => {
    const id = await conversation();
    const list = await say(id, '予約の一覧を見せて');
    expect(list.answer?.text).toContain('1. ');
    expect(list.answer?.text).toContain('毎日 8:00');

    const active = await schedules();
    const paused = await app.inject({
      method: 'PATCH',
      url: `/v1/schedules/${active[0]!.id}`,
      headers: auth,
      payload: { status: 'paused' },
    });
    expect(paused.json()).toMatchObject({ status: 'paused' });
    const resumed = await app.inject({
      method: 'PATCH',
      url: `/v1/schedules/${active[0]!.id}`,
      headers: auth,
      payload: { status: 'active' },
    });
    expect(resumed.json()).toMatchObject({ status: 'active' });

    const cancelled = await say(id, '全部の予約を取り消して');
    expect(cancelled.answer?.text).toContain('取り消しました');
    expect(await schedules()).toEqual([]);
  });

  it('refuses a time that has passed and very short repeats', async () => {
    const id = await conversation();
    expect((await say(id, '1分おきにメールを確認して')).answer?.text).toContain('5 分以上');
  });

  it('keeps ordinary requests ordinary', async () => {
    const id = await conversation();
    const res = await say(id, '競合を調べて');
    expect(res.task_id).toBeTruthy();
    expect(await schedules()).toEqual([]);
  });
});
