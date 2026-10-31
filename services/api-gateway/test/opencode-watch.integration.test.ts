/**
 * opencode の見守りを、本物の PostgreSQL（RLS）と、opencode の API の代役で通す。
 * 時計は差し替える（10 分ごとを待たない）。
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type TokenResponse } from '@genie/contracts';
import { withTenant } from '@genie/db';
import { DONE_MARK, OpencodeWatchService } from '../src/opencode-watch.js';
import { makeTestApp, makeTokens, testDbConfig, type TestApp } from './support.js';

const url = process.env['TEST_DATABASE_URL'];
describe.skipIf(!url)('watching an opencode session', () => {
  let h: TestApp;
  let principal: { tenantId: string; userId: string };
  let conversationId: string;
  let server: http.Server;
  let base: string;
  // 代役の opencode の状態
  const fake = {
    status: 'idle' as 'idle' | 'busy',
    permission: false,
    message: { id: 'msg_1', completed: 1000, text: '途中まで直しました。' },
    prompts: [] as string[],
    aborts: 0,
  };
  const told: string[] = [];
  let clock = new Date('2026-10-25T00:00:00Z');
  let watches: OpencodeWatchService;
  const SESSION = 'ses_watchtest01';

  beforeAll(async () => {
    server = http
      .createServer((req, res) => {
        const send = (body: unknown) => {
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify(body));
        };
        if (req.url === '/session/status')
          return send(fake.status === 'busy' ? { [SESSION]: { type: 'busy' } } : {});
        if (req.url === '/permission')
          return send(fake.permission ? [{ id: 'per_1', sessionID: SESSION }] : []);
        if (req.url === '/question') return send([]);
        if (req.url?.startsWith(`/session/${SESSION}/message`))
          return send([
            { info: { id: 'msg_0', role: 'user' }, parts: [{ type: 'text', text: '実装して' }] },
            {
              info: {
                id: fake.message.id,
                role: 'assistant',
                time: { completed: fake.message.completed },
                finish: 'stop',
              },
              parts: [{ type: 'text', text: fake.message.text }],
            },
          ]);
        if (req.url === `/session/${SESSION}/todo`) return send([]);
        if (req.url === `/session/${SESSION}/abort` && req.method === 'POST') {
          fake.aborts += 1;
          fake.status = 'idle';
          return send(true);
        }
        if (req.url === `/session/${SESSION}/prompt_async` && req.method === 'POST') {
          let body = '';
          req.on('data', (c) => (body += c));
          req.on('end', () => {
            fake.prompts.push((JSON.parse(body) as { parts: { text: string }[] }).parts[0]!.text);
            res.statusCode = 204;
            res.end();
          });
          return;
        }
        res.statusCode = 404;
        res.end();
      })
      .listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;

    h = await makeTestApp({
      dbConfig: testDbConfig(url!, process.env['TEST_IDENTITY_DATABASE_URL']),
      tokens: await makeTokens(),
    });
    const issued = await h.app.inject({
      method: 'POST',
      url: '/v1/auth/dev/token',
      payload: { email: `watch-${String(Date.now())}@example.com`, display_name: 'Watcher' },
    });
    const access = issued.json<TokenResponse>().access_token;
    const claims = JSON.parse(Buffer.from(access.split('.')[1]!, 'base64url').toString()) as {
      tid: string;
      sub: string;
    };
    principal = { tenantId: claims.tid, userId: claims.sub };
    conversationId = (
      await h.app.inject({
        method: 'POST',
        url: '/v1/conversations',
        headers: { authorization: `Bearer ${access}` },
        payload: {},
      })
    ).json<{ id: string }>().id;
    watches = new OpencodeWatchService({
      db: h.db,
      now: () => clock,
      notify: async (_t, _u, _c, text) => {
        told.push(text);
      },
    });
  });

  afterAll(async () => {
    await h?.close();
    server?.close();
  });

  const later = async (minutes: number) => {
    clock = new Date(clock.getTime() + minutes * 60_000);
    return watches.tick();
  };
  const status = async () =>
    withTenant(h.db, principal.tenantId, (tx) =>
      tx
        .selectFrom('opencode_watches')
        .select(['status', 'nudges', 'ended_reason'])
        .orderBy('created_at', 'desc')
        .executeTakeFirstOrThrow(),
    );

  it('tells about a session stuck on busy, then aborts and nudges it, and gives up after three', async () => {
    await watches.command(principal, conversationId, '見守りをやめて');
    fake.status = 'busy';
    fake.aborts = 0;
    fake.prompts.length = 0;
    told.length = 0;
    fake.message = { id: 'msg_stuck', completed: 1, text: 'pip install' };
    await watches.command(
      principal,
      conversationId,
      `${base}/session/${SESSION} を10分ごとに見張って opencode`,
    );
    await watches.tick();
    await later(20);
    expect(told).toHaveLength(0);
    await later(10);
    expect(told.at(-1)).toContain('30 分進んでいません');
    await later(10);
    expect(told.filter((t) => t.includes('進んでいません'))).toHaveLength(1);
    expect(fake.aborts).toBe(0);
    await later(20);
    expect(fake.aborts).toBe(1);
    expect(told.at(-1)).toContain('固まった実行を止めました');
    await watches.tick();
    expect(fake.prompts).toHaveLength(1);
    // 進み始めたら期限が延びる
    fake.status = 'busy';
    fake.message = { id: 'msg_next', completed: 2, text: 'x' };
    await later(10);
    const row = () =>
      withTenant(h.db, principal.tenantId, (tx) =>
        tx
          .selectFrom('opencode_watches')
          .select(['expires_at', 'stuck_aborts', 'status'])
          .orderBy('created_at', 'desc')
          .executeTakeFirstOrThrow(),
      );
    expect((await row()).expires_at.getTime()).toBe(clock.getTime() + 12 * 3600_000);
    // 3 回止めても固まるなら、止めて知らせる
    for (let i = 0; i < 2; i += 1) {
      fake.status = 'busy';
      fake.message = { id: `msg_again_${String(i)}`, completed: 3, text: 'x' };
      await later(10);
      await later(60);
      await watches.tick();
    }
    fake.status = 'busy';
    fake.message = { id: 'msg_last', completed: 4, text: 'x' };
    await later(10);
    await later(60);
    expect((await row()).status).toBe('stalled');
    expect(fake.aborts).toBe(3);
    fake.status = 'idle';
    await watches.command(principal, conversationId, '見守りをやめて');
    fake.prompts.length = 0;
    told.length = 0;
    fake.message = { id: 'msg_1', completed: 1000, text: '途中まで直しました。' };
  });

  it('never aborts a busy session that is waiting for approval, and outlives the watch window', async () => {
    fake.status = 'busy';
    fake.permission = true;
    fake.aborts = 0;
    fake.prompts.length = 0;
    told.length = 0;
    fake.message = { id: 'msg_wait', completed: 1, text: 'pip install' };
    await watches.command(
      principal,
      conversationId,
      `${base}/session/${SESSION} を10分ごとに見張って opencode`,
    );
    await watches.tick();
    // 見守りの 12 時間を超えて待っても、止めない・促さない・終わらせない
    for (let i = 0; i < 16; i += 1) await later(60);
    expect(fake.aborts).toBe(0);
    expect(fake.prompts).toHaveLength(0);
    expect(told.filter((t) => t.includes('承認'))).toHaveLength(1);
    expect(told.filter((t) => t.includes('進んでいません'))).toHaveLength(0);
    expect(told.filter((t) => t.includes('見守りを終えました'))).toHaveLength(0);
    fake.status = 'idle';
    fake.permission = false;
    await watches.command(principal, conversationId, '見守りをやめて');
    fake.prompts.length = 0;
    told.length = 0;
    fake.message = { id: 'msg_1', completed: 1000, text: '途中まで直しました。' };
  });

  it('nudges a stopped session, waits while it works, and ends when it says it is done', async () => {
    const answer = await watches.command(
      principal,
      conversationId,
      `${base}/session/${SESSION} を10分ごとに見て、止まっていたら続けさせて（opencode）`,
    );
    expect(answer).toMatch(/^承知しました。10 分ごとに/);
    // 頼まれたらすぐ 1 回見る → 止まっているので促す
    expect(await watches.tick()).toBe(1);
    expect(fake.prompts).toHaveLength(1);
    expect(fake.prompts[0]).toContain('続けてください');
    expect(told.at(-1)).toContain('1 回目');
    // 10 分たつまでは見ない
    expect(await later(5)).toBe(0);
    // 作業中は何もしない
    fake.status = 'busy';
    expect(await later(5)).toBe(1);
    expect(fake.prompts).toHaveLength(1);
    // 承認を待っていれば促さず、1 回だけ知らせる
    fake.status = 'idle';
    fake.permission = true;
    await later(10);
    await later(10);
    expect(fake.prompts).toHaveLength(1);
    expect(told.filter((t) => t.includes('承認'))).toHaveLength(1);
    // 終わりの印
    fake.permission = false;
    fake.message = { id: 'msg_2', completed: 2000, text: `テストも通りました。\n${DONE_MARK}` };
    await later(10);
    expect(told.at(-1)).toContain('終わったようです');
    expect(await status()).toMatchObject({ status: 'done', nudges: 1 });
    expect(await later(60)).toBe(0);
  });

  it('stops when nudging does not move the session, and on 「見守りをやめて」', async () => {
    fake.message = { id: 'msg_3', completed: 3000, text: 'ここで止まっています。' };
    await watches.command(
      principal,
      conversationId,
      `${base}/session/${SESSION} 止まっていたら続けさせて opencode`,
    );
    await watches.tick(); // 進んだ（新しい返答）→ 促す
    await later(10); // 同じ返答 → 1
    await later(10); // 2
    await later(10); // 3 → 止める
    expect(await status()).toMatchObject({ status: 'stalled', ended_reason: 'no_progress' });
    expect(told.at(-1)).toContain('進みませんでした');

    await watches.command(
      principal,
      conversationId,
      `${base}/session/${SESSION} を見守って opencode`,
    );
    expect(await watches.command(principal, conversationId, '見守りをやめて')).toBe(
      '承知しました。opencode の見守りをやめました。',
    );
    expect(await status()).toMatchObject({ status: 'stopped' });
  });

  it('stops after three failed connections, and refuses addresses outside', async () => {
    await watches.command(
      principal,
      conversationId,
      `http://127.0.0.1:1/session/${SESSION} を見守って opencode`,
    );
    await watches.tick();
    await later(10);
    await later(10);
    expect(await status()).toMatchObject({ status: 'unreachable' });
    expect(told.at(-1)).toContain('つながりませんでした');
    expect(
      await watches.command(
        principal,
        conversationId,
        'https://example.com/session/ses_x を見守って opencode',
      ),
    ).toContain('Tailscale');
    // 関係のない文は扱わない
    expect(await watches.command(principal, conversationId, '明日の天気は？')).toBeNull();
  });

  // 2026-10-26 のログ: 「もう一度opencode監視して」「opencodeの実装は終わっているでしょうか？」が通じなかった
  it('restarts the last watched session without a URL, and answers how it is going', async () => {
    // 前回は手元の代役を見守っていた（最後に頼んだもの）
    await watches.command(
      principal,
      conversationId,
      `${base}/session/${SESSION} を見守って opencode`,
    );
    await watches.command(principal, conversationId, '見守りをやめて');
    fake.status = 'busy';
    const again = await watches.command(
      principal,
      conversationId,
      'ごめん\nもう一度opencode監視して',
    );
    expect(again).toMatch(/^承知しました。/);
    expect(again).toContain('ses_watchtest01');
    const report = await watches.command(
      principal,
      conversationId,
      'また、opencodeの実装は終わっているでしょうか？',
    );
    expect(report).toContain('見守っています');
    expect(report).toContain('いまのセッション: 作業中です');
    // 質問に「承知しました」は付けない
    expect(report).not.toMatch(/^承知しました/);
    await watches.command(principal, conversationId, '見守りをやめて');
    fake.status = 'idle';
    expect(await watches.command(principal, conversationId, 'opencode はどうなった？')).toContain(
      '続けて見守るなら',
    );
  });
});
