/**
 * 接続が切れたときの知らせと、LINE からのつなぎ直し（src/connector-reconnect.ts）。
 *   ./infra/db/with-test-db.sh pnpm --filter @genie/service-api-gateway test
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type TokenResponse, uuidv7 } from '@genie/contracts';
import { withSystem, withTenant } from '@genie/db';
import { ConnectionService } from '@genie/service-plugin-registry';
import { makeTestApp, makeTokens, testDbConfig, type TestApp } from './support.js';
import {
  ConnectorReconnects,
  authorizeUrlFor,
  parsePastedCallback,
} from '../src/connector-reconnect.js';

const url = process.env['TEST_DATABASE_URL'];
const identityUrl = process.env['TEST_IDENTITY_DATABASE_URL'];
const PLUGIN_ID = 'com.test.reconnect-mail';
const AUTH = 'https://accounts.google.com/o/oauth2/v2/auth?state=expected&code_challenge=x';

describe('parsePastedCallback', () => {
  it('takes only the local return address', () => {
    expect(parsePastedCallback(' http://127.0.0.1:50000/callback?code=c&state=s ')).toEqual({
      code: 'c',
      state: 's',
    });
    expect(parsePastedCallback('http://127.0.0.1:1/callback?error=access_denied&state=s')).toEqual({
      error: 'access_denied',
      state: 's',
    });
    expect(parsePastedCallback('https://evil.example/callback?code=c&state=s')).toBeNull();
    expect(parsePastedCallback('http://127.0.0.1:1/callback?code=c')).toBeNull();
    expect(parsePastedCallback('http://127.0.0.1:1/callback?code=c&error=e&state=s')).toBeNull();
    expect(parsePastedCallback('なにか')).toBeNull();
  });

  it('takes the local address when the phone dropped http:// while copying', () => {
    expect(parsePastedCallback(' 127.0.0.1:50000/callback?code=c&state=s ')).toEqual({
      code: 'c',
      state: 's',
    });
    expect(parsePastedCallback('localhost:50000/callback?code=c&state=s')).toEqual({
      code: 'c',
      state: 's',
    });
    // 抜けた形でも、ほかの場所の URL は受けない
    expect(parsePastedCallback('127.0.0.1.evil.example/callback?code=c&state=s')).toBeNull();
    expect(parsePastedCallback('evil.example/callback?code=c&state=s')).toBeNull();
    expect(parsePastedCallback('https://127.0.0.1:1/callback?code=c&state=s')).toBeNull();
  });

  it('accepts only the provider authorize page', () => {
    expect(authorizeUrlFor('google', AUTH)).not.toBeNull();
    expect(authorizeUrlFor('google', 'https://evil.example/?state=s')).toBeNull();
    expect(authorizeUrlFor('microsoft', AUTH)).toBeNull();
    expect(authorizeUrlFor('google', 'http://accounts.google.com/?state=s')).toBeNull();
  });
});

describe.skipIf(!url)('connector reconnects', () => {
  let harness: TestApp;
  let tenantId: string;
  let userId: string;
  let told: string[];
  let store: ConnectorReconnects;
  let nowAt: Date;

  const linkFrom = (reply: string | null) => /reconnect\/([\w-]+)/.exec(reply ?? '')![1]!;
  const ask = async () => linkFrom(await store.command(tenantId, userId, 'Google をつなぎ直して'));
  const asked = async () => {
    const token = await ask();
    const [item] = await store.pending(tenantId, userId);
    expect(item!.state).toBe('requested');
    expect(await store.authorize(tenantId, userId, item!.id, AUTH)).toBe(true);
    return { token, id: item!.id };
  };

  beforeAll(async () => {
    harness = await makeTestApp({
      dbConfig: testDbConfig(url!, identityUrl),
      tokens: await makeTokens(),
    });
    const issued = await harness.app.inject({
      method: 'POST',
      url: '/v1/auth/dev/token',
      payload: { email: `r-${uuidv7()}@example.com`, display_name: 'R' },
    });
    const access = issued.json<TokenResponse>().access_token;
    tenantId = (
      JSON.parse(Buffer.from(access.split('.')[1]!, 'base64url').toString()) as { tid: string }
    ).tid;
    userId = (
      await harness.app.inject({
        method: 'GET',
        url: '/v1/me',
        headers: { authorization: `Bearer ${access}` },
      })
    ).json<{ user: { id: string } }>().user.id;
    // connector_connections の FK に plugin 行が要る
    await withSystem(harness.db, async (tx) => {
      await tx
        .insertInto('plugin_publishers')
        .values({ id: 'astra', display_name: 'Genie', public_key: '', verified: true })
        .onConflict((oc) => oc.column('id').doNothing())
        .execute();
      await tx
        .insertInto('plugins')
        .values({
          id: PLUGIN_ID,
          publisher_id: 'astra',
          name: 'Reconnect mail',
          category: 'connector',
          latest_version: '0.1.0',
        })
        .onConflict((oc) => oc.column('id').doNothing())
        .execute();
      await tx
        .insertInto('plugins')
        .values({
          id: 'com.astra.google-calendar',
          publisher_id: 'astra',
          name: 'Google Calendar',
          category: 'connector',
          latest_version: '0.1.0',
        })
        .onConflict((oc) => oc.column('id').doNothing())
        .execute();
    });
  });

  afterAll(async () => {
    await harness?.close();
  });

  beforeEach(async () => {
    told = [];
    nowAt = new Date();
    await withTenant(harness.db, tenantId, (tx) =>
      tx.deleteFrom('connector_reconnects').where('user_id', '=', userId).execute(),
    );
    await withTenant(harness.db, tenantId, (tx) =>
      tx.deleteFrom('connector_connections').where('connected_by', '=', userId).execute(),
    );
    store = new ConnectorReconnects({
      db: harness.db,
      connectionsOf: (t, u, provider) =>
        new ConnectionService({ db: harness.db }).ofUser(t, u, provider),
      connectionsOfPlugin: (t, pluginId) =>
        new ConnectionService({ db: harness.db }).list(t, pluginId),
      notify: async (_t, _u, text) => {
        told.push(text);
      },
      urlFor: (token) => `https://x.test/v1/channels/reconnect/${token}`,
      now: () => nowAt,
    });
  });

  it('tells once per connection, again after a new one breaks', async () => {
    const a = 'a'.repeat(32);
    expect(await store.rejected(tenantId, userId, 'google', a)).toBe(true);
    expect(await store.rejected(tenantId, userId, 'google', a)).toBe(false);
    expect(told).toHaveLength(1);
    expect(told[0]).toContain('Google をつなぎ直して');
    expect(await store.rejected(tenantId, userId, 'google', 'b'.repeat(32))).toBe(true);
    expect(told).toHaveLength(2);
  });

  it('goes from the word to saved, without keeping the code', async () => {
    const { token, id } = await asked();
    const page = await store.status(token);
    expect(page!.authorize_url).toBe(AUTH);
    expect(await store.paste(token, 'https://evil.example/?code=c&state=expected')).toBe(
      'not_callback',
    );
    expect(await store.paste(token, 'http://127.0.0.1:5/callback?code=c&state=other')).toBe(
      'wrong_state',
    );
    expect(await store.paste(token, 'http://127.0.0.1:5/callback?code=c&state=expected')).toBe(
      'ok',
    );
    const [item] = await store.pending(tenantId, userId);
    expect(item).toMatchObject({ id, state: 'code', code: 'c', callback_state: 'expected' });
    // 認可コードは DB に無い
    const row = await withTenant(harness.db, tenantId, (tx) =>
      tx
        .selectFrom('connector_reconnects')
        .selectAll()
        .where('id', '=', id)
        .executeTakeFirstOrThrow(),
    );
    expect(JSON.stringify(row)).not.toContain('"c"');
    await store.finished(tenantId, userId, id, true, 'me@example.com');
    expect(told.at(-1)).toContain('つなぎ直しました（me@example.com）');
    expect(await store.pending(tenantId, userId)).toEqual([]);
    // 終わったリンクは使えない
    expect(await store.status(token)).toBeNull();
    expect(await store.paste(token, 'http://127.0.0.1:5/callback?code=c&state=expected')).toBe(
      'gone',
    );
  });

  it('asking again invalidates the old link', async () => {
    const first = await asked();
    await ask();
    expect(await store.status(first.token)).toBeNull();
  });

  it('does not hand out expired requests', async () => {
    await ask();
    nowAt = new Date(nowAt.getTime() + 16 * 60_000);
    expect(await store.pending(tenantId, userId)).toEqual([]);
  });

  it('refuses a non-provider authorize url', async () => {
    await ask();
    const [item] = await store.pending(tenantId, userId);
    expect(await store.authorize(tenantId, userId, item!.id, 'https://evil.example/?state=s')).toBe(
      false,
    );
  });

  const connect = (at: Date, state = 'CONNECTED') =>
    withTenant(harness.db, tenantId, (tx) =>
      tx
        .insertInto('connector_connections')
        .values({
          id: uuidv7(),
          tenant_id: tenantId,
          plugin_id: PLUGIN_ID,
          connector_id: 'gmail',
          provider: 'google',
          state,
          granted_scopes: ['mail.read'],
          credential_ref: `ref-${uuidv7()}`,
          account_label: 'me@example.com',
          connected_by: userId,
          connected_at: at,
          revoked_at: state === 'REVOKED' ? at : null,
        })
        .execute(),
    );
  const statusOf = (text = 'Gmail つながってる？') => store.command(tenantId, userId, text);
  const minutes = (n: number) => new Date(Date.now() + n * 60_000);

  it('says connected when no refusal came after the last connection', async () => {
    await connect(minutes(-60));
    const reply = await statusOf();
    expect(reply).toContain('はつながっています');
    expect(reply).toContain('me@example.com');
  });

  it('says cut when the provider refused after the last connection', async () => {
    await connect(minutes(-60));
    await store.rejected(tenantId, userId, 'google', 'a'.repeat(32));
    const reply = await statusOf();
    expect(reply).toContain('は切れています');
    expect(reply).not.toContain('はつながっています');
    expect(reply).toContain('Google をつなぎ直して');
  });

  it('says cut when an expired connection remains, or the refused one was removed', async () => {
    await connect(minutes(-60), 'EXPIRED');
    expect(await statusOf()).toContain('は切れています');
    await withTenant(harness.db, tenantId, (tx) =>
      tx.deleteFrom('connector_connections').where('connected_by', '=', userId).execute(),
    );
    await connect(minutes(-60), 'REVOKED');
    await store.rejected(tenantId, userId, 'google', 'a'.repeat(32));
    expect(await statusOf()).toContain('は切れています');
  });

  it('says not connected after the user disconnected on purpose', async () => {
    await connect(minutes(-60), 'REVOKED');
    expect(await statusOf()).toContain('まだつないでいません');
  });

  it('says connected again after reconnecting on the Mac', async () => {
    await connect(minutes(-60), 'REVOKED');
    await store.rejected(tenantId, userId, 'google', 'a'.repeat(32));
    await connect(minutes(5));
    expect(await statusOf()).toContain('はつながっています');
  });

  it('shows a reconnect in progress, and does not make a new link', async () => {
    await connect(minutes(-60));
    await store.rejected(tenantId, userId, 'google', 'a'.repeat(32));
    const { token } = await asked();
    const reply = await statusOf();
    expect(reply).toContain('つなぎ直しの途中');
    expect(reply).toContain('あと 15 分');
    expect(reply).not.toContain('reconnect/');
    // 聞いただけで、進行中のリンクを壊さない
    expect(await store.status(token)).not.toBeNull();
  });

  it('says so when never connected', async () => {
    expect(await statusOf()).toContain('まだつないでいません');
    expect(await statusOf('接続状況')).toContain('接続はまだありません');
  });

  it('understands status wordings without taking requests or other questions', async () => {
    await connect(minutes(-60));
    for (const text of [
      'Gmail つながってる？',
      'Gmailは繋がってますか',
      'gmail 切れてる？',
      'Google の接続は？',
      'Gmailの連携はどう？',
      'Gmailの接続状況',
      '接続状況',
      '連携は大丈夫？',
    ])
      expect(await statusOf(text), text).toContain('はつながっています');
    expect(await statusOf('Gmailをつないで')).toContain('のつなぎ直しです');
    for (const text of [
      'Gmail がつながらないのはなぜ？',
      'Gmail のメールを見せて',
      '今どうなってる？',
    ])
      expect(await statusOf(text), text).toBeNull();
  });

  it('ignores other words', async () => {
    expect(await store.command(tenantId, userId, 'Gmail を見せて')).toBeNull();
  });

  it('understands everyday ways of asking, but not questions', async () => {
    for (const text of [
      'Google をつなぎ直して',
      'Gmailの連携を再び繋げられるようにしてください',
      'gmail を再接続',
      'もう一度Gmailをつないで',
      'Gmailの接続を戻して',
    ])
      expect(await store.command(tenantId, userId, text), text).toContain('のつなぎ直しです');
    for (const text of [
      'Gmail がつながらないのはなぜ？',
      'Gmail につなげますか？',
      'Gmail のメールを見せて',
      '明日 Google に繋いでと言われた',
    ])
      expect(await store.command(tenantId, userId, text), text).toBeNull();
  });

  describe('permission to put events on the calendar', () => {
    const writeConnected = () =>
      withTenant(harness.db, tenantId, (tx) =>
        tx
          .insertInto('connector_connections')
          .values({
            id: uuidv7(),
            tenant_id: tenantId,
            plugin_id: 'com.astra.google-calendar',
            connector_id: 'google-calendar-actions',
            provider: 'google',
            state: 'CONNECTED',
            granted_scopes: ['https://www.googleapis.com/auth/calendar.events'],
            credential_ref: `ref-${uuidv7()}`,
            account_label: 'me@example.com',
            connected_by: userId,
            connected_at: new Date(),
          })
          .execute(),
      );

    it('asks the Mac for the write connection, not the read one, and says so when done', async () => {
      const reply = await store.command(tenantId, userId, 'カレンダーに予定を入れられるようにして');
      expect(reply).toContain('Google カレンダー（予定を入れる）の許可の手続きです');
      const token = linkFrom(reply);
      const [item] = await store.pending(tenantId, userId);
      expect(item).toMatchObject({
        provider: 'google',
        state: 'requested',
        plugin_id: 'com.astra.google-calendar',
        connector_id: 'google-calendar-actions',
      });
      expect((await store.status(token))!.label).toBe('Google カレンダー（予定を入れる）');
      await store.finished(tenantId, userId, item!.id, true, 'me@example.com');
      expect(told.at(-1)).toContain('予定を入れる）を許可しました（me@example.com）');
      // つなぎ直し（読む接続）の頼みには、接続の印を付けない
      await store.command(tenantId, userId, 'Google をつなぎ直して');
      const [plain] = await store.pending(tenantId, userId);
      expect(plain).not.toHaveProperty('connector_id');
    });

    it('adds the link to a group meeting only while the permission is missing', async () => {
      const notice = await store.calendarWriteNotice(tenantId, userId);
      expect(notice).toContain('予定を入れる許可が要ります');
      expect(notice).toMatch(/reconnect\/[\w-]+/);
      await writeConnected();
      expect(await store.calendarWritable(tenantId)).toBe(true);
      expect(await store.calendarWriteNotice(tenantId, userId)).toBeNull();
      expect(await store.command(tenantId, userId, 'カレンダーの書き込みを許可して')).toContain(
        'もう許可されています',
      );
    });

    it('understands the wordings, but not questions', async () => {
      for (const text of [
        'カレンダーに予定を入れられるようにして',
        'Googleカレンダーに書き込めるようにして',
        'カレンダーの書き込みを許可して',
      ])
        expect(await store.command(tenantId, userId, text), text).toContain('許可の手続きです');
      for (const text of [
        'カレンダーに予定を入れられるようにしてくれないの？',
        'カレンダーに予定を入れて',
      ])
        expect(String(await store.command(tenantId, userId, text)), text).not.toContain(
          '許可の手続き',
        );
    });
  });
});
