/**
 * 仕事のホーム（work-home.ts・routes/work-home.ts）を DB で。
 *
 * 見ること:
 *   - 「仕事のホームを開いて」で本人だけのリンクを出し、そのリンクでページ・中身・台帳が読める
 *   - 中身と台帳に Claude Code の頼みの頭が出ない
 *   - ほかの人の仕事の台帳は、自分のリンクでは読めない（404）。知らないリンク・切れたリンクは 410
 *   - LIFF の入口（/v1/channels/board?liff.state=/w/<リンク>）から仕事のホームへ移る
 *   - 公開の場所が無ければリンクを作らず、そう言う
 *   ./infra/db/with-test-db.sh pnpm --filter @genie/service-api-gateway test
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type TokenResponse, uuidv7 } from '@genie/contracts';
import { withTenant } from '@genie/db';
import { AgentSessionStore, type AgentConnection } from '../src/agent-sessions.js';
import { WorkDesk } from '../src/work-desk.js';
import {
  WorkLinkStore,
  homeLinkFor,
  openHomeAnswer,
  workUrlFor,
  type HomeView,
} from '../src/work-home.js';
import { registerWorkHomeRoutes } from '../src/routes/work-home.js';
import type { Ledger } from '../src/work-ledger.js';
import { makeTestApp, makeTokens, testDbConfig, type TestApp } from './support.js';

const url = process.env['TEST_DATABASE_URL'];
const identityUrl = process.env['TEST_IDENTITY_DATABASE_URL'];
const TZ = 'Asia/Tokyo';
const PUBLIC = 'https://genie.example';

describe.skipIf(!url)('work home', () => {
  let harness: TestApp;
  let store: AgentSessionStore;
  let links: WorkLinkStore;
  let desk: WorkDesk;
  const deskRef: { current: WorkDesk | null } = { current: null };

  const signIn = async () => {
    const issued = await harness.app.inject({
      method: 'POST',
      url: '/v1/auth/dev/token',
      payload: { email: `h-${uuidv7()}@example.com`, display_name: 'H' },
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
    return { connection, conversationId: conversation.json<{ id: string }>().id };
  };
  const principal = (c: AgentConnection) => ({ tenantId: c.tenantId, userId: c.userId });
  const get = (path: string) => harness.app.inject({ method: 'GET', url: path });
  const tokenOf = (answer: string) =>
    /\/v1\/channels\/work\/([A-Za-z0-9_-]{32})\)/.exec(answer)?.[1];

  beforeAll(async () => {
    harness = await makeTestApp({
      dbConfig: testDbConfig(url!, identityUrl),
      tokens: await makeTokens(),
      configure: (app) => {
        const lazy = new Proxy({} as WorkDesk, {
          get: (_t, key) => {
            const d = deskRef.current!;
            const v = (d as unknown as Record<string | symbol, unknown>)[key];
            return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(d) : v;
          },
        });
        registerWorkHomeRoutes(app, {
          desk: lazy,
          links: { byToken: (t: string) => links.byToken(t) } as WorkLinkStore,
        });
      },
    });
    store = new AgentSessionStore(harness.db);
    links = new WorkLinkStore(harness.db);
    const urlFor = workUrlFor({ publicUrl: PUBLIC, liffId: null });
    desk = new WorkDesk({
      db: harness.db,
      tasks: harness.tasks,
      library: harness.library,
      schedules: null,
      tz: TZ,
      openHome: (p) => openHomeAnswer({ links, urlFor, principal: p, now: new Date() }),
      homeLink: (p) => homeLinkFor({ links, urlFor, principal: p, now: new Date() }),
    });
    deskRef.current = desk;
  });

  afterAll(async () => {
    await harness?.close();
  });

  it('opens a personal, read-only home that leads with what needs the user', async () => {
    const { connection: c, conversationId } = await signIn();
    const project = `home-${uuidv7().slice(-6)}`;
    await store.record(c, {
      event: 'UserPromptSubmit',
      sessionId: 'h1',
      cwd: `/x/${project}`,
      prompt: '秘密の決済仕様を直して',
    });
    await store.record(c, { event: 'PermissionRequest', sessionId: 'h1' });

    const answer = (await desk.command(principal(c), conversationId, '仕事のホームを開いて'))!;
    expect(answer).toMatch(/^仕事のホームです。確認が必要なものを先頭に出しています/);
    expect(answer).toContain(`[仕事のホームを開く](${PUBLIC}/v1/channels/work/`);
    const token = tokenOf(answer)!;

    const page = await get(`/v1/channels/work/${token}`);
    expect(page.statusCode).toBe(200);
    expect(page.headers['cache-control']).toBe('no-store');
    expect(page.body).toContain('仕事のホーム');

    const state = await get(`/v1/channels/work/${token}/state`);
    expect(state.statusCode).toBe(200);
    const home = state.json<HomeView>();
    expect(home.attention).toEqual([
      expect.stringMatching(new RegExp(`^Claude Code（${project}）が承認を待っています`)),
    ]);
    expect(home.items[0]).toMatchObject({
      kind: 'session',
      name: `Claude Code（${project}）`,
      tone: 'needs',
    });
    expect(state.body).not.toContain('決済');

    const item = await get(`/v1/channels/work/${token}/item/s/${home.items[0]!.id}`);
    expect(item.statusCode).toBe(200);
    const ledger = item.json<Ledger>();
    expect(ledger.request).toBeNull();
    expect(ledger.next).toMatch(/^承認を待っています/);
    expect(item.body).not.toContain('決済');

    // LIFF の入口から移る
    const entry = await get(`/v1/channels/board?liff.state=${encodeURIComponent(`/w/${token}`)}`);
    expect(entry.statusCode).toBe(200);
    expect(entry.body).toContain(`location.replace("/v1/channels/work/${token}")`);
  });

  it('answers "how is work going" with a card in the home order, and plain text elsewhere', async () => {
    const { connection: c, conversationId } = await signIn();
    const project = `card-${uuidv7().slice(-6)}`;
    await store.record(c, {
      event: 'UserPromptSubmit',
      sessionId: 'k1',
      cwd: `/x/${project}`,
      prompt: '秘密の決済仕様を直して',
    });
    await store.record(c, { event: 'PermissionRequest', sessionId: 'k1' });

    const said = (await desk.answer(principal(c), conversationId, '今の作業どうなってる？'))!;
    // 文は command と同じ（Slack・通知はこの文）
    expect(said.text).toBe(
      await desk.command(principal(c), conversationId, '今の作業どうなってる？'),
    );
    const card = JSON.parse(said.card!) as Record<string, unknown>;
    expect(card).toMatchObject({
      schema: 'genie.work/v1',
      counts: { needsUser: 1 },
      attention: [
        expect.stringMatching(new RegExp(`^Claude Code（${project}）が承認を待っています`)),
      ],
      items: [{ name: `Claude Code（${project}）`, tone: 'needs' }],
    });
    expect(card['homeUrl']).toMatch(new RegExp(`^${PUBLIC}/v1/channels/work/[A-Za-z0-9_-]{32}$`));
    expect(said.card).not.toContain('決済');
    // 見通し以外の答え（保留の案内など）にはカードを付けない
    const other = await desk.answer(principal(c), conversationId, 'genie の保留を解除して');
    expect(other).toEqual({ text: 'いま保留にしているものはありません。' });
  });

  it("does not show someone else's work through your link, and refuses unknown or expired links", async () => {
    const mine = await signIn();
    const other = await signIn();
    await store.record(other.connection, {
      event: 'UserPromptSubmit',
      sessionId: 'o1',
      cwd: '/x/other',
      prompt: 'ほかの人の仕事',
    });
    const [theirs] = await store.list(other.connection.tenantId, other.connection.userId);
    const token = await links.issue(mine.connection.tenantId, mine.connection.userId, new Date());
    expect((await get(`/v1/channels/work/${token}/item/s/${theirs!.id}`)).statusCode).toBe(404);
    expect((await get(`/v1/channels/work/${token}/item/t/${theirs!.id}`)).statusCode).toBe(404);
    expect((await get(`/v1/channels/work/${token}/item/s/not-an-id`)).statusCode).toBe(404);

    // 同じテナントの別の人の id でも読めない（リンクの本人のものだけ）
    expect(
      await desk.ledger.forSession(other.connection.tenantId, uuidv7(), theirs!.id),
    ).toBeNull();

    expect((await get(`/v1/channels/work/${'Z'.repeat(32)}`)).statusCode).toBe(410);
    expect((await get(`/v1/channels/work/${'Z'.repeat(32)}/state`)).statusCode).toBe(410);
    // 切れたリンク
    await withTenant(harness.db, mine.connection.tenantId, (tx) =>
      tx
        .updateTable('work_links')
        .set({ expires_at: new Date(Date.now() - 1000) })
        .execute(),
    );
    expect((await get(`/v1/channels/work/${token}/state`)).statusCode).toBe(410);
  });

  it('does not make a link when there is no public place to open it', async () => {
    const { connection: c } = await signIn();
    const answer = await openHomeAnswer({
      links,
      urlFor: workUrlFor({ publicUrl: null, liffId: null }),
      principal: principal(c),
      now: new Date(),
    });
    expect(answer).toMatch(
      /^仕事のホームを LINE から開くための公開の場所が、まだ設定されていません/,
    );
    const rows = await withTenant(harness.db, c.tenantId, (tx) =>
      tx.selectFrom('work_links').select('token_hash').where('user_id', '=', c.userId).execute(),
    );
    expect(rows).toEqual([]);
  });
});
