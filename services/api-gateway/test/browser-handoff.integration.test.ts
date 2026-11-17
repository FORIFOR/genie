/**
 * ブラウザの引き継ぎ（src/browser-handoff.ts・routes/browser-handoff.ts）を DB と本物の WebSocket で。
 *
 * 見ること:
 *   - 引き継ぎを始められるのは、その step（browser.read_page）を取っている端末と、仕事を頼んだ本人だけ
 *   - 本人に LINE でリンクが届く。開ける場所が無い・届けられないときは始めない
 *   - 端末の画面が本人のページに流れ、本人の操作が端末に届く（変な形の操作は捨てる）
 *   - 終わったら本人のページに終わりが届き、リンクは使えなくなる（410）。LIFF の入口 /h/ から移る
 *   ./infra/db/with-test-db.sh pnpm --filter @genie/service-api-gateway test
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type TokenResponse, uuidv7 } from '@genie/contracts';
import { HostBridge } from '@genie/service-agent-host';
import { HandoffHub, handoffUrlFor } from '../src/browser-handoff.js';
import { BrowserSnapshots, snapshotReply } from '../src/browser-snapshots.js';
import { makeTestApp, makeTokens, testDbConfig, type TestApp } from './support.js';

const url = process.env['TEST_DATABASE_URL'];
const identityUrl = process.env['TEST_IDENTITY_DATABASE_URL'];

describe.skipIf(!url)('browser handoff', () => {
  let harness: TestApp;
  let base = '';
  const hub = new HandoffHub();
  const said: { userId: string; text: string; image?: string }[] = [];
  const snapshots = new BrowserSnapshots();
  const imageUrlFor = (token: string) => `https://genie.example/v1/channels/snapshot/${token}`;
  let deliver = true;
  let publicUrl: string | null = 'https://genie.example';

  beforeAll(async () => {
    harness = await makeTestApp({
      dbConfig: testDbConfig(url!, identityUrl),
      tokens: await makeTokens(),
      handoffs: {
        hub,
        urlFor: (token) => handoffUrlFor({ publicUrl, liffId: null })(token),
        notify: async (_tenantId, userId, text) => {
          said.push({ userId, text });
          return deliver;
        },
        snapshots,
        imageUrlFor,
        notifyMessage: async (_tenantId, userId, message) => {
          said.push({
            userId,
            text: message.text,
            ...(message.image ? { image: message.image.url } : {}),
          });
          return deliver;
        },
      },
    });
    base = await harness.app.listen({ port: 0, host: '127.0.0.1' });
  });

  afterAll(async () => {
    await harness?.close();
  });

  /** サインインして、端末を立て、browser.read_page の step を端末に取らせる。 */
  const claimed = async (toolId = 'browser.read_page') => {
    const issued = await harness.app.inject({
      method: 'POST',
      url: '/v1/auth/dev/token',
      payload: { email: `b-${uuidv7()}@example.com`, display_name: 'B' },
    });
    const auth = { authorization: `Bearer ${issued.json<TokenResponse>().access_token}` };
    const me = (await harness.app.inject({ method: 'GET', url: '/v1/me', headers: auth })).json<{
      tenant: { id: string };
      user: { id: string };
    }>();
    const hostId = (
      await harness.app.inject({
        method: 'POST',
        url: '/v1/agent-hosts/heartbeat',
        headers: auth,
        payload: { device_label: 'handoff-test', models: ['test'] },
      })
    ).json<{ id: string }>().id;
    const { task } = await harness.tasks.create({
      tenantId: me.tenant.id,
      userId: me.user.id,
      request: { kind: 'echo', title: 'ページを読む', input: {} },
      idempotencyKey: `h:${uuidv7()}`,
    });
    const request = await new HostBridge({ db: harness.db }).request({
      tenantId: me.tenant.id,
      taskId: task.id,
      stepIndex: 0,
      toolId,
      args: {},
    });
    await harness.app.inject({
      method: 'POST',
      url: '/v1/host-steps/claim',
      headers: auth,
      payload: { host_id: hostId },
    });
    return { auth, hostId, requestId: request.id, userId: me.user.id };
  };

  const start = (c: Awaited<ReturnType<typeof claimed>>, over: Record<string, unknown> = {}) =>
    harness.app.inject({
      method: 'POST',
      url: '/v1/browser-handoffs',
      headers: c.auth,
      payload: { request_id: c.requestId, host_id: c.hostId, site: 'members.example.com', ...over },
    });

  it('relays the screen to the person and their taps back to the Mac, then closes the link', async () => {
    const c = await claimed();
    const started = await start(c);
    expect(started.statusCode).toBe(201);
    const id = started.json<{ id: string }>().id;
    const notice = said.at(-1)!;
    expect(notice.userId).toBe(c.userId);
    expect(notice.text).toContain('members.example.com のページはログインが要るため');
    const token = /\/v1\/channels\/handoff\/([A-Za-z0-9_-]{32})/.exec(notice.text)![1]!;

    const page = await harness.app.inject({ method: 'GET', url: `/v1/channels/handoff/${token}` });
    expect(page.statusCode).toBe(200);
    expect(page.headers['cache-control']).toBe('no-store');
    expect(page.body).toContain('ログインだけお願いします');
    const entry = await harness.app.inject({
      method: 'GET',
      url: `/v1/channels/board?liff.state=${encodeURIComponent(`/h/${token}`)}`,
    });
    expect(entry.body).toContain(`location.replace("/v1/channels/handoff/${token}")`);

    // 本人のページがつながる
    const ws = new WebSocket(`${base.replace('http', 'ws')}/v1/channels/handoff/${token}/ws`);
    const messages: { type: string; jpeg?: string; password?: boolean; state?: string }[] = [];
    ws.addEventListener('message', (e) => messages.push(JSON.parse(String(e.data))));
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve);
      ws.addEventListener('error', reject);
    });
    const until = async (check: () => boolean) => {
      for (let i = 0; i < 100 && !check(); i++) await new Promise((r) => setTimeout(r, 20));
    };

    // 端末の画面が流れる
    const frame = await harness.app.inject({
      method: 'POST',
      url: `/v1/browser-handoffs/${id}/frame`,
      headers: c.auth,
      payload: { host_id: c.hostId, jpeg: '/9j/AAAA', width: 390, height: 760, password: true },
    });
    expect(frame.statusCode).toBe(204);
    await until(() => messages.some((m) => m.type === 'frame'));
    expect(messages.find((m) => m.type === 'frame')).toMatchObject({
      jpeg: '/9j/AAAA',
      password: true,
    });

    // 本人の操作が端末に届く（変な形は捨てる）
    ws.send(JSON.stringify({ type: 'tap', x: 100, y: 30 }));
    ws.send(JSON.stringify({ type: 'eval', code: 'alert(1)' }));
    ws.send(JSON.stringify({ type: 'text', text: 'taro' }));
    await new Promise((r) => setTimeout(r, 100));
    const taken = await harness.app.inject({
      method: 'POST',
      url: `/v1/browser-handoffs/${id}/inputs`,
      headers: c.auth,
      payload: { host_id: c.hostId, wait_ms: 1000 },
    });
    expect(taken.json()).toEqual({
      inputs: [
        { type: 'tap', x: 100, y: 30 },
        { type: 'text', text: 'taro' },
      ],
      ended: null,
    });

    // 終わり: 本人のページに届き、リンクは使えなくなる
    const ended = await harness.app.inject({
      method: 'POST',
      url: `/v1/browser-handoffs/${id}/end`,
      headers: c.auth,
      payload: { host_id: c.hostId, state: 'resumed' },
    });
    expect(ended.statusCode).toBe(204);
    await until(() => messages.some((m) => m.type === 'ended'));
    expect(messages.at(-1)).toEqual({ type: 'ended', state: 'resumed' });
    ws.close();
    expect(
      (await harness.app.inject({ method: 'GET', url: `/v1/channels/handoff/${token}` }))
        .statusCode,
    ).toBe(410);
    const late = new WebSocket(`${base.replace('http', 'ws')}/v1/channels/handoff/${token}/ws`);
    const goodbye = await new Promise<string>((resolve) =>
      late.addEventListener('message', (e) => resolve(String(e.data))),
    );
    expect(JSON.parse(goodbye)).toEqual({ type: 'ended', state: 'timed_out' });
  });

  it('starts only for the Mac holding a browser.read_page step of the person', async () => {
    const c = await claimed();
    expect((await start(c, { host_id: uuidv7() })).statusCode).toBe(404);
    expect((await start(c, { site: 'not a host' })).statusCode).toBe(400);
    const other = await claimed('mail.send');
    expect((await start(other)).statusCode).toBe(404);
    // ほかの人（別のテナント）は、その step で始められない
    const stranger = await claimed();
    expect(
      (await start({ ...stranger, requestId: c.requestId, hostId: c.hostId })).statusCode,
    ).toBe(404);
    // ほかの人の引き継ぎの画面は送れない
    const mine = await start(c);
    const id = mine.json<{ id: string }>().id;
    expect(
      (
        await harness.app.inject({
          method: 'POST',
          url: `/v1/browser-handoffs/${id}/frame`,
          headers: stranger.auth,
          payload: {
            host_id: stranger.hostId,
            jpeg: '/9j/AAAA',
            width: 1,
            height: 1,
            password: false,
          },
        })
      ).statusCode,
    ).toBe(404);
  });

  it('does not start when the link cannot be opened or delivered', async () => {
    const c = await claimed();
    publicUrl = null;
    try {
      expect((await start(c)).json()).toEqual({ error: 'no_public_place' });
    } finally {
      publicUrl = 'https://genie.example';
    }
    deliver = false;
    try {
      const refused = await start(c);
      expect(refused.statusCode).toBe(409);
      expect(refused.json()).toEqual({ error: 'not_delivered' });
    } finally {
      deliver = true;
    }
  });

  // 本人の設計 2026-11-05: LINE へ画面画像（隠すところを隠したもの）を送る
  describe('the masked screen of the Genie browser', () => {
    const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]).toString('base64');
    const snap = (c: Awaited<ReturnType<typeof claimed>>, over: Record<string, unknown> = {}) =>
      harness.app.inject({
        method: 'POST',
        url: '/v1/browser-snapshots',
        headers: c.auth,
        payload: {
          host_id: c.hostId,
          request_id: c.requestId,
          jpeg: JPEG,
          site: 'members.example.com',
          title: 'ログイン',
          stage: 'login',
          masked: 2,
          ...over,
        },
      });

    it('keeps only the screen of the step this Mac holds, and only JPEG', async () => {
      const c = await claimed();
      expect((await snap(c, { host_id: uuidv7() })).statusCode).toBe(404);
      const other = await claimed('mail.send');
      expect((await snap(other)).statusCode).toBe(404);
      expect((await snap(c, { jpeg: Buffer.from('<svg/>').toString('base64') })).statusCode).toBe(
        400,
      );
      expect((await snap(c, { site: 'http://x/' })).statusCode).toBe(400);
      expect((await snap(c)).statusCode).toBe(204);
    });

    it('shows the latest screen on 「画面を見せて」 through a link that serves only that image', async () => {
      const c = await claimed();
      const me = (
        await harness.app.inject({ method: 'GET', url: '/v1/me', headers: c.auth })
      ).json<{
        tenant: { id: string };
      }>();
      const none = snapshotReply(snapshots, me.tenant.id, c.userId, '画面を見せて', imageUrlFor);
      expect(none?.text).toContain('いま見られる Genie のブラウザの画面はありません');
      expect(none?.image).toBeUndefined();
      expect((await snap(c, { stage: 'read', masked: 3 })).statusCode).toBe(204);
      const reply = snapshotReply(snapshots, me.tenant.id, c.userId, '今の画面見せて', imageUrlFor);
      expect(reply?.text).toContain('members.example.com');
      expect(reply?.text).toContain('3 か所は黒く隠しています');
      const token = /snapshot\/([A-Za-z0-9_-]{32})$/.exec(reply!.image!.url)![1]!;
      const image = await harness.app.inject({
        method: 'GET',
        url: `/v1/channels/snapshot/${token}`,
      });
      expect(image.statusCode).toBe(200);
      expect(image.headers['content-type']).toBe('image/jpeg');
      expect(image.headers['cache-control']).toBe('no-store');
      expect(image.rawPayload.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
      // 新しい画面を置いたら、前のリンクは使えない。知らない秘密も 404
      expect((await snap(c, { stage: 'read' })).statusCode).toBe(204);
      expect(
        (await harness.app.inject({ method: 'GET', url: `/v1/channels/snapshot/${token}` }))
          .statusCode,
      ).toBe(404);
      expect(
        (
          await harness.app.inject({
            method: 'GET',
            url: `/v1/channels/snapshot/${'a'.repeat(32)}`,
          })
        ).statusCode,
      ).toBe(404);
      // ほかの文は読まない
      expect(
        snapshotReply(snapshots, me.tenant.id, c.userId, '画面の設定を変えて', imageUrlFor),
      ).toBeNull();
    });

    it('attaches the login screen to the request to log in', async () => {
      const c = await claimed();
      expect((await snap(c, { stage: 'login' })).statusCode).toBe(204);
      expect((await start(c)).statusCode).toBe(201);
      const notice = said.at(-1)!;
      expect(notice.text).toContain('ログインが要るため');
      expect(notice.image).toMatch(/^https:\/\/genie\.example\/v1\/channels\/snapshot\//);
    });
  });
});
