/**
 * ほかの AI（Claude Code）の承認待ち・停滞の知らせ（agent-session-watch.ts）。
 *
 * 見ること:
 *   - 承認待ちが 1 分続いたら、Mac の通知とチャットへ 1 回だけ知らせる（同じ待ちに出来事が重ねて届いても二度出さない）
 *   - ターミナルの前ですぐ承認したものは知らせない
 *   - 作業中のまま 15 分届かなければ「止まっているかもしれません」と知らせる（推した状態だと言い分ける）
 *   - 応答を終えた（Stop）だけのセッションは知らせない
 *   - 本人が止めたセッションは知らせない。戻したら、まだ待っているものは知らせる
 *   - チャットへの文に頼みの頭を載せない
 *   - Mac は GET /v1/notices で agent_session のお知らせを受け取れる
 *   ./infra/db/with-test-db.sh pnpm --filter @genie/service-api-gateway test
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type TokenResponse, uuidv7 } from '@genie/contracts';
import { withTenant } from '@genie/db';
import { AgentSessionStore, NEEDS_USER_NOTIFY_MS, STALL_AFTER_MS } from '../src/agent-sessions.js';
import { AgentSessionWatch } from '../src/agent-session-watch.js';
import { makeTestApp, makeTokens, testDbConfig, type TestApp } from './support.js';

const url = process.env['TEST_DATABASE_URL'];
const identityUrl = process.env['TEST_IDENTITY_DATABASE_URL'];

describe.skipIf(!url)('agent session notices (Claude Code)', () => {
  let harness: TestApp;
  let clock = Date.now();
  const now = () => new Date(clock);
  const chats: { tenantId: string; userId: string; text: string }[] = [];
  let store: AgentSessionStore;
  let watch: AgentSessionWatch;

  const signIn = async () => {
    const issued = await harness.app.inject({
      method: 'POST',
      url: '/v1/auth/dev/token',
      payload: { email: `w-${uuidv7()}@example.com`, display_name: 'W' },
    });
    const access = issued.json<TokenResponse>().access_token;
    const auth = { authorization: `Bearer ${access}` };
    const key = await harness.app.inject({
      method: 'POST',
      url: '/v1/agent-connections',
      headers: auth,
      payload: { source: 'claude_code' },
    });
    const connection = (await store.identify(key.json<{ token: string }>().token))!;
    return { auth, connection };
  };

  const notices = (tenantId: string) =>
    withTenant(harness.db, tenantId, (tx) =>
      tx
        .selectFrom('user_notices')
        .select(['kind', 'title', 'body'])
        .where('kind', '=', 'agent_session')
        .orderBy('created_at')
        .execute(),
    );

  const later = (ms: number) => {
    clock += ms;
  };

  beforeAll(async () => {
    harness = await makeTestApp({
      dbConfig: testDbConfig(url!, identityUrl),
      tokens: await makeTokens(),
      schedules: { now: () => clock },
    });
    store = new AgentSessionStore(harness.db, now);
    watch = new AgentSessionWatch({
      db: harness.db,
      now,
      notifyChat: async (tenantId, userId, text) => {
        chats.push({ tenantId, userId, text });
      },
    });
  });

  afterAll(async () => {
    await harness?.close();
  });

  // 見回りはテナントをまたぐので、ほかのテストの行が残っていても自分の分だけ数える
  const tickFor = async (tenantId: string) => {
    // 1 回の見回りは 20 件まで。ほかのテストの行で埋まっても自分の行に届くよう、数回まわす
    for (let i = 0; i < 5; i += 1) await watch.tick();
    return (await notices(tenantId)).length;
  };

  it('tells the user once when an approval has waited a minute, on the Mac and in chat', async () => {
    const { auth, connection } = await signIn();
    await store.record(connection, {
      event: 'UserPromptSubmit',
      sessionId: 'w1',
      cwd: '/Users/me/genie',
      prompt: '決済の秘密の仕様を直して',
    });
    await store.record(connection, { event: 'PermissionRequest', sessionId: 'w1' });

    later(NEEDS_USER_NOTIFY_MS / 2);
    expect(await tickFor(connection.tenantId)).toBe(0);
    later(NEEDS_USER_NOTIFY_MS / 2 + 1000);
    expect(await tickFor(connection.tenantId)).toBe(1);
    expect((await notices(connection.tenantId))[0]).toMatchObject({
      kind: 'agent_session',
      title: 'Claude Code が承認を待っています',
      body: expect.stringContaining('決済の秘密の仕様を直して（genie）'),
    });
    const said = chats.filter((c) => c.tenantId === connection.tenantId);
    expect(said).toHaveLength(1);
    expect(said[0]!.text).toBe(
      '🔔 Claude Code（genie）が承認を待っています。Mac のターミナルで確かめてください。',
    );
    // チャット（外のサービス）へは頼みの頭を載せない
    expect(said[0]!.text).not.toContain('決済');

    // 同じ待ちに出来事が重ねて届いても、二度知らせない
    await store.record(connection, {
      event: 'Notification',
      sessionId: 'w1',
      notificationType: 'permission_prompt',
    });
    later(NEEDS_USER_NOTIFY_MS * 2);
    expect(await tickFor(connection.tenantId)).toBe(1);

    // Mac は GET /v1/notices で受け取る
    const listed = await harness.app.inject({ method: 'GET', url: '/v1/notices', headers: auth });
    expect(listed.json<{ items: { kind: string; title: string }[] }>().items).toEqual([
      expect.objectContaining({ kind: 'agent_session', title: 'Claude Code が承認を待っています' }),
    ]);
  });

  it('says nothing about an approval answered at the terminal right away', async () => {
    const { connection } = await signIn();
    await store.record(connection, { event: 'UserPromptSubmit', sessionId: 'w2', prompt: 'x' });
    await store.record(connection, { event: 'PermissionRequest', sessionId: 'w2' });
    later(10_000);
    await store.record(connection, { event: 'PostToolUse', sessionId: 'w2' });
    later(NEEDS_USER_NOTIFY_MS * 2);
    expect(await tickFor(connection.tenantId)).toBe(0);
  });

  it('says a quiet working session might be stuck, and only after 15 minutes', async () => {
    const { connection } = await signIn();
    await store.record(connection, {
      event: 'UserPromptSubmit',
      sessionId: 'w3',
      cwd: '/x/api',
      prompt: 'テストを直して',
    });
    later(STALL_AFTER_MS - 1000);
    expect(await tickFor(connection.tenantId)).toBe(0);
    later(2000);
    expect(await tickFor(connection.tenantId)).toBe(1);
    expect((await notices(connection.tenantId))[0]!.title).toBe(
      'Claude Code が止まっているかもしれません',
    );
    expect(chats.find((c) => c.tenantId === connection.tenantId)?.text).toBe(
      '🔔 Claude Code（api）が 15 分以上動いていません。止まっているかもしれません。',
    );
    // 一度知らせたら、また動き出すまで知らせない
    later(STALL_AFTER_MS * 2);
    expect(await tickFor(connection.tenantId)).toBe(1);
    // 動いて、また 15 分止まったら、それは別の停滞
    await store.record(connection, { event: 'PostToolUse', sessionId: 'w3' });
    later(STALL_AFTER_MS + 1000);
    expect(await tickFor(connection.tenantId)).toBe(2);
  });

  it('does not tell anyone about a session that only finished its response', async () => {
    const { connection } = await signIn();
    await store.record(connection, { event: 'UserPromptSubmit', sessionId: 'w4', prompt: 'x' });
    later(1000);
    await store.record(connection, { event: 'Stop', sessionId: 'w4' });
    // Claude Code は応答を終えて時間がたつと「入力を待っています」を送ってくる。返事待ちではない（2026-10-29 の実物）
    later(111_000);
    await store.record(connection, {
      event: 'Notification',
      sessionId: 'w4',
      notificationType: 'idle_prompt',
      message: 'Claude is waiting for your input',
    });
    later(STALL_AFTER_MS * 2);
    expect(await tickFor(connection.tenantId)).toBe(0);
  });

  it('stays quiet for a session the user paused, and speaks again once it is watched', async () => {
    const { connection } = await signIn();
    await store.record(connection, { event: 'UserPromptSubmit', sessionId: 'w5', prompt: 'x' });
    const waiting = await store.record(connection, { event: 'Elicitation', sessionId: 'w5' });
    await store.setPolicy(connection.tenantId, connection.userId, waiting.id, 'paused_by_user');
    later(NEEDS_USER_NOTIFY_MS * 3);
    expect(await tickFor(connection.tenantId)).toBe(0);
    // 止めている間に届いた出来事でも知らせない
    await store.record(connection, {
      event: 'Notification',
      sessionId: 'w5',
      notificationType: 'idle_prompt',
    });
    later(NEEDS_USER_NOTIFY_MS * 3);
    expect(await tickFor(connection.tenantId)).toBe(0);

    await store.setPolicy(connection.tenantId, connection.userId, waiting.id, 'watch');
    expect(await tickFor(connection.tenantId)).toBe(1);
    expect((await notices(connection.tenantId))[0]!.title).toBe(
      'Claude Code があなたの返事を待っています',
    );
  });
});
