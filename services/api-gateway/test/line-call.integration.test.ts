/**
 * LINE から Genie と声で話す（通話のページ）。LINE の API と Gemini Live は代役。
 *
 * 見ること:
 *   - 「電話して」で 10 分・1 回だけのリンクが返る。ページはリンクが生きている間だけ開ける
 *   - ページの音声を Gemini Live（代役）へ中継し、Gemini の声・文字起こしをページへ返す
 *   - キーはヘッダーで送る（URL に載せない）。setup に delegate_task がある
 *   - 通話の中の頼みは、LINE の会話と同じ conversation で Genie に渡り、答えが Gemini へ返る
 *   - 同じリンクで二度はつながらない。通話の長さを記録する（月の上限のため）
 *   ./infra/db/with-test-db.sh pnpm --filter @genie/service-api-gateway test
 */
import { createHmac } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import WebSocket, { WebSocketServer } from 'ws';
import { type TokenResponse, uuidv7 } from '@genie/contracts';
import { withTenant } from '@genie/db';
import { makeTestApp, makeTokens, testDbConfig, type TestApp } from './support.js';
import type { App } from '../src/fastify.js';

const url = process.env['TEST_DATABASE_URL'];
const identityUrl = process.env['TEST_IDENTITY_DATABASE_URL'];
const LINE_SECRET = 'line-call-secret';

describe.skipIf(!url)('talking to Genie from LINE (call page)', () => {
  let harness: TestApp;
  let app: App;
  let tenantId: string;
  let gemini: WebSocketServer;
  const geminiSaw: { key: string | undefined; messages: Record<string, unknown>[] } = {
    key: undefined,
    messages: [],
  };
  const sent: { url: string; body: Record<string, unknown> }[] = [];
  const fetchImpl = vi.fn(async (target: string, init?: RequestInit) => {
    sent.push({
      url: target,
      body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
    });
    return Response.json({});
  });
  const texts = (since: number) =>
    sent
      .slice(since)
      .filter((s) => !s.url.endsWith('/chat/loading/start'))
      .map((s) => String((s.body['messages'] as { text?: string }[] | undefined)?.[0]?.text ?? ''));
  const waitFor = async (check: () => boolean, label: string) => {
    for (let i = 0; i < 500; i += 1) {
      if (check()) return;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error(`timed out: ${label}`);
  };
  let serial = 0;
  const line = async (text: string) => {
    const raw = JSON.stringify({
      destination: 'Ubot-call',
      events: [
        {
          type: 'message',
          mode: 'active',
          timestamp: Date.now(),
          webhookEventId: `01CALL${String(++serial).padStart(4, '0')}`,
          replyToken: `reply-call-${String(serial)}`,
          source: { type: 'user', userId: 'Ucaller' },
          message: { type: 'text', id: String(6_000_000 + serial), text },
        },
      ],
    });
    const before = sent.length;
    await app.inject({
      method: 'POST',
      url: '/v1/channels/line/webhook',
      headers: {
        'content-type': 'application/json',
        'x-line-signature': createHmac('sha256', LINE_SECRET).update(raw).digest('base64'),
      },
      payload: raw,
    });
    await waitFor(() => texts(before).length > 0, text);
    return texts(before)[0]!;
  };

  beforeAll(async () => {
    // Gemini Live の代役: setup を受けたら setupComplete。音声が来たら声と文字起こし、続けて delegate_task を呼ぶ
    gemini = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    gemini.on('connection', (socket: WebSocket, request) => {
      geminiSaw.key = request.headers['x-goog-api-key'] as string | undefined;
      let spoke = false;
      socket.on('message', (data) => {
        const message = JSON.parse(String(data)) as Record<string, unknown>;
        geminiSaw.messages.push(message);
        if (message['setup']) socket.send(JSON.stringify({ setupComplete: {} }));
        if (message['realtimeInput'] && !spoke) {
          spoke = true;
          socket.send(
            JSON.stringify({
              serverContent: {
                inputTranscription: { text: '明日の予定を確認して' },
                outputTranscription: { text: '確認しますね。' },
                modelTurn: {
                  parts: [
                    {
                      inlineData: {
                        mimeType: 'audio/pcm;rate=24000',
                        data: Buffer.from([1, 0, 2, 0]).toString('base64'),
                      },
                    },
                  ],
                },
              },
            }),
          );
          socket.send(
            JSON.stringify({
              toolCall: {
                functionCalls: [
                  { id: 'c1', name: 'delegate_task', args: { request: '明日の予定を確認して' } },
                ],
              },
            }),
          );
        }
      });
    });
    await new Promise((r) => gemini.once('listening', r));
    const port = (gemini.address() as AddressInfo).port;

    harness = await makeTestApp({
      dbConfig: testDbConfig(url!, identityUrl),
      tokens: await makeTokens(),
      // 家族の通話の頼み（共有スペース）を扱うため。写真は読まない
      understand: [],
      channels: {
        env: {
          LINE_CHANNEL_SECRET: LINE_SECRET,
          LINE_CHANNEL_ACCESS_TOKEN: 'line-token',
          GENIE_CALL_GEMINI_API_KEY: 'gemini-test-key',
          GENIE_CALL_MONTHLY_MINUTES: '30',
          GENIE_PUBLIC_URL: 'https://genie.example.trycloudflare.com',
        },
        fetchImpl: fetchImpl as unknown as typeof fetch,
        callEndpoint: `ws://127.0.0.1:${String(port)}/live`,
      },
    });
    app = harness.app;
    await app.listen({ port: 0, host: '127.0.0.1' });
    base = `ws://127.0.0.1:${String((app.server.address() as AddressInfo).port)}`;
    const issued = await app.inject({
      method: 'POST',
      url: '/v1/auth/dev/token',
      payload: { email: `call-${uuidv7()}@example.com`, display_name: 'Caller' },
    });
    const access = issued.json<TokenResponse>().access_token;
    tenantId = (
      JSON.parse(Buffer.from(access.split('.')[1]!, 'base64url').toString()) as { tid: string }
    ).tid;
    const code = await app.inject({
      method: 'POST',
      url: '/v1/channels/link-codes',
      headers: { authorization: `Bearer ${access}` },
      payload: { provider: 'line' },
    });
    expect(await line(code.json<{ message: string }>().message)).toContain('連携しました');
  });

  afterAll(async () => {
    await harness?.close();
    gemini?.close();
  });

  let token = '';
  let base = '';
  const open = (path: string) => new WebSocket(`${base}${path}`);

  it('answers 「電話して」 with a one-time link that opens the call page', async () => {
    const before = sent.length;
    await line('電話して');
    // URL は文に出さず、「通話を開始」のボタン（開くだけ）にする
    const reply = sent.slice(before).find((s) => !s.url.endsWith('/chat/loading/start'))!;
    const message = (
      reply.body['messages'] as {
        template?: { text: string; actions: { type: string; label: string; uri: string }[] };
      }[]
    )[0]!;
    expect(message.template!.text).toContain('いつでも話せます');
    expect(message.template!.actions[0]).toMatchObject({ type: 'uri', label: '通話を開始' });
    const link =
      /^https:\/\/genie\.example\.trycloudflare\.com\/v1\/channels\/call\/([A-Za-z0-9_-]{32})\?openExternalBrowser=1$/.exec(
        message.template!.actions[0]!.uri,
      );
    expect(link).not.toBeNull();
    token = link![1]!;
    const page = await app.inject({ method: 'GET', url: `/v1/channels/call/${token}` });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('Genie と話す');
    expect(page.headers['cache-control']).toBe('no-store');
    const wrong = await app.inject({ method: 'GET', url: `/v1/channels/call/${'x'.repeat(32)}` });
    expect(wrong.statusCode).toBe(410);
  });

  it('relays the voice to Gemini Live, and hands requests to Genie', async () => {
    const client = open(`/v1/channels/call/${token}/ws`);
    const events: Record<string, unknown>[] = [];
    const audio: Buffer[] = [];
    client.on('message', (data: Buffer, binary: boolean) => {
      if (binary) audio.push(data);
      else events.push(JSON.parse(String(data)) as Record<string, unknown>);
    });
    await waitFor(() => events.some((e) => e['type'] === 'ready'), 'ready');
    client.send(Buffer.alloc(3200));
    await waitFor(() => events.some((e) => e['type'] === 'delegated'), 'delegated');
    await waitFor(
      () => geminiSaw.messages.some((m) => m['toolResponse'] !== undefined),
      'tool response',
    );

    expect(geminiSaw.key).toBe('gemini-test-key');
    const setup = geminiSaw.messages[0]!['setup'] as { model: string; tools: unknown[] };
    expect(setup.model).toBe('models/gemini-3.8-live');
    expect(JSON.stringify(setup.tools)).toContain('delegate_task');
    expect(geminiSaw.messages.some((m) => JSON.stringify(m).includes('audio/pcm;rate=16000'))).toBe(
      true,
    );
    expect(audio[0]).toEqual(Buffer.from([1, 0, 2, 0]));
    expect(events).toContainEqual({
      type: 'transcript',
      role: 'user',
      text: '明日の予定を確認して',
    });
    expect(events).toContainEqual({ type: 'transcript', role: 'genie', text: '確認しますね。' });

    // 試験の環境には担当のエージェントが居ないので、Genie はそう答え、その答えが Gemini へ返る
    const response = geminiSaw.messages.find((m) => m['toolResponse'])!['toolResponse'] as {
      functionResponses: { id: string; response: { status: string; result?: string } }[];
    };
    expect(response.functionResponses[0]).toMatchObject({
      id: 'c1',
      response: { status: 'answered', result: expect.stringContaining('General Assistant') },
    });
    // 頼みは LINE の会話と同じ conversation に入った
    const turns = await withTenant(harness.db, tenantId, (tx) =>
      tx
        .selectFrom('turns')
        .innerJoin('channel_threads', 'channel_threads.conversation_id', 'turns.conversation_id')
        .select('turns.role')
        .where('turns.modality', '=', 'voice')
        .execute(),
    );
    expect(turns.length).toBeGreaterThan(0);

    // 電波が切れても、45 秒以内なら同じ通話に戻れる（Gemini はつないだまま）
    const resume = String(events.find((e) => e['type'] === 'ready')!['resume']);
    const geminiBefore = geminiSaw.messages.length;
    client.terminate();
    await new Promise((r) => setTimeout(r, 100));
    const back = open(`/v1/channels/call/${token}/ws?resume=${resume}`);
    const backEvents: Record<string, unknown>[] = [];
    back.on('message', (data: Buffer, binary: boolean) => {
      if (!binary) backEvents.push(JSON.parse(String(data)) as Record<string, unknown>);
    });
    await waitFor(
      () => backEvents.some((e) => e['type'] === 'ready' && e['resumed'] === true),
      'resumed',
    );
    // 鍵が違えば戻れない
    const stranger = open(`/v1/channels/call/${token}/ws?resume=wrong`);
    const strangerEvents: Record<string, unknown>[] = [];
    stranger.on('message', (data: Buffer) =>
      strangerEvents.push(JSON.parse(String(data)) as Record<string, unknown>),
    );
    await waitFor(() => strangerEvents.some((e) => e['type'] === 'ended'), 'stranger refused');
    // カメラ: ページが送った JPEG は realtimeInput.video として Gemini へ
    back.send(JSON.stringify({ type: 'frame', data: Buffer.from('jpeg').toString('base64') }));
    await waitFor(
      () =>
        geminiSaw.messages
          .slice(geminiBefore)
          .some((m) => JSON.stringify(m).includes('image/jpeg')),
      'frame relayed',
    );
    const before = sent.length;
    back.send(JSON.stringify({ type: 'hangup' }));
    // 電話を切ったら、簡単な議事録を LINE に残す
    await waitFor(() => texts(before).some((t) => t.startsWith('📞 通話の議事録')), 'minutes');
    expect(texts(before).find((t) => t.startsWith('📞'))).toContain('明日の予定を確認して');
    const client2 = back;
    await waitFor(() => client2.readyState === WebSocket.CLOSED, 'closed');
    await new Promise((r) => setTimeout(r, 200));
    const sessions = await withTenant(harness.db, tenantId, (tx) =>
      tx.selectFrom('call_sessions').select(['started_at', 'ended_at', 'end_reason']).execute(),
    );
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({ end_reason: 'user_hangup' });
    expect(sessions[0]!.ended_at).not.toBeNull();
  });

  it('refuses a link that was already used', async () => {
    const client = open(`/v1/channels/call/${token}/ws`);
    const events: Record<string, unknown>[] = [];
    client.on('message', (data: Buffer, binary: boolean) => {
      if (!binary) events.push(JSON.parse(String(data)) as Record<string, unknown>);
    });
    await waitFor(() => events.some((e) => e['type'] === 'ended'), 'refused');
    expect(String(events[0]!['reason'])).toContain('このリンクは使えません');
    const page = await app.inject({ method: 'GET', url: `/v1/channels/call/${token}` });
    expect(page.statusCode).toBe(410);
  });

  it('calls the user from Genie for a 「電話で起こして」 reminder, and speaks the reminder first', async () => {
    const thread = await withTenant(harness.db, tenantId, (tx) =>
      tx.selectFrom('channel_threads').select('conversation_id').executeTakeFirstOrThrow(),
    );
    const before = sent.length;
    expect(
      await harness.channels!.service.ring(tenantId, thread.conversation_id, '会議の時間です'),
    ).toBe('delivered');
    const message = (
      sent.slice(before).find((s) => !s.url.endsWith('/chat/loading/start'))!.body['messages'] as {
        template: { text: string; actions: { label: string; uri: string }[] };
      }[]
    )[0]!;
    expect(message.template.text).toContain('Genie から電話です: 会議の時間です');
    expect(message.template.actions[0]!.label).toBe('電話に出る');
    const ringToken = /call\/([A-Za-z0-9_-]{32})\?/.exec(message.template.actions[0]!.uri)![1]!;
    const seen = geminiSaw.messages.length;
    const client = open(`/v1/channels/call/${ringToken}/ws`);
    await waitFor(
      () =>
        geminiSaw.messages
          .slice(seen)
          .some((m) =>
            JSON.stringify(m).includes('次の用件を短く丁寧に伝えてください: 会議の時間です'),
          ),
      'opening spoken',
    );
    client.send(JSON.stringify({ type: 'hangup' }));
  });

  it('lets the family talk with Genie together, limited to the shared space, and sums up to the group', async () => {
    const GROUP = 'Cfamilycall';
    const mention = (text: string) => ({
      type: 'text',
      id: String(6_500_000 + serial),
      text: `@Genie ${text}`,
      mention: { mentionees: [{ index: 0, length: 6, type: 'user', isSelf: true }] },
    });
    const inGroup = async (userId: string, text: string) => {
      const raw = JSON.stringify({
        destination: 'Ubot-call',
        events: [
          {
            type: 'message',
            mode: 'active',
            timestamp: Date.now(),
            webhookEventId: `01CALLG${String(++serial).padStart(4, '0')}`,
            replyToken: `rt-g-${String(serial)}`,
            source: { type: 'group', groupId: GROUP, userId },
            message: mention(text),
          },
        ],
      });
      const before = sent.length;
      await app.inject({
        method: 'POST',
        url: '/v1/channels/line/webhook',
        headers: {
          'content-type': 'application/json',
          'x-line-signature': createHmac('sha256', LINE_SECRET).update(raw).digest('base64'),
        },
        payload: raw,
      });
      await waitFor(() => sent.length > before, text);
      return sent.slice(before).find((s) => !s.url.endsWith('/chat/loading/start'))!;
    };
    await inGroup('Ucaller', 'このグループで使う');
    const invite = await inGroup('Ufamily', 'みんなで話そう');
    const template = (
      invite.body['messages'] as {
        template: { text: string; actions: { label: string; uri: string }[] };
      }[]
    )[0]!.template;
    expect(template.actions[0]!.label).toBe('通話に参加');
    const groupToken = /call\/([A-Za-z0-9_-]{32})\?/.exec(template.actions[0]!.uri)![1]!;

    const seen = geminiSaw.messages.length;
    const mama = open(`/v1/channels/call/${groupToken}/ws`);
    const mamaEvents: Record<string, unknown>[] = [];
    mama.on('message', (d: Buffer, binary: boolean) => {
      if (!binary) mamaEvents.push(JSON.parse(String(d)) as Record<string, unknown>);
    });
    await waitFor(() => mamaEvents.some((e) => e['type'] === 'ready'), 'mama ready');
    const papa = open(`/v1/channels/call/${groupToken}/ws`);
    const papaEvents: Record<string, unknown>[] = [];
    papa.on('message', (d: Buffer, binary: boolean) => {
      if (!binary) papaEvents.push(JSON.parse(String(d)) as Record<string, unknown>);
    });
    await waitFor(() => papaEvents.some((e) => e['type'] === 'ready'), 'papa joined');
    await waitFor(
      () => mamaEvents.some((e) => e['type'] === 'participants' && e['count'] === 2),
      'two people',
    );
    expect(
      geminiSaw.messages
        .slice(seen)
        .some((m) => JSON.stringify(m).includes('家族のグループの通話です')),
    ).toBe(true);

    // 2 人の声は 1 本に足して送る。頼み（代役の Gemini が呼ぶ）は共有スペースだけで扱い、持ち主の仕事にしない
    mama.send(Buffer.alloc(3200, 1));
    papa.send(Buffer.alloc(3200, 1));
    await waitFor(
      () => geminiSaw.messages.slice(seen).some((m) => m['toolResponse'] !== undefined),
      'family request answered',
    );
    const tasks = await withTenant(harness.db, tenantId, (tx) =>
      tx.selectFrom('tasks').select('id').where('title', '=', '明日の予定を確認して').execute(),
    );
    const before = tasks.length;
    const response = JSON.stringify(geminiSaw.messages.slice(seen).find((m) => m['toolResponse']));
    expect(response).toContain('このグループでは分かりませんでした');

    // 1 人が抜けても通話は続く。最後の 1 人が切ったら、まとめはグループへ
    papa.send(JSON.stringify({ type: 'hangup' }));
    await waitFor(
      () => mamaEvents.some((e) => e['type'] === 'participants' && e['count'] === 1),
      'papa left',
    );
    const sentBefore = sent.length;
    mama.send(JSON.stringify({ type: 'hangup' }));
    await waitFor(
      () =>
        sent
          .slice(sentBefore)
          .some((s) => s.body['to'] === GROUP && JSON.stringify(s.body).includes('通話の議事録')),
      'summary to group',
    );
    const after = await withTenant(harness.db, tenantId, (tx) =>
      tx.selectFrom('tasks').select('id').where('title', '=', '明日の予定を確認して').execute(),
    );
    expect(after.length).toBe(before);
  });
});
