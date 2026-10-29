/**
 * LINE の公式アカウントの管理画面で受けた電話を、Genie の声（通話の WebSocket → Gemini Live）につなぐ道
 * （tools/line-call-bridge が呼ぶ POST /v1/channels/line-oa-call）。
 * 合言葉は受けた本文を封じる鍵から作るので、この試験だけ GENIE_SECRET_KEY を置く。
 */
import { createHmac } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import WebSocket, { WebSocketServer } from 'ws';
import { type TokenResponse, uuidv7 } from '@genie/contracts';
import { lineCallBridgeKey } from '../src/channels.js';
import { makeTestApp, makeTokens, testDbConfig, type TestApp } from './support.js';
import type { App } from '../src/fastify.js';

const url = process.env['TEST_DATABASE_URL'];
const identityUrl = process.env['TEST_IDENTITY_DATABASE_URL'];
const LINE_SECRET = 'line-oa-call-secret';
const SEAL_KEY = 'ab'.repeat(32);
// ほかの試験と同じ DB を使うので、かけてくる人の LINE の ID はこの試験だけのものにする
const CALLER = `Uoa${uuidv7().replace(/-/g, '').slice(0, 24)}`;

describe.skipIf(!url)('LINE calls answered in the Official Account Manager', () => {
  let harness: TestApp;
  let app: App;
  let gemini: WebSocketServer;
  let base = '';
  const geminiSaw: Record<string, unknown>[] = [];
  const sent: { url: string; body: Record<string, unknown> }[] = [];
  const fetchImpl = vi.fn(async (target: string, init?: RequestInit) => {
    sent.push({
      url: target,
      body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
    });
    return Response.json({});
  });
  const waitFor = async (check: () => boolean, label: string) => {
    for (let i = 0; i < 500; i += 1) {
      if (check()) return;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error(`timed out: ${label}`);
  };
  const open = (path: string) => new WebSocket(`${base}${path}`);

  beforeAll(async () => {
    gemini = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    gemini.on('connection', (socket: WebSocket) => {
      socket.on('message', (data) => {
        const message = JSON.parse(String(data)) as Record<string, unknown>;
        geminiSaw.push(message);
        if (message['setup']) socket.send(JSON.stringify({ setupComplete: {} }));
      });
    });
    await new Promise((r) => gemini.once('listening', r));
    harness = await makeTestApp({
      dbConfig: testDbConfig(url!, identityUrl),
      tokens: await makeTokens(),
      channels: {
        env: {
          LINE_CHANNEL_SECRET: LINE_SECRET,
          LINE_CHANNEL_ACCESS_TOKEN: 'line-token',
          GENIE_CALL_GEMINI_API_KEY: 'gemini-test-key',
          GENIE_CALL_MONTHLY_MINUTES: '30',
          GENIE_SECRET_KEY: SEAL_KEY,
        },
        fetchImpl: fetchImpl as unknown as typeof fetch,
        callEndpoint: `ws://127.0.0.1:${String((gemini.address() as AddressInfo).port)}/live`,
      },
    });
    app = harness.app;
    await app.listen({ port: 0, host: '127.0.0.1' });
    base = `ws://127.0.0.1:${String((app.server.address() as AddressInfo).port)}`;
    const issued = await app.inject({
      method: 'POST',
      url: '/v1/auth/dev/token',
      payload: { email: `oa-call-${uuidv7()}@example.com`, display_name: 'Caller' },
    });
    const access = issued.json<TokenResponse>().access_token;
    const code = await app.inject({
      method: 'POST',
      url: '/v1/channels/link-codes',
      headers: { authorization: `Bearer ${access}` },
      payload: { provider: 'line' },
    });
    // LINE から「連携 XXXXXXXX」が届く（受けた本文は封じて保存してから処理する）
    const raw = JSON.stringify({
      destination: 'Ubot-oa',
      events: [
        {
          type: 'message',
          mode: 'active',
          timestamp: Date.now(),
          webhookEventId: '01OACALL0001',
          replyToken: 'reply-oa-1',
          source: { type: 'user', userId: CALLER },
          message: { type: 'text', id: '7000001', text: code.json<{ message: string }>().message },
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
    await waitFor(
      () => sent.slice(before).some((s) => JSON.stringify(s.body).includes('連携しました')),
      'linked',
    );
  }, 20_000);

  afterAll(async () => {
    await harness?.close();
    gemini?.close();
  });

  it('connects only a linked caller, with the bridge key, to the call voice path', async () => {
    const key = lineCallBridgeKey(SEAL_KEY);
    const ask = (subject: string | null, auth = key) =>
      app.inject({
        method: 'POST',
        url: '/v1/channels/line-oa-call',
        headers: { authorization: `Bearer ${auth}` },
        payload: { subject },
      });
    expect((await ask(CALLER, 'b'.repeat(64))).statusCode).toBe(403);
    // 連携していない人の電話にはつながない
    const stranger = await ask('Ustranger000');
    expect(stranger.statusCode).toBe(409);
    expect(stranger.json()).toEqual({ refused: 'not_linked' });

    const issued = await ask(CALLER);
    expect(issued.statusCode).toBe(201);
    const path = issued.json<{ ws: string }>().ws;
    expect(path).toMatch(/^\/v1\/channels\/call\/[A-Za-z0-9_-]{32}\/ws$/);
    // その道は、いつもの通話と同じく Gemini Live へつながる
    const client = open(path);
    const events: Record<string, unknown>[] = [];
    client.on('message', (data: Buffer, binary: boolean) => {
      if (!binary) events.push(JSON.parse(String(data)) as Record<string, unknown>);
    });
    await waitFor(() => events.some((e) => e['type'] === 'ready'), 'bridge ready');
    expect(geminiSaw.some((m) => m['setup'])).toBe(true);
    client.send(JSON.stringify({ type: 'hangup' }));
    await waitFor(() => client.readyState === WebSocket.CLOSED, 'bridge closed');
  });
});
