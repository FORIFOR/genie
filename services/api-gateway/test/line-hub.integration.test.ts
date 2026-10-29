/**
 * 公式アカウント 1 つ（中継）で、利用者の Genie へ届ける。中継は本物（services/line-hub）、LINE の API は代役。
 *
 * 見ること:
 *   - Genie は中継へ自分からつなぐ（公開 URL も LINE の鍵もいらない）。gateway は LINE の Webhook を開かない
 *   - Genie で出した連携コードは中継に知らされ、その人の「連携 …」が自分の Genie に届いて結ばれる
 *   - 返信は中継が LINE へ送る（LINE の鍵は中継にだけある）
 *   - 連携を切ると、中継もその人を自分の Genie へ届けなくなる
 *   ./infra/db/with-test-db.sh pnpm --filter @genie/service-api-gateway test
 */
import { createHmac } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type TokenResponse, uuidv7 } from '@genie/contracts';
import { HubStore, createHub, type Hub } from '@genie/service-line-hub';
import { makeTestApp, makeTokens, testDbConfig, type TestApp } from './support.js';
import type { App } from '../src/fastify.js';

const url = process.env['TEST_DATABASE_URL'];
const identityUrl = process.env['TEST_IDENTITY_DATABASE_URL'];
const SECRET = 'operator-line-secret';

describe.skipIf(!url)('one LINE official account through the hub', () => {
  let hub: Hub;
  let hubBase: string;
  let harness: TestApp;
  let app: App;
  let auth: { authorization: string };
  const line: { url: string; body: Record<string, unknown> }[] = [];
  const texts = (since: number) =>
    line
      .slice(since)
      .map((l) => String((l.body['messages'] as { text?: string }[] | undefined)?.[0]?.text ?? ''));
  const waitFor = async (check: () => boolean, label: string) => {
    for (let i = 0; i < 500; i += 1) {
      if (check()) return;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error(`timed out: ${label}`);
  };
  let serial = 0;
  const dm = async (userId: string, text: string) => {
    const raw = JSON.stringify({
      destination: 'Uoperator',
      events: [
        {
          type: 'message',
          mode: 'active',
          timestamp: Date.now(),
          webhookEventId: `01HUB${String(++serial).padStart(4, '0')}`,
          replyToken: `rt-hub-${String(serial)}`,
          source: { type: 'user', userId },
          message: { type: 'text', id: String(5_000_000 + serial), text },
        },
      ],
    });
    const res = await fetch(`http://${hubBase}/line/webhook`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-line-signature': createHmac('sha256', SECRET).update(raw).digest('base64'),
      },
      body: raw,
    });
    expect(res.status).toBe(200);
  };

  beforeAll(async () => {
    hub = createHub({
      channelSecret: SECRET,
      accessToken: 'operator-token',
      store: new HubStore(':memory:'),
      fetchImpl: (async (target: string, init?: RequestInit) => {
        line.push({
          url: target,
          body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
        });
        return Response.json({});
      }) as typeof fetch,
    });
    await new Promise<void>((r) => hub.server.listen(0, '127.0.0.1', () => r()));
    hubBase = `127.0.0.1:${String((hub.server.address() as AddressInfo).port)}`;
    const install = (await (
      await fetch(`http://${hubBase}/installs`, { method: 'POST' })
    ).json()) as {
      install_id: string;
      secret: string;
    };

    harness = await makeTestApp({
      dbConfig: testDbConfig(url!, identityUrl),
      tokens: await makeTokens(),
      channels: {
        // LINE の鍵は持たない。中継の場所と、この Genie の鍵だけ
        env: {
          GENIE_LINE_HUB_URL: `ws://${hubBase}/connect`,
          GENIE_LINE_HUB_CREDENTIAL: `${install.install_id}:${install.secret}`,
        },
        fetchImpl: (async () => {
          throw new Error('the gateway must not call LINE directly');
        }) as unknown as typeof fetch,
      },
    });
    app = harness.app;
    harness.channels!.start(60_000);
    await waitFor(() => hub.connected() === 1, 'genie connected');
    const issued = await app.inject({
      method: 'POST',
      url: '/v1/auth/dev/token',
      payload: { email: `hub-${uuidv7()}@example.com`, display_name: 'Hub' },
    });
    auth = { authorization: `Bearer ${issued.json<TokenResponse>().access_token}` };
  });

  afterAll(async () => {
    harness?.channels?.stop();
    await harness?.close();
    await hub?.close();
  });

  it('links through the hub with a code issued in Genie, and replies through the hub', async () => {
    const status = await app.inject({ method: 'GET', url: '/v1/channels/status', headers: auth });
    expect(status.json<{ line: unknown }>().line).toEqual({
      configured: true,
      transport: 'hub',
      hub: 'open',
    });
    // gateway は LINE の Webhook を開かない
    const direct = await app.inject({
      method: 'POST',
      url: '/v1/channels/line/webhook',
      payload: {},
    });
    expect(direct.statusCode).toBeGreaterThanOrEqual(400);

    const code = await app.inject({
      method: 'POST',
      url: '/v1/channels/link-codes',
      headers: auth,
      payload: { provider: 'line' },
    });
    expect(code.statusCode).toBe(201);
    const before = line.length;
    await dm('Uhubuser', code.json<{ message: string }>().message);
    await waitFor(() => texts(before).some((t) => t.includes('連携しました')), 'linked');
    expect(line[before]!.url).toBe('https://api.line.me/v2/bot/message/reply');
  });

  it('stops routing the person to this Genie after unlinking', async () => {
    const links = await app.inject({ method: 'GET', url: '/v1/channels/links', headers: auth });
    const id = links.json<{ items: { id: string }[] }>().items[0]!.id;
    expect(
      (await app.inject({ method: 'DELETE', url: `/v1/channels/links/${id}`, headers: auth }))
        .statusCode,
    ).toBeLessThan(300);
    await new Promise((r) => setTimeout(r, 200));
    const before = line.length;
    await dm('Uhubuser', 'まだ届く？');
    await waitFor(() => texts(before).length > 0, 'prompt');
    // 中継が自分で「連携していません」と返す（Genie には届けない）
    expect(texts(before)[0]).toContain('連携していません');
  });
});
