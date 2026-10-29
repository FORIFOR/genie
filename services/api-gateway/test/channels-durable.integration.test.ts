/**
 * チャットの受信を「保存してから受け取ったと返す」経路（GENIE_SECRET_KEY あり）と、Slack の Socket Mode。
 * Slack / LINE の API と WebSocket は代役。
 *
 * 見ること:
 *   - Socket Mode は公開 URL なしで受け、**保存してから** ack する
 *   - 受信箱の本文は封じてあり、処理が終わったら消える
 *   - 処理する前に落ちたものは、次の見回りで仕事になる（取りこぼさない）
 *   - handleTurn の途中で落ちたものは、やり直さずに本人へ伝える（仕事を二つにしない）
 *   - Slack の message と app_mention（同じ発言）は 1 つの仕事
 *   - 送信が 429 なら、Retry-After まで送り直さない
 *   ./infra/db/with-test-db.sh pnpm --filter @genie/service-api-gateway test
 */
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { type TokenResponse, uuidv7 } from '@genie/contracts';
import { withIdentity, withTenant } from '@genie/db';
import { secretBox } from '@genie/service-phone';
import type { SocketLike } from '@genie/service-channels';
import { sql } from 'kysely';
import { makeTestApp, makeTokens, testDbConfig, type TestApp } from './support.js';
import type { App } from '../src/fastify.js';

const url = process.env['TEST_DATABASE_URL'];
const identityUrl = process.env['TEST_IDENTITY_DATABASE_URL'];
const SECRET_KEY = randomBytes(32).toString('hex');

type Sent = { url: string; body: Record<string, unknown> };

class FakeSocket implements SocketLike {
  sent: string[] = [];
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: unknown) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.onclose?.({});
  }
  frame(body: unknown) {
    this.onmessage?.({ data: JSON.stringify(body) });
  }
}

describe.skipIf(!url)('chat channels (durable inbox, Socket Mode)', () => {
  let harness: TestApp;
  let app: App;
  let auth: { authorization: string };
  let tenantId: string;
  const sent: Sent[] = [];
  const sockets: FakeSocket[] = [];
  let postStatus: () => Response | null = () => null;
  const fetchImpl = vi.fn(async (target: string, init?: RequestInit) => {
    if (target.endsWith('apps.connections.open'))
      return Response.json({ ok: true, url: 'wss://wss-primary.slack.com/link' });
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    if (target.endsWith('chat.postMessage')) {
      const override = postStatus();
      if (override) return override;
    }
    sent.push({ url: target, body });
    if (target.endsWith('conversations.open'))
      return Response.json({ ok: true, channel: { id: 'D-mention' } });
    if (target.startsWith('https://slack.com'))
      return Response.json({ ok: true, ts: `${sent.length}.0` });
    return Response.json({});
  });

  const texts = (since = 0) => sent.slice(since).map((s) => String(s.body['text'] ?? ''));

  const waitFor = async (check: () => boolean | Promise<boolean>, label: string) => {
    for (let i = 0; i < 500; i += 1) {
      if (await check()) return;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error(`timed out: ${label}`);
  };

  const socket = () => sockets[sockets.length - 1]!;
  let envelope = 0;
  /** Socket Mode で 1 件届ける。ack の envelope_id を返す。 */
  const deliver = (payload: unknown, type = 'events_api') => {
    const id = `env-${++envelope}`;
    socket().frame({ type, envelope_id: id, payload });
    return id;
  };
  const acked = (id: string) => socket().sent.includes(JSON.stringify({ envelope_id: id }));

  const dmEvent = (text: string, eventId: string, ts: string) => ({
    type: 'event_callback',
    team_id: 'T2',
    event_id: eventId,
    event_time: Math.floor(Date.now() / 1000),
    event: { type: 'message', channel_type: 'im', user: 'U9', channel: 'D-U9', ts, text },
  });

  const inboxRow = (eventId: string) =>
    withIdentity(harness.db, (tx) =>
      tx
        .selectFrom('channel_inbox')
        .select(['status', 'payload', 'attempts', 'last_error'])
        .where('provider', '=', 'slack')
        .where('event_id', '=', eventId)
        .executeTakeFirst(),
    );

  const tasks = async () =>
    (
      await app.inject({ method: 'GET', url: '/v1/tasks', headers: auth })
    ).json<{ items: { id: string; kind: string }[] }>().items;

  beforeAll(async () => {
    const tokens = await makeTokens();
    harness = await makeTestApp({
      dbConfig: testDbConfig(url!, identityUrl),
      tokens,
      schedules: {},
      channels: {
        env: {
          SLACK_BOT_TOKEN: 'xoxb-test',
          SLACK_APP_TOKEN: 'xapp-test',
          GENIE_SECRET_KEY: SECRET_KEY,
        },
        fetchImpl: fetchImpl as unknown as typeof fetch,
        connectSocket: () => {
          const s = new FakeSocket();
          sockets.push(s);
          return s;
        },
      },
    });
    app = harness.app;
    const issued = await app.inject({
      method: 'POST',
      url: '/v1/auth/dev/token',
      payload: { email: `d-${uuidv7()}@example.com`, display_name: 'D' },
    });
    const access = issued.json<TokenResponse>().access_token;
    auth = { authorization: `Bearer ${access}` };
    tenantId = (
      JSON.parse(Buffer.from(access.split('.')[1]!, 'base64url').toString()) as { tid: string }
    ).tid;
    harness.channels!.socket!.start();
    await waitFor(() => sockets.length > 0, 'socket opened');
    socket().frame({ type: 'hello', num_connections: 1 });
  });

  afterAll(async () => {
    harness?.channels?.stop();
    await harness?.close();
  });

  it('reports how chat is connected, without secrets', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/channels/status', headers: auth });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      slack: { configured: true, transport: 'socket', socket: { state: 'open', connections: 1 } },
      line: { configured: false },
      durableInbox: true,
    });
    expect(JSON.stringify(res.json())).not.toContain('xapp-test');
    // HTTP の受け口は開いていない（署名の鍵が無い）
    const http = await app.inject({
      method: 'POST',
      url: '/v1/channels/slack/events',
      headers: { 'content-type': 'application/json' },
      payload: '{}',
    });
    expect(http.statusCode).not.toBe(200);
  });

  it('links over Socket Mode, acks after saving, and keeps no message text once handled', async () => {
    const code = await app.inject({
      method: 'POST',
      url: '/v1/channels/link-codes',
      headers: auth,
      payload: { provider: 'slack' },
    });
    const { message } = code.json<{ message: string }>();
    let before = sent.length;
    const id = deliver(dmEvent(message, 'Ev-link', '1760000001.000100'));
    await waitFor(() => acked(id), 'acked');
    await waitFor(() => sent.length > before, 'linked');
    expect(texts(before)[0]).toContain('連携しました');

    before = sent.length;
    deliver(dmEvent('競合を調べて', 'Ev-work', '1760000002.000100'));
    await waitFor(() => sent.length > before, 'accepted');
    expect(texts(before)[0]).toContain('承知しました');
    await waitFor(async () => (await inboxRow('Ev-work'))?.status === 'done', 'done');
    expect(await inboxRow('Ev-work')).toMatchObject({ status: 'done', payload: null });
    expect((await tasks()).map((t) => t.kind)).toEqual(['research']);
  });

  it('turns the message and its app_mention twin into one task', async () => {
    const before = sent.length;
    const ts = '1760000003.000100';
    deliver(dmEvent('市場を調べて', 'Ev-twin-a', ts));
    deliver({
      type: 'event_callback',
      team_id: 'T2',
      event_id: 'Ev-twin-b',
      event_time: Math.floor(Date.now() / 1000),
      event: { type: 'app_mention', user: 'U9', channel: 'D-U9', ts, text: '<@UBOT> 市場を調べて' },
    });
    await waitFor(() => sent.length > before, 'accepted');
    await new Promise((r) => setTimeout(r, 200));
    expect(texts(before).filter((t) => t.includes('承知しました'))).toHaveLength(1);
    expect(await tasks()).toHaveLength(2);
  });

  it('picks up a message saved before the process went down', async () => {
    const box = secretBox(SECRET_KEY);
    const store = harness.channels!.routes.store;
    const message = dmEvent('価格を調べて', 'Ev-crash', '1760000004.000100');
    const inbound = {
      kind: 'message',
      message: {
        provider: 'slack',
        eventId: 'Ev-crash',
        workspaceId: 'T2',
        subject: 'U9',
        destination: 'D-U9',
        threadKey: message.event.ts,
        text: message.event.text,
        sentAt: Date.now(),
        replyToken: null,
        dedupeKey: `T2:D-U9:${message.event.ts}`,
      },
    };
    // 保存したところで落ちた（処理は始まっていない）
    await store.enqueueInbound({
      provider: 'slack',
      eventId: 'Ev-crash',
      kind: 'message',
      lane: 'slack:T2:U9',
      payload: box.seal(JSON.stringify(inbound), 'genie-channel-inbox:slack:Ev-crash'),
    });
    const saved = await inboxRow('Ev-crash');
    expect(saved?.status).toBe('pending');
    expect(saved?.payload).not.toContain('価格');

    const before = sent.length;
    await harness.channels!.service.drain();
    expect(texts(before)[0]).toContain('承知しました');
    expect(await inboxRow('Ev-crash')).toMatchObject({ status: 'done', payload: null });
    expect(await tasks()).toHaveLength(3);
  });

  it('does not redo a message that stopped inside handleTurn, and tells the person', async () => {
    const box = secretBox(SECRET_KEY);
    const store = harness.channels!.routes.store;
    const inbound = {
      kind: 'message',
      message: {
        provider: 'slack',
        eventId: 'Ev-mid',
        workspaceId: 'T2',
        subject: 'U9',
        destination: 'D-U9',
        threadKey: '1760000005.000100',
        text: '請求書を送って',
        sentAt: Date.now(),
        replyToken: null,
      },
    };
    await store.enqueueInbound({
      provider: 'slack',
      eventId: 'Ev-mid',
      kind: 'message',
      lane: 'slack:T2:U9',
      payload: box.seal(JSON.stringify(inbound), 'genie-channel-inbox:slack:Ev-mid'),
    });
    // handleTurn の途中で落ちて、そのまま時間が過ぎた
    await withIdentity(harness.db, (tx) =>
      tx
        .updateTable('channel_inbox')
        .set({ status: 'turning', claimed_at: sql`now() - interval '10 minutes'` })
        .where('event_id', '=', 'Ev-mid')
        .execute(),
    );
    const before = sent.length;
    const taskCount = (await tasks()).length;
    await harness.channels!.service.drain();
    expect(texts(before)).toEqual([expect.stringContaining('途中で Genie が止まりました')]);
    expect(await inboxRow('Ev-mid')).toMatchObject({
      status: 'dead',
      payload: null,
      last_error: 'interrupted',
    });
    expect(await tasks()).toHaveLength(taskCount);
  });

  it('waits for Retry-After before sending again after a 429', async () => {
    let refused = 0;
    postStatus = () => {
      if (refused > 0) return null;
      refused += 1;
      return new Response('{}', { status: 429, headers: { 'retry-after': '120' } });
    };
    deliver(dmEvent('天気を調べて', 'Ev-429', '1760000006.000100'));
    await waitFor(async () => (await inboxRow('Ev-429'))?.status === 'done', 'handled');
    postStatus = () => null;
    expect(refused).toBe(1);
    // 同じ DB を使う他のテストの見回りも送りうるので、送ったかは outbox の行で確かめる
    const outbox = () =>
      withTenant(harness.db, tenantId, (tx) =>
        tx
          .selectFrom('channel_outbox')
          .select(['status', 'attempts', 'last_error'])
          .select(sql<number>`extract(epoch from next_attempt_at - now())`.as('wait_s'))
          .where('kind', '=', 'accepted')
          .where('destination', '=', 'D-U9')
          .orderBy('created_at', 'desc')
          .limit(1)
          .executeTakeFirstOrThrow(),
      );
    // 受付の返事は 429 で断られた。2 分は送り直さない
    await harness.channels!.service.pump(tenantId);
    const waiting = await outbox();
    expect(waiting).toMatchObject({ status: 'PENDING', attempts: 1, last_error: 'slack_http_429' });
    expect(Number(waiting.wait_s)).toBeGreaterThan(100);
    // 待ち時間を過ぎたことにすると、1 回で届く
    await withTenant(harness.db, tenantId, (tx) =>
      tx
        .updateTable('channel_outbox')
        .set({ next_attempt_at: sql`now() - interval '1 second'` })
        .where('status', '=', 'PENDING')
        .execute(),
    );
    await harness.channels!.service.pump(tenantId);
    await harness.channels!.service.pump(tenantId);
    expect(await outbox()).toMatchObject({ status: 'SENT', attempts: 2 });
  });

  it('confirms a reminder asked in Slack and sends it back to the same thread', async () => {
    let before = sent.length;
    deliver(dmEvent('30分後に休憩するよう教えて', 'Ev-remind', '1760000007.000100'));
    await waitFor(() => sent.length > before, 'proposal');
    expect(texts(before)[0]).toContain('よろしいですか');
    before = sent.length;
    // 同じスレッドで「はい」
    deliver({
      ...dmEvent('はい', 'Ev-remind-yes', '1760000007.000200'),
      event: {
        type: 'message',
        channel_type: 'im',
        user: 'U9',
        channel: 'D-U9',
        ts: '1760000007.000200',
        thread_ts: '1760000007.000100',
        text: 'はい',
      },
    });
    await waitFor(() => sent.length > before, 'confirmed');
    expect(texts(before)[0]).toContain('予約しました');

    const jobs = (
      await app.inject({ method: 'GET', url: '/v1/schedules', headers: auth })
    ).json<{ items: { id: string }[] }>().items;
    expect(jobs).toHaveLength(1);
    await withTenant(harness.db, tenantId, (tx) =>
      tx
        .updateTable('scheduled_jobs')
        .set({ next_run_at: sql`now() - interval '1 second'` })
        .where('id', '=', jobs[0]!.id)
        .execute(),
    );
    before = sent.length;
    expect(await harness.schedules!.tick()).toBe(1);
    expect(sent.slice(before)).toEqual([
      expect.objectContaining({
        url: 'https://slack.com/api/chat.postMessage',
        body: expect.objectContaining({
          channel: 'D-U9',
          thread_ts: '1760000007.000100',
          text: expect.stringContaining('⏰ 休憩するよう'),
        }),
      }),
    ]);
    // チャットへ返したので、Mac へのお知らせには残さない
    const notices = await app.inject({ method: 'GET', url: '/v1/notices', headers: auth });
    expect(notices.json<{ items: unknown[] }>().items).toEqual([]);
  });
});
