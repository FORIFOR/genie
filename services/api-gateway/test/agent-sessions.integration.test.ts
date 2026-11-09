/**
 * ほかの AI（Claude Code）に頼んだ仕事の見守り。hooks の受け口 → セッションの 1 行 → Task Dock の一覧。
 *
 * 見ること:
 *   - 鍵は本人だけが発行でき、平文は発行の応答にしか出ない。取り消した鍵・知らない鍵では受けない
 *   - 3 つのセッションを別々に見分ける
 *   - 承認待ちが一覧で needs_user になる。応答を終えた（Stop）は idle で、終わった扱いにしない
 *   - 本人が止めたセッションは paused のまま（出来事が届いても見守りに戻さない）
 *   - 道具の入出力・頼みの全文・フルパスは残さない
 *   - ほかの人には見えない・止められない
 *   ./infra/db/with-test-db.sh pnpm --filter @genie/service-api-gateway test
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type TokenResponse, uuidv7 } from '@genie/contracts';
import { withTenant } from '@genie/db';
import { AgentSessionStore, TURN_SETTLE_MS } from '../src/agent-sessions.js';
import { makeTestApp, makeTokens, testDbConfig, type TestApp } from './support.js';
import type { App } from '../src/fastify.js';

const url = process.env['TEST_DATABASE_URL'];
const identityUrl = process.env['TEST_IDENTITY_DATABASE_URL'];

type SessionView = {
  id: string;
  external_session_id: string;
  project: string | null;
  title: string | null;
  state: string;
  waiting_reason: string | null;
  user_policy: string;
  attention: string;
  confidence: string;
};

describe.skipIf(!url)('agent sessions (Claude Code hooks)', () => {
  let harness: TestApp;
  let app: App;

  const signIn = async () => {
    const issued = await app.inject({
      method: 'POST',
      url: '/v1/auth/dev/token',
      payload: { email: `a-${uuidv7()}@example.com`, display_name: 'A' },
    });
    const access = issued.json<TokenResponse>().access_token;
    return {
      auth: { authorization: `Bearer ${access}` },
      tenantId: (
        JSON.parse(Buffer.from(access.split('.')[1]!, 'base64url').toString()) as { tid: string }
      ).tid,
    };
  };

  const connect = async (auth: { authorization: string }) => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/agent-connections',
      headers: auth,
      payload: { source: 'claude_code' },
    });
    expect(res.statusCode).toBe(201);
    return res.json<{ id: string; token: string }>();
  };

  const hook = (token: string, body: Record<string, unknown>) =>
    app.inject({
      method: 'POST',
      url: '/v1/agent-events/claude-code',
      headers: { authorization: `Bearer ${token}` },
      payload: { cwd: '/Users/someone/Projects/genie', transcript_path: '/tmp/t.jsonl', ...body },
    });

  const sessions = async (auth: { authorization: string }) =>
    (await app.inject({ method: 'GET', url: '/v1/agent-sessions', headers: auth })).json<{
      items: SessionView[];
    }>().items;

  beforeAll(async () => {
    harness = await makeTestApp({
      dbConfig: testDbConfig(url!, identityUrl),
      tokens: await makeTokens(),
    });
    app = harness.app;
  });

  afterAll(async () => {
    await harness?.close();
  });

  it('issues a key only to the signed-in user and accepts events only with a live key', async () => {
    const { auth } = await signIn();
    const anonymous = await app.inject({
      method: 'POST',
      url: '/v1/agent-connections',
      payload: { source: 'claude_code' },
    });
    expect(anonymous.statusCode).toBe(401);

    const key = await connect(auth);
    expect(key.token).toMatch(/^gac_/);
    // 一覧には平文を出さない
    const listed = await app.inject({ method: 'GET', url: '/v1/agent-connections', headers: auth });
    expect(listed.body).not.toContain(key.token);

    expect(
      (await hook(key.token, { hook_event_name: 'SessionStart', session_id: 'k1' })).statusCode,
    ).toBe(202);
    expect(
      (await hook('gac_' + 'x'.repeat(43), { hook_event_name: 'SessionStart', session_id: 'k2' }))
        .statusCode,
    ).toBe(401);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/v1/agent-events/claude-code',
          payload: { hook_event_name: 'SessionStart', session_id: 'k3' },
        })
      ).statusCode,
    ).toBe(401);

    const revoked = await app.inject({
      method: 'DELETE',
      url: `/v1/agent-connections/${key.id}`,
      headers: auth,
    });
    expect(revoked.statusCode).toBe(204);
    expect((await hook(key.token, { hook_event_name: 'Stop', session_id: 'k1' })).statusCode).toBe(
      401,
    );
  });

  it('tells three sessions apart and shows approvals as needing the user', async () => {
    const { auth } = await signIn();
    const { token } = await connect(auth);
    for (const id of ['s-api', 's-web', 's-docs']) {
      await hook(token, { hook_event_name: 'SessionStart', session_id: id, source: 'startup' });
      await hook(token, {
        hook_event_name: 'UserPromptSubmit',
        session_id: id,
        prompt: `${id} を実装して\n秘密の詳細 sk-ant-abcdefghijklmnopqrstu`,
      });
    }
    await hook(token, {
      hook_event_name: 'PreToolUse',
      session_id: 's-web',
      tool_name: 'Bash',
      tool_input: { command: 'cat secret-file-content-should-not-be-kept' },
    });
    await hook(token, {
      hook_event_name: 'PermissionRequest',
      session_id: 's-api',
      tool_name: 'Bash',
      tool_input: { command: 'rm -rf build' },
    });
    await hook(token, {
      hook_event_name: 'Stop',
      session_id: 's-docs',
      last_assistant_message: 'ドキュメントを書きました',
    });

    const items = await sessions(auth);
    expect(items).toHaveLength(3);
    const by = Object.fromEntries(items.map((s) => [s.external_session_id, s]));
    expect(by['s-api']).toMatchObject({
      state: 'waiting_user',
      waiting_reason: 'permission',
      attention: 'needs_user',
      confidence: 'confirmed',
      title: 's-api を実装して',
      project: 'genie',
    });
    expect(by['s-web']).toMatchObject({ state: 'working', attention: 'working' });
    // 応答を終えただけ。終わった扱い（ended）にしない
    expect(by['s-docs']).toMatchObject({ state: 'idle', attention: 'idle' });

    // 承認されて道具が動けば作業中に戻る
    await hook(token, { hook_event_name: 'PostToolUse', session_id: 's-api', tool_name: 'Bash' });
    expect((await sessions(auth)).find((s) => s.external_session_id === 's-api')).toMatchObject({
      state: 'working',
      waiting_reason: null,
    });

    await hook(token, { hook_event_name: 'SessionEnd', session_id: 's-web', reason: 'logout' });
    expect((await sessions(auth)).find((s) => s.external_session_id === 's-web')).toMatchObject({
      state: 'ended',
      attention: 'ended',
    });
  });

  it('keeps no tool input, no full request text and no full path', async () => {
    const { auth, tenantId } = await signIn();
    const { token } = await connect(auth);
    await hook(token, {
      hook_event_name: 'UserPromptSubmit',
      session_id: 'p1',
      prompt: '一行目\n二行目の秘密',
    });
    await hook(token, {
      hook_event_name: 'PostToolUse',
      session_id: 'p1',
      tool_input: { command: 'echo tool-input-marker' },
      tool_response: { stdout: 'tool-output-marker' },
    });
    const rows = await withTenant(harness.db, tenantId, (tx) =>
      tx.selectFrom('agent_sessions').selectAll().where('external_session_id', '=', 'p1').execute(),
    );
    const stored = JSON.stringify(rows);
    expect(stored).toContain('一行目');
    for (const leak of [
      '二行目の秘密',
      'tool-input-marker',
      'tool-output-marker',
      '/Users/someone',
      '/tmp/t.jsonl',
    ])
      expect(stored).not.toContain(leak);
  });

  it('keeps a session the user paused as paused, whatever arrives', async () => {
    const { auth } = await signIn();
    const { token } = await connect(auth);
    await hook(token, { hook_event_name: 'UserPromptSubmit', session_id: 'q1', prompt: 'やって' });
    const id = (await sessions(auth))[0]!.id;

    const paused = await app.inject({
      method: 'PATCH',
      url: `/v1/agent-sessions/${id}`,
      headers: auth,
      payload: { user_policy: 'paused_by_user' },
    });
    expect(paused.json<SessionView>()).toMatchObject({
      user_policy: 'paused_by_user',
      attention: 'paused',
    });

    await hook(token, { hook_event_name: 'PermissionRequest', session_id: 'q1' });
    await hook(token, { hook_event_name: 'PostToolUse', session_id: 'q1' });
    expect((await sessions(auth))[0]).toMatchObject({
      user_policy: 'paused_by_user',
      attention: 'paused',
    });

    const resumed = await app.inject({
      method: 'PATCH',
      url: `/v1/agent-sessions/${id}`,
      headers: auth,
      payload: { user_policy: 'watch' },
    });
    expect(resumed.json<SessionView>()).toMatchObject({
      user_policy: 'watch',
      attention: 'working',
    });
  });

  it("does not show or change someone else's sessions", async () => {
    const owner = await signIn();
    const other = await signIn();
    const { token } = await connect(owner.auth);
    await hook(token, {
      hook_event_name: 'UserPromptSubmit',
      session_id: 'o1',
      prompt: '私の仕事',
    });
    const id = (await sessions(owner.auth))[0]!.id;

    expect(await sessions(other.auth)).toEqual([]);
    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/agent-sessions/${id}`,
      headers: other.auth,
      payload: { user_policy: 'paused_by_user' },
    });
    expect(res.statusCode).toBe(404);
    expect((await sessions(owner.auth))[0]!.user_policy).toBe('watch');
  });

  it('does not let a tool event arriving just after Stop put the session back to working', async () => {
    const { auth, tenantId } = await signIn();
    const { token } = await connect(auth);
    let clock = Date.now();
    const store = new AgentSessionStore(harness.db, () => new Date(clock));
    const connection = (await store.identify(token))!;
    expect(connection.tenantId).toBe(tenantId);

    await store.record(connection, { event: 'UserPromptSubmit', sessionId: 'late', prompt: 'x' });
    await store.record(connection, { event: 'Stop', sessionId: 'late' });
    clock += TURN_SETTLE_MS - 1000;
    expect(
      (await store.record(connection, { event: 'PostToolUse', sessionId: 'late' })).state,
    ).toBe('idle');
    // 落ち着いたあとの道具の出来事は、本当に動いている印
    clock += TURN_SETTLE_MS;
    expect(
      (await store.record(connection, { event: 'PostToolUse', sessionId: 'late' })).state,
    ).toBe('working');
    // 次の頼みは、Stop の直後でも作業中にする
    await store.record(connection, { event: 'Stop', sessionId: 'late' });
    expect(
      (
        await store.record(connection, {
          event: 'UserPromptSubmit',
          sessionId: 'late',
          prompt: 'y',
        })
      ).state,
    ).toBe('working');
  });
});

/**
 * 別の PC の Claude Code（remote-hooks.ts）。Mac で 10 分・1 回のコマンドを出し、別の PC がそれで鍵を受け取る。
 */
describe.skipIf(!url)('agent sessions from another computer', () => {
  let harness: TestApp;
  let app: App;
  const publicUrl = 'https://genie-test.trycloudflare.com';

  beforeAll(async () => {
    harness = await makeTestApp({
      dbConfig: testDbConfig(url!, identityUrl),
      tokens: await makeTokens(),
      publicUrl,
    });
    app = harness.app;
  });

  afterAll(async () => {
    await harness?.close();
  });

  const signIn = async () => {
    const issued = await app.inject({
      method: 'POST',
      url: '/v1/auth/dev/token',
      payload: { email: `r-${uuidv7()}@example.com`, display_name: 'R' },
    });
    return { authorization: `Bearer ${issued.json<TokenResponse>().access_token}` };
  };

  const pair = async (auth: { authorization: string }, device: string) => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/agent-connections/remote',
      headers: auth,
      payload: { device },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json<{ command: string; expires_at: string }>();
    const code = /\/v1\/agent-pair\/([A-Za-z0-9_-]{43}) \| sh$/.exec(body.command)?.[1];
    expect(body.command.startsWith(`curl -fsSL ${publicUrl}/v1/agent-pair/`)).toBe(true);
    return code!;
  };

  const fetchInstaller = (code: string) =>
    app.inject({ method: 'GET', url: `/v1/agent-pair/${code}` });

  const tokenIn = (script: string) => /'(gac_[A-Za-z0-9_-]{43})'/.exec(script)?.[1];

  const hook = (token: string) =>
    app.inject({
      method: 'POST',
      url: '/v1/agent-events/claude-code',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        hook_event_name: 'SessionStart',
        session_id: `s-${uuidv7()}`,
        cwd: '/Users/other/Projects/genie',
      },
    });

  it('gives the other computer its own key once, through a one-time command', async () => {
    const auth = await signIn();
    const code = await pair(auth, 'MacBook Air');

    // ログインなしで取りに来られる（合言葉が鍵の代わり）。2 回目は使えない
    const first = await fetchInstaller(code);
    expect(first.statusCode).toBe(200);
    expect(first.headers['content-type']).toContain('text/x-shellscript');
    expect(first.headers['cache-control']).toBe('no-store');
    expect(first.body).toContain(`base='${publicUrl}'`);
    const token = tokenIn(first.body);
    expect(token).toBeDefined();
    const again = await fetchInstaller(code);
    expect(again.statusCode).toBe(404);
    expect(again.body).not.toContain('gac_');
    expect((await fetchInstaller('x'.repeat(43))).statusCode).toBe(404);

    expect((await hook(token!)).statusCode).toBe(202);
    const listed = (
      await app.inject({ method: 'GET', url: '/v1/agent-connections', headers: auth })
    ).json<{ items: { label: string; device: string | null }[] }>().items;
    expect(listed).toEqual([
      expect.objectContaining({ label: 'Claude Code（MacBook Air）', device: 'MacBook Air' }),
    ]);

    // 同じ PC をつなぎ直すと、前の鍵は使えなくなる
    const second = tokenIn((await fetchInstaller(await pair(auth, 'MacBook Air'))).body);
    expect((await hook(token!)).statusCode).toBe(401);
    expect((await hook(second!)).statusCode).toBe(202);
  });

  it('refuses names that could break the shell, and works only for the signed-in user', async () => {
    const auth = await signIn();
    const bad = await app.inject({
      method: 'POST',
      url: '/v1/agent-connections/remote',
      headers: auth,
      payload: { device: "Air'; echo hi" },
    });
    expect(bad.statusCode).toBe(400);
    const anonymous = await app.inject({
      method: 'POST',
      url: '/v1/agent-connections/remote',
      payload: { device: 'MacBook Air' },
    });
    expect(anonymous.statusCode).toBe(401);
  });
});

describe.skipIf(!url)('agent sessions from another computer without a public URL', () => {
  it('does not hand out a command nobody could reach', async () => {
    const harness = await makeTestApp({
      dbConfig: testDbConfig(url!, identityUrl),
      tokens: await makeTokens(),
    });
    try {
      const issued = await harness.app.inject({
        method: 'POST',
        url: '/v1/auth/dev/token',
        payload: { email: `n-${uuidv7()}@example.com`, display_name: 'N' },
      });
      const res = await harness.app.inject({
        method: 'POST',
        url: '/v1/agent-connections/remote',
        headers: { authorization: `Bearer ${issued.json<TokenResponse>().access_token}` },
        payload: { device: 'MacBook Air' },
      });
      expect(res.statusCode).toBe(503);
      expect(res.body).not.toContain('agent-pair');
    } finally {
      await harness.close();
    }
  });
});
