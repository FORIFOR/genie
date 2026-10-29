/**
 * 仕事の見通し（work-desk.ts・work-holds.ts）を DB で。
 *
 * 見ること（受け入れ項目書 2026-10-29 の T07・T10・T15・E2E-03）:
 *   - 「〇〇は来週まで保留」で、その名前のセッションの知らせと予約が止まる。保留のあとに始まったセッションも静か
 *   - 「全部進めて」と言われても、保留中のものは何も動かさない（保留はそのまま）
 *   - 保留の日が来たら 1 回だけ「再開しますか」と知らせ、勝手に解除しない
 *   - 解除で、まだ待っているセッションはまた知らせの対象になり、止めた予約は戻る
 *   - 「これが終わったら〇〇して」は、前の仕事が COMPLETED になったときだけ 1 回始める。
 *     失敗・取り消しなら始めずに知らせる。保留中の名前に触れる頼みは始めない
 *   - GET /v1/work/overview が件数と同じ答えを返す
 *   ./infra/db/with-test-db.sh pnpm --filter @genie/service-api-gateway test
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type TokenResponse, uuidv7 } from '@genie/contracts';
import { sql } from 'kysely';
import { withTenant } from '@genie/db';
import { ScheduleStore } from '@genie/service-schedule';
import {
  AgentSessionStore,
  NEEDS_USER_NOTIFY_MS,
  type AgentConnection,
} from '../src/agent-sessions.js';
import { AgentSessionWatch } from '../src/agent-session-watch.js';
import { WorkDesk, WorkDeskWatch, type FollowupRun } from '../src/work-desk.js';
import { registerWorkDeskRoutes } from '../src/routes/work-desk.js';
import { makeTestApp, makeTokens, testDbConfig, type TestApp } from './support.js';

const url = process.env['TEST_DATABASE_URL'];
const identityUrl = process.env['TEST_IDENTITY_DATABASE_URL'];
const TZ = 'Asia/Tokyo';

describe.skipIf(!url)('work desk (holds, follow-ups, overview)', () => {
  let harness: TestApp;
  /*
   * 時計を 2 つに分ける。Claude Code のセッションの見回り（AgentSessionWatch）はテナントをまたぐので、
   * ほかのテストファイル（いまの時刻の時計）と同じ DB で走る。こちらのセッションの時計もいまの時刻にそろえ、
   * 何日も先へ進めない（進めると、ほかのファイルの行まで「時間が来た」と見てしまう）。
   * 保留の日付は、もう 1 つの時計（2026-10-29（木）10:00 JST から）で数える。
   */
  let clock = Date.now();
  const now = () => new Date(clock);
  const later = (ms: number) => {
    clock += ms;
  };
  let deskClock = Date.parse('2026-10-29T01:00:00Z');
  const deskNow = () => new Date(deskClock);
  let store: AgentSessionStore;
  let schedules: ScheduleStore;
  let desk: WorkDesk;
  let agentWatch: AgentSessionWatch;
  let deskWatch: WorkDeskWatch;
  const runs: Parameters<FollowupRun>[0][] = [];
  const chats: { userId: string; text: string }[] = [];
  const deskRef: { current: WorkDesk | null } = { current: null };

  const signIn = async () => {
    const issued = await harness.app.inject({
      method: 'POST',
      url: '/v1/auth/dev/token',
      payload: { email: `d-${uuidv7()}@example.com`, display_name: 'D' },
    });
    const auth = { authorization: `Bearer ${issued.json<TokenResponse>().access_token}` };
    const key = await harness.app.inject({
      method: 'POST',
      url: '/v1/agent-connections',
      headers: auth,
      payload: { source: 'claude_code' },
    });
    const connection = (await store.identify(key.json<{ token: string }>().token))!;
    const conversation = await harness.app.inject({
      method: 'POST',
      url: '/v1/conversations',
      headers: auth,
      payload: {},
    });
    return { auth, connection, conversationId: conversation.json<{ id: string }>().id };
  };

  const principal = (c: AgentConnection) => ({ tenantId: c.tenantId, userId: c.userId });

  /**
   * 保留した design-app のセッションの知らせ（保留していない genie の行は、ほかのファイルの見回りも見る）。
   * ほかのファイルの見回りは本物の時計で動くので、保留をかける**前**の承認待ちに知らせることがある
   * （全体を一度に走らせたときだけ）。保留中に知らせないことを見るので、保留をかけたあとの知らせだけを数える。
   */
  const designNotices = async (c: AgentConnection, since: Date) =>
    (await notices(c, 'agent_session', since)).filter((n) => n.body.includes('design-app'));

  /** DB の時計のいま（知らせの created_at は DB の時計。Mac の時計とずれることがある）。 */
  const dbNow = async (c: AgentConnection) =>
    (
      await withTenant(harness.db, c.tenantId, (tx) =>
        sql<{ t: Date }>`select clock_timestamp() as t`.execute(tx),
      )
    ).rows[0]!.t;

  const notices = (c: AgentConnection, kind: string, since?: Date) =>
    withTenant(harness.db, c.tenantId, (tx) =>
      tx
        .selectFrom('user_notices')
        .select(['title', 'body', 'task_id'])
        .where('kind', '=', kind)
        .where('user_id', '=', c.userId)
        .$if(since !== undefined, (q) => q.where('created_at', '>=', since!))
        .orderBy('created_at')
        .execute(),
    );

  const setTask = (c: AgentConnection, id: string, status: string) =>
    withTenant(harness.db, c.tenantId, (tx) =>
      tx.updateTable('tasks').set({ status }).where('id', '=', id).execute(),
    );

  const newTask = async (c: AgentConnection, conversationId: string, title: string) =>
    (
      await harness.tasks.create({
        tenantId: c.tenantId,
        userId: c.userId,
        request: { kind: 'echo', title, input: {}, conversation_id: conversationId as never },
        idempotencyKey: `t:${uuidv7()}`,
      })
    ).task;

  const ticks = async (n = 5) => {
    for (let i = 0; i < n; i += 1) {
      await agentWatch.tick();
      await deskWatch.tick();
    }
  };

  beforeAll(async () => {
    harness = await makeTestApp({
      dbConfig: testDbConfig(url!, identityUrl),
      tokens: await makeTokens(),
      configure: (app) => {
        // ルートは本番と同じものを、テストの時計の WorkDesk で
        registerWorkDeskRoutes(app, {
          overview: (t: string, u: string) => deskRef.current!.overview(t, u),
          holds: { active: (t: string, u: string) => deskRef.current!.holds.active(t, u) },
        } as unknown as WorkDesk);
      },
    });
    store = new AgentSessionStore(harness.db, now);
    schedules = new ScheduleStore(harness.db);
    desk = new WorkDesk({ db: harness.db, tasks: harness.tasks, library: harness.library, schedules, tz: TZ, now: deskNow });
    deskRef.current = desk;
    agentWatch = new AgentSessionWatch({ db: harness.db, now });
    deskWatch = new WorkDeskWatch({
      db: harness.db,
      tz: TZ,
      now: deskNow,
      run: async (input) => {
        runs.push(input);
        return { taskId: null, answer: '承知しました。' };
      },
      notifyChat: async (_tenantId, userId, _conversationId, text) => {
        chats.push({ userId, text });
      },
    });
  });

  afterAll(async () => {
    await harness?.close();
  });

  it('holds a named piece of work until the day, without resuming it on its own', async () => {
    const { auth, connection: c, conversationId } = await signIn();
    // 名前に当たるセッション（承認待ち）と、当たらないセッション
    await store.record(c, {
      event: 'UserPromptSubmit',
      sessionId: 'd1',
      cwd: '/x/design-app',
      prompt: 'ヘッダを作って',
    });
    await store.record(c, { event: 'PermissionRequest', sessionId: 'd1' });
    await store.record(c, {
      event: 'UserPromptSubmit',
      sessionId: 'g1',
      cwd: '/x/genie',
      prompt: 'API を直して',
    });
    // 名前に当たる予約
    const job = await schedules.propose({
      tenantId: c.tenantId,
      userId: c.userId,
      conversationId,
      name: 'design-app の朝の確認',
      schedule: { kind: 'weekly', days: [1, 2, 3, 4, 5], hour: 9, minute: 0, tz: TZ },
      payload: { kind: 'reminder', text: '確認' },
      tz: TZ,
    });
    await schedules.activate(c.tenantId, job.id, new Date(clock + 3600_000));

    // 保留の前に、承認待ちを一度知らせておく（解除のあとにも、もう一度知らせることを見る）
    later(NEEDS_USER_NOTIFY_MS * 2);
    await ticks();
    expect((await designNotices(c, new Date(0))).length).toBe(1);
    const heldAt = await dbNow(c);
    const said = await desk.command(
      principal(c),
      conversationId,
      'design-app は来週まで保留。理由は仕様待ち。genie だけ進めて',
    );
    expect(said).toBe(
      '承知しました。「design-app」は 11/2（月）まで保留にします。Claude Code のセッション 1 件は知らせを止めました。予約「design-app の朝の確認」を止めました。勝手には再開しません。11/2（月）に、再開するか伺います。「genie」は止めていません。',
    );
    expect((await schedules.get(c.tenantId, c.userId, job.id))?.status).toBe('paused');
    const [hold] = await desk.holds.active(c.tenantId, c.userId);
    expect(hold).toMatchObject({
      subject: 'design-app',
      reason: '仕様待ち',
      untilDate: '2026-11-02',
    });

    // 承認待ちが 1 分を超えても、保留中は知らせない。保留のあとに始まった同じフォルダのセッションも静か
    await store.record(c, {
      event: 'UserPromptSubmit',
      sessionId: 'd2',
      cwd: '/x/design-app',
      prompt: '色を変えて',
    });
    await store.record(c, { event: 'PermissionRequest', sessionId: 'd2' });
    later(NEEDS_USER_NOTIFY_MS * 3);
    await ticks();
    expect(await designNotices(c, heldAt)).toEqual([]);
    const sessions = await store.list(c.tenantId, c.userId);
    expect(
      sessions
        .filter((s) => s.heldBy === hold!.id)
        .map((s) => s.externalSessionId)
        .sort(),
    ).toEqual(['d1', 'd2']);

    // 「全部進めて」でも保留は動かさない
    const all = await desk.command(principal(c), conversationId, '止まっているものを全部進めて');
    expect(all).toContain('保留中の「design-app」は進めません');
    expect((await desk.holds.active(c.tenantId, c.userId)).length).toBe(1);
    expect((await store.list(c.tenantId, c.userId)).filter((s) => s.heldBy).length).toBe(2);

    // 見通しは保留を「進めません」と言い、件数に数える
    const overview = await harness.app.inject({
      method: 'GET',
      url: '/v1/work/overview',
      headers: auth,
    });
    expect(overview.json<{ counts: { held: number; needs_user: number } }>().counts).toMatchObject({
      held: 1,
      needs_user: 0,
    });
    expect(overview.json<{ text: string }>().text).toContain(
      '保留中（進めません）: design-app（11/2（月）まで）',
    );

    // 保留の日（11/2 の朝）: 1 回だけ「再開しますか」と知らせる。解除はしない
    deskClock = Date.parse('2026-11-01T23:30:00Z');
    await ticks();
    await ticks();
    const due = await notices(c, 'work_hold');
    expect(due).toEqual([
      expect.objectContaining({
        title: '「design-app」の保留の日になりました',
        body: '再開するなら「design-appの保留を解除して」と話しかけてください。何もしなければ保留のままです。',
      }),
    ]);
    expect(chats.filter((x) => x.userId === c.userId)).toHaveLength(1);
    expect((await desk.holds.active(c.tenantId, c.userId)).length).toBe(1);
    expect(await designNotices(c, heldAt)).toEqual([]);

    // 解除: セッションは見守りに戻り、まだ待っているものは 1 分後に知らせる。予約も戻る
    const releasedAt = await dbNow(c);
    const released = await desk.command(
      principal(c),
      conversationId,
      'design-app の保留を解除して',
    );
    expect(released).toBe(
      '「design-app」の保留を解除しました。Claude Code のセッション 2 件の見守りを戻しました。予約「design-app の朝の確認」を再開しました。',
    );
    expect((await schedules.get(c.tenantId, c.userId, job.id))?.status).toBe('active');
    later(NEEDS_USER_NOTIFY_MS + 1000);
    await ticks();
    expect((await designNotices(c, releasedAt)).length).toBe(2);
  });

  it('asks which one when told to hold "this", and leaves others alone', async () => {
    const { connection: c, conversationId } = await signIn();
    await store.record(c, {
      event: 'UserPromptSubmit',
      sessionId: 'q1',
      cwd: '/x/api',
      prompt: 'x',
    });
    const said = await desk.command(
      principal(c),
      conversationId,
      'この案件は来週まで保留。関連タスクも進めないで',
    );
    expect(said).toContain('どれを保留にするか、名前で教えてください');
    expect(said).toContain('api');
    expect(await desk.holds.active(c.tenantId, c.userId)).toEqual([]);
    // 保留の無い「再開して」はほかの話へ回す
    expect(await desk.command(principal(c), conversationId, '音楽を再開して')).toBeNull();
  });

  it('starts a follow-up only once, and only after the earlier work completed', async () => {
    const { connection: c, conversationId } = await signIn();
    const first = await newTask(c, conversationId, 'API の実装');
    await setTask(c, first.id, 'RUNNING');
    expect(
      await desk.command(principal(c), conversationId, 'これが終わったら統合テストを実行して'),
    ).toBe(
      '承知しました。「API の実装」が終わったら「統合テストを実行して」を始めます。終わらなかったときは始めずにお知らせします。',
    );
    expect((await desk.overview(c.tenantId, c.userId)).text).toContain(
      '前の仕事が終わったら始めるもの: 「統合テストを実行して」',
    );
    await ticks();
    expect(runs.filter((r) => r.userId === c.userId)).toEqual([]);

    await setTask(c, first.id, 'COMPLETED');
    await ticks();
    await ticks();
    const mine = runs.filter((r) => r.userId === c.userId);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ text: '統合テストを実行して', conversationId });
    expect(await notices(c, 'task_followup')).toEqual([
      expect.objectContaining({ title: '「API の実装」が終わったので、続きを始めました' }),
    ]);

    // 失敗したら始めない
    const second = await newTask(c, conversationId, 'ビルド');
    await setTask(c, second.id, 'RUNNING');
    await desk.command(principal(c), conversationId, 'これが終わったらデプロイの手順を書いて');
    await setTask(c, second.id, 'FAILED');
    await ticks();
    expect(runs.filter((r) => r.userId === c.userId)).toHaveLength(1);
    expect((await notices(c, 'task_followup')).at(-1)?.title).toBe(
      '「ビルド」が終わらなかったので、続きは始めていません',
    );
  });

  it('does not start a follow-up that touches something held', async () => {
    const { connection: c, conversationId } = await signIn();
    const first = await newTask(c, conversationId, '実装');
    await setTask(c, first.id, 'RUNNING');
    // 保留中の名前に触れる頼みは受けない
    await desk.command(principal(c), conversationId, 'デザインは保留');
    expect(
      await desk.command(principal(c), conversationId, '終わったらデザインを直して'),
    ).toContain('「デザイン」は保留中なので、この頼みは受けていません');
    // 受けたあとに保留になったものは、始める時に止める
    await desk.command(principal(c), conversationId, 'デザインの保留を解除して');
    await desk.command(principal(c), conversationId, '終わったらデザインを直して');
    await desk.command(principal(c), conversationId, 'デザインは保留');
    await setTask(c, first.id, 'COMPLETED');
    await ticks();
    expect(runs.filter((r) => r.userId === c.userId)).toEqual([]);
    expect((await notices(c, 'task_followup')).at(-1)?.title).toBe(
      '「デザイン」が保留中なので、続きは始めていません',
    );
  });
});
