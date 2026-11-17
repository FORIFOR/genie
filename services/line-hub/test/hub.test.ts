import { createHmac } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { hashLinkCode } from '@genie/service-channels';
import { HubStore, createHub, type Hub } from '../src/index.js';

const SECRET = 'hub-channel-secret';

describe('LINE hub', () => {
  let hub: Hub;
  let base: string;
  const line: { url: string; body: Record<string, unknown> | null; retryKey: string | null }[] = [];

  beforeEach(async () => {
    line.length = 0;
    hub = createHub({
      channelSecret: SECRET,
      accessToken: 'operator-token',
      store: new HubStore(':memory:'),
      registrationToken: 'reg',
      fetchImpl: (async (url: string, init?: RequestInit) => {
        const headers = new Headers(init?.headers);
        expect(headers.get('authorization')).toBe('Bearer operator-token');
        line.push({
          url,
          body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null,
          retryKey: headers.get('x-line-retry-key'),
        });
        if (url.includes('/content'))
          return new Response(new Uint8Array([7, 7]), {
            headers: { 'content-type': 'image/jpeg' },
          });
        return Response.json({});
      }) as typeof fetch,
    });
    await new Promise<void>((r) => hub.server.listen(0, '127.0.0.1', () => r()));
    base = `127.0.0.1:${String((hub.server.address() as AddressInfo).port)}`;
  });
  afterEach(async () => {
    await hub.close();
  });

  const register = async () => {
    const res = await fetch(`http://${base}/installs`, {
      method: 'POST',
      headers: { authorization: 'Bearer reg' },
    });
    expect(res.status).toBe(201);
    return (await res.json()) as { install_id: string; secret: string };
  };

  /** 偽の Genie。届いた知らせを覚え、受け取りを返す（ack を止めることもできる）。 */
  const genie = async (cred: { install_id: string; secret: string }, ack = true) => {
    const ws = new WebSocket(`ws://${base}/connect`, {
      headers: { authorization: `Bearer ${cred.install_id}:${cred.secret}` },
    });
    const events: Record<string, unknown>[] = [];
    const responses = new Map<string, Record<string, unknown>>();
    ws.on('message', (data) => {
      const m = JSON.parse(String(data)) as Record<string, unknown>;
      if (m['t'] === 'event') {
        events.push(m);
        if (ack) ws.send(JSON.stringify({ t: 'ack', id: m['id'] }));
      }
      if (m['t'] === 'res') responses.set(String(m['id']), m);
    });
    await new Promise((r, j) => {
      ws.once('open', r);
      ws.once('error', j);
    });
    let serial = 0;
    const ask = async (payload: Record<string, unknown>) => {
      const id = `q${String(++serial)}`;
      ws.send(JSON.stringify({ t: 'req', id, ...payload }));
      for (let i = 0; i < 200 && !responses.has(id); i += 1)
        await new Promise((r) => setTimeout(r, 10));
      return responses.get(id)!;
    };
    return { ws, events, ask };
  };

  let serial = 0;
  const webhook = async (event: Record<string, unknown>) => {
    const raw = JSON.stringify({
      destination: 'Ubot',
      events: [
        {
          mode: 'active',
          timestamp: Date.now(),
          webhookEventId: `e${String(++serial)}`,
          replyToken: `rt${String(serial)}`,
          ...event,
        },
      ],
    });
    return fetch(`http://${base}/line/webhook`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-line-signature': createHmac('sha256', SECRET).update(raw).digest('base64'),
      },
      body: raw,
    });
  };
  const dm = (userId: string, text: string, id = String(1000 + serial)) =>
    webhook({
      type: 'message',
      source: { type: 'user', userId },
      message: { type: 'text', id, text },
    });
  const waitFor = async (check: () => boolean) => {
    for (let i = 0; i < 200 && !check(); i += 1) await new Promise((r) => setTimeout(r, 10));
    expect(check()).toBe(true);
  };

  it('refuses bad signatures, unknown installs and registration without the token', async () => {
    const bad = await fetch(`http://${base}/line/webhook`, {
      method: 'POST',
      headers: { 'x-line-signature': 'x' },
      body: '{}',
    });
    expect(bad.status).toBe(403);
    expect((await fetch(`http://${base}/installs`, { method: 'POST' })).status).toBe(401);
    const ws = new WebSocket(`ws://${base}/connect`, {
      headers: { authorization: 'Bearer gi_x:nope' },
    });
    await expect(
      new Promise((r, j) => {
        ws.once('open', r);
        ws.once('error', j);
      }),
    ).rejects.toThrow();
  });

  it('prompts strangers to link, routes a link code to the Genie that issued it, then keeps routing that person', async () => {
    const a = await genie(await register());
    await dm('Ustranger', 'こんにちは');
    await waitFor(() => line.length === 1);
    expect(line[0]!.url).toBe('https://api.line.me/v2/bot/message/reply');
    expect(JSON.stringify(line[0]!.body)).toContain('連携していません');
    expect(a.events).toHaveLength(0);

    expect(
      (
        await a.ask({
          op: 'claim-code',
          codeHash: hashLinkCode('ABCD2345'),
          expiresAt: Date.now() + 600_000,
        })
      )['status'],
    ).toBe(204);
    await dm('Umama', '連携 ABCD2345');
    await waitFor(() => a.events.length === 1);
    expect(a.events[0]).toMatchObject({
      destination: 'Ubot',
      event: { source: { userId: 'Umama' } },
    });
    await dm('Umama', 'こんにちは');
    await waitFor(() => a.events.length === 2);
    // コードは 1 回だけ
    await dm('Uother', '連携 ABCD2345');
    await waitFor(() => line.length === 2);
    expect(JSON.stringify(line[1]!.body)).toContain('期限');
  });

  it('lets a Genie act only on what was delivered to it, and holds events while it is away', async () => {
    const credA = await register();
    const a = await genie(credA, false);
    const b = await genie(await register());
    await a.ask({
      op: 'claim-code',
      codeHash: hashLinkCode('AAAA2222'),
      expiresAt: Date.now() + 600_000,
    });
    await b.ask({
      op: 'claim-code',
      codeHash: hashLinkCode('BBBB3333'),
      expiresAt: Date.now() + 600_000,
    });
    await dm('Ua', '連携 AAAA2222');
    await dm('Ub', '連携 BBBB3333');
    await waitFor(() => a.events.length === 1 && b.events.length === 1);

    // 自分の利用者へは push できる。ほかの Genie の利用者へはできない
    expect(
      (
        await a.ask({
          op: 'line',
          method: 'POST',
          path: 'message/push',
          body: { to: 'Ua', messages: [] },
          retryKey: 'k1',
        })
      )['status'],
    ).toBe(200);
    expect(line.at(-1)!.retryKey).toBe('k1');
    expect(
      (
        await a.ask({
          op: 'line',
          method: 'POST',
          path: 'message/push',
          body: { to: 'Ub', messages: [] },
        })
      )['status'],
    ).toBe(403);
    // 届いた写真だけ取れる
    await webhook({
      type: 'message',
      source: { type: 'user', userId: 'Ua' },
      message: { type: 'image', id: '555' },
    });
    await waitFor(() => a.events.length === 2);
    const photo = await a.ask({ op: 'line', method: 'GET', path: 'message/555/content' });
    expect(photo).toMatchObject({ status: 200, headers: { 'content-type': 'image/jpeg' } });
    expect(Buffer.from(String(photo['body']), 'base64')).toEqual(Buffer.from([7, 7]));
    expect(
      (await b.ask({ op: 'line', method: 'GET', path: 'message/555/content' }))['status'],
    ).toBe(403);
    expect(
      (await a.ask({ op: 'line', method: 'POST', path: 'message/delete', body: {} }))['status'],
    ).toBe(403);

    // a は受け取りを返していない → つなぎ直すと、同じ知らせがもう一度届く
    a.ws.close();
    await new Promise((r) => setTimeout(r, 50));
    await dm('Ua', '寝ている間の発言');
    const again = await genie(credA);
    await waitFor(() => again.events.length === 3);
    expect(
      again.events.map((e) => (e['event'] as { message: { text?: string } }).message.text),
    ).toContain('寝ている間の発言');
  });

  it('greets a group, routes a linked speaker to their Genie, and the group after it is claimed', async () => {
    const a = await genie(await register());
    await a.ask({
      op: 'claim-code',
      codeHash: hashLinkCode('CCCC4444'),
      expiresAt: Date.now() + 600_000,
    });
    await dm('Umama', '連携 CCCC4444');
    await waitFor(() => a.events.length === 1);

    await webhook({ type: 'join', source: { type: 'group', groupId: 'Cfam' } });
    await waitFor(() => line.length === 1);
    // 招待＝使い始め。「このグループで使う」とは言わせない
    expect(JSON.stringify(line[0]!.body)).toContain('こんにちは、Genie です');
    expect(JSON.stringify(line[0]!.body)).not.toContain('このグループで使う');

    // 持ち主が決まる前: 連携していない人の発言は誰にも届けない（メンションには準備中と返す）
    const mention = { mentionees: [{ index: 0, length: 6, isSelf: true }] };
    await webhook({
      type: 'message',
      source: { type: 'group', groupId: 'Cfam', userId: 'Upapa' },
      message: { type: 'text', id: '8', text: '@Genie こんにちは', mention },
    });
    await waitFor(() => line.length === 2);
    expect(JSON.stringify(line[1]!.body)).toContain('準備中');
    // 連携している人の発言は（メンションが無くても）その人の Genie へ。Genie がそこで使い始める
    await webhook({
      type: 'message',
      source: { type: 'group', groupId: 'Cfam', userId: 'Umama' },
      message: { type: 'text', id: '9', text: '夕飯どうする' },
    });
    await waitFor(() => a.events.length === 2);
    expect((await a.ask({ op: 'claim-group', groupId: 'Cfam' }))['status']).toBe(204);
    // 使い始めたら、グループの発言（パパから・メンションなしでも）はこの Genie へ
    await webhook({
      type: 'message',
      source: { type: 'group', groupId: 'Cfam', userId: 'Upapa' },
      message: { type: 'text', id: '11', text: '牛乳を追加' },
    });
    await waitFor(() => a.events.length === 3);
    expect(a.events).toHaveLength(3);
    // 知らせを受けていないグループは取れない
    expect((await a.ask({ op: 'claim-group', groupId: 'Cother' }))['status']).toBe(403);
  });
});
