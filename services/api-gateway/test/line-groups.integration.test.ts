/**
 * 家族のグループに Genie を入れて使う（共有スペース）。LINE の API とモデルは代役。
 *
 * 見ること:
 *   - 招かれたらすぐ使える（「@Genie このグループで使う」は要らない）。挨拶は 1 回
 *   - 呼ばれていない発言には割り込まない
 *   - 買い物リスト・日程の候補を、グループの誰でも（Genie の利用者でなくても）使える
 *   - 「レシートを自動で読んで」のあとは、メンションなしの写真のレシートを共有の家計簿に付ける
 *   - **グループからは持ち主の個人のもの（仕事・メール・予定・個人の家計簿）に触れない**
 *   - やめられるのは使い始めた人だけ
 *   ./infra/db/with-test-db.sh pnpm --filter @genie/service-api-gateway test
 */
import { createHmac } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { type TokenResponse, uuidv7 } from '@genie/contracts';
import { withTenant } from '@genie/db';
import type { Understanding } from '@genie/service-understand';
import { makeTestApp, makeTokens, testDbConfig, type TestApp } from './support.js';
import type { App } from '../src/fastify.js';

const url = process.env['TEST_DATABASE_URL'];
const identityUrl = process.env['TEST_IDENTITY_DATABASE_URL'];
const LINE_SECRET = 'line-groups-secret';
const GROUP = 'Cfamily0001';
const NAMES: Record<string, string> = { Umama: 'ママ', Upapa: 'パパ' };

const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tokyo' }).format(new Date());
const receipt: Understanding = {
  kind: 'receipt',
  intent: 'record_expense',
  confidence: 0.97,
  source_language: 'ja',
  summary_ja: '',
  translation_ja: null,
  receipt: {
    merchant: 'ファミリーマート',
    date: today,
    total: 1280,
    currency: 'JPY',
    category: '食費',
    items_sum: 1280,
  },
  meal: null,
  event: null,
  request_ja: null,
  question_ja: null,
};

describe.skipIf(!url)('LINE family group (shared space)', () => {
  let harness: TestApp;
  let app: App;
  let auth: { authorization: string };
  let tenantId: string;
  const sent: { url: string; body: Record<string, unknown> }[] = [];
  const fetchImpl = vi.fn(async (target: string, init?: RequestInit) => {
    const member = /\/v2\/bot\/group\/[^/]+\/member\/([^/]+)$/.exec(target);
    if (member) return Response.json({ displayName: NAMES[member[1]!] ?? '誰か' });
    if (target.startsWith('https://api-data.line.me/')) {
      return new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'image/jpeg' } });
    }
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
  const deliver = async (event: Record<string, unknown>) => {
    const raw = JSON.stringify({
      destination: 'Ubot-groups',
      events: [
        {
          mode: 'active',
          timestamp: Date.now(),
          webhookEventId: `01GROUPS${String(++serial).padStart(4, '0')}`,
          replyToken: `reply-g-${String(serial)}`,
          ...event,
        },
      ],
    });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/channels/line/webhook',
      headers: {
        'content-type': 'application/json',
        'x-line-signature': createHmac('sha256', LINE_SECRET).update(raw).digest('base64'),
      },
      payload: raw,
    });
    expect(res.statusCode).toBe(200);
  };
  /** グループで話す。mention なら先頭に「@Genie 」を付けて、そのメンションを載せる。 */
  const say = async (user: string, text: string, mention = true) => {
    const body = mention ? `@Genie ${text}` : text;
    await deliver({
      type: 'message',
      source: { type: 'group', groupId: GROUP, userId: user },
      message: {
        type: 'text',
        id: String(7_000_000 + serial),
        text: body,
        ...(mention
          ? { mention: { mentionees: [{ index: 0, length: 6, type: 'user', isSelf: true }] } }
          : {}),
      },
    });
  };
  /** 送って、返事を 1 通待つ。 */
  const ask = async (user: string, text: string) => {
    const before = sent.length;
    await say(user, text);
    await waitFor(() => texts(before).length > 0, text);
    return texts(before)[0]!;
  };
  const quiet = async (act: () => Promise<void>) => {
    const before = sent.length;
    await act();
    await new Promise((r) => setTimeout(r, 300));
    return texts(before);
  };

  beforeAll(async () => {
    harness = await makeTestApp({
      dbConfig: testDbConfig(url!, identityUrl),
      tokens: await makeTokens(),
      understand: [receipt],
      channels: {
        env: { LINE_CHANNEL_SECRET: LINE_SECRET, LINE_CHANNEL_ACCESS_TOKEN: 'line-token' },
        fetchImpl: fetchImpl as unknown as typeof fetch,
      },
    });
    app = harness.app;
    const issued = await app.inject({
      method: 'POST',
      url: '/v1/auth/dev/token',
      payload: { email: `fam-${uuidv7()}@example.com`, display_name: 'Mama' },
    });
    const access = issued.json<TokenResponse>().access_token;
    auth = { authorization: `Bearer ${access}` };
    tenantId = (
      JSON.parse(Buffer.from(access.split('.')[1]!, 'base64url').toString()) as { tid: string }
    ).tid;
    // ママだけが Genie と連携している（1:1）
    const code = await app.inject({
      method: 'POST',
      url: '/v1/channels/link-codes',
      headers: auth,
      payload: { provider: 'line' },
    });
    const before = sent.length;
    await deliver({
      type: 'message',
      source: { type: 'user', userId: 'Umama' },
      message: { type: 'text', id: '1', text: code.json<{ message: string }>().message },
    });
    await waitFor(() => texts(before).length > 0, 'linked');
  });

  afterAll(async () => {
    await harness?.close();
  });

  it('is ready as soon as it is invited, greets once, and does not cut in', async () => {
    const before = sent.length;
    await deliver({ type: 'join', source: { type: 'group', groupId: GROUP } });
    await waitFor(() => texts(before).length > 0, 'join');
    await new Promise((r) => setTimeout(r, 200));
    expect(texts(before)).toHaveLength(1);
    expect(texts(before)[0]).toContain('すぐに使えます');
    expect(texts(before)[0]).toContain('いまは覚えていません');
    expect(texts(before)[0]).not.toContain('このグループで使う');

    expect(await quiet(() => say('Umama', '今日の夕飯なににする？', false))).toEqual([]);
    // 連携していない人でも、追加の手順なしに使える
    expect(await ask('Upapa', '使い方')).not.toContain('連携');
    // 前の言い方で頼まれても、もう使えると答えるだけ
    expect(await ask('Upapa', 'このグループで使う')).toContain('すぐに使えます');
  });

  it('lets anyone in the group keep a shopping list, without reading unmentioned talk', async () => {
    expect(await ask('Upapa', '牛乳と卵を追加')).toBe(
      '牛乳・卵を買い物リストに足しました。（2 件）',
    );
    expect(await quiet(() => say('Upapa', '牛乳を追加', false))).toEqual([]);
    expect(await ask('Umama', '牛乳買った')).toBe('牛乳を買ったことにしました。残り: 卵');
    const rows = await withTenant(harness.db, tenantId, (tx) =>
      tx
        .selectFrom('shopping_items')
        .select(['name', 'added_by', 'bought_by'])
        .orderBy('created_at')
        .orderBy('id')
        .execute(),
    );
    expect(rows).toEqual([
      { name: '牛乳', added_by: 'パパ', bought_by: 'ママ' },
      { name: '卵', added_by: 'パパ', bought_by: null },
    ]);
  });

  it('collects dates and decides', async () => {
    expect(await ask('Umama', '旅行の日程調整 12/5 12/6')).toContain('「旅行」の候補');
    expect(await ask('Umama', '5日と6日ならOK')).toContain('ママさん:');
    expect(await ask('Upapa', '5日は無理')).toContain('パパさん:');
    expect(await ask('Umama', '決めて')).toMatch(
      /^「旅行」は 12\/6（.） に決めました（2\/2 人: ママ・パパ）。$/,
    );
  });

  it('shows the date poll on the group’s board, with counts and no names', async () => {
    const link = await ask('Umama', 'ボード');
    const token = /channels\/board\/([A-Za-z0-9_-]{32})$/.exec(link)![1]!;
    const res = await app.inject({ method: 'GET', url: `/v1/channels/board/${token}/state` });
    const view = res.json<{
      title: string;
      status: string;
      decided: string[];
      schedule: { voters: number; dates: { label: string; yes: number }[]; decided: string };
      events: { text: string }[];
    }>();
    expect(view.title).toBe('旅行の計画');
    expect(view.status).toBe('decided');
    expect(view.decided).toEqual([expect.stringMatching(/^日程: 12\/6（.）$/)]);
    expect(view.schedule.voters).toBe(2);
    expect(view.schedule.dates.map((d) => d.yes)).toEqual([1, 2]);
    expect(view.events.map((e) => e.text)).toEqual(
      expect.arrayContaining([
        '「旅行」の計画を作りました',
        '日程の候補を出しました（「旅行」）',
        expect.stringMatching(/^日程を 12\/6（.） に決めました$/),
      ]),
    );
    expect(JSON.stringify(view)).not.toMatch(/ママ|パパ|Umama|Upapa/);
  });

  it('reads receipt photos into the shared book once turned on, apart from the personal book', async () => {
    // 写真は自動で読むと決めるまで読まない
    expect(
      await quiet(() =>
        deliver({
          type: 'message',
          source: { type: 'group', groupId: GROUP, userId: 'Upapa' },
          message: { type: 'image', id: '9100001' },
        }),
      ),
    ).toEqual([]);
    expect(await ask('Umama', 'レシートを自動で読んで')).toContain('家計簿に付けます');
    const before = sent.length;
    await deliver({
      type: 'message',
      source: { type: 'group', groupId: GROUP, userId: 'Upapa' },
      message: { type: 'image', id: '9100002' },
    });
    await waitFor(() => texts(before).length > 0, 'receipt');
    expect(texts(before)[0]).toBe(
      '食費 ¥1,280を家計簿に付けました。今月の食費は ¥1,280です。違っていたら「取り消して」。',
    );
    const rows = await withTenant(harness.db, tenantId, (tx) =>
      tx.selectFrom('expenses').select(['household_id', 'recorded_by', 'amount']).execute(),
    );
    expect(rows).toEqual([
      { household_id: expect.any(String), recorded_by: 'パパ', amount: '1280.00' },
    ]);
    expect(await ask('Upapa', '家計簿を見せて')).toBe('今月の支出 ¥1,280\n・食費 ¥1,280');
  });

  it('lets the owner use the family list from the 1:1 chat, and posts to the group only after はい', async () => {
    const dmOwner = async (text: string) => {
      const before = sent.length;
      await deliver({
        type: 'message',
        source: { type: 'user', userId: 'Umama' },
        message: { type: 'text', id: String(8_100_000 + serial), text },
      });
      await waitFor(() => texts(before).length > 0, text);
      return texts(before)[0]!;
    };
    expect(await dmOwner('家族の買い物リスト')).toBe('買い物リスト（1 件）\n・卵');
    const ask = await dmOwner('卵を買っておいてを家族のグループに送って');
    expect(ask).toContain('を家族のグループに送ります。よろしいですか？');
    const before = sent.length;
    await deliver({
      type: 'message',
      source: { type: 'user', userId: 'Umama' },
      message: { type: 'text', id: String(8_200_000 + serial), text: 'はい' },
    });
    // グループへ送ってから、本人に「送りました」と返す
    await waitFor(() => texts(before).includes('グループに送りました。'), 'posted');
    const toGroup = sent.slice(before).find((s) => s.body['to'] === GROUP);
    expect(toGroup).toBeDefined();
    expect(JSON.stringify(toGroup!.body)).toContain('卵を買っておいて');
  });

  it('never reaches the owner’s personal work, mail or schedule from the group', async () => {
    const reply = await ask('Upapa', '今日のメールを要約して');
    expect(reply).toContain('個人の予定やメールは、このグループでは使いません');
    expect(reply).toContain('1:1 のトーク');
    const tasks = await app.inject({ method: 'GET', url: '/v1/tasks', headers: auth });
    expect(tasks.json<{ items: unknown[] }>().items).toEqual([]);
  });

  it('can be turned off only by the owner, and stays off when invited again', async () => {
    expect(await ask('Upapa', 'このグループをやめる')).toContain(
      'Genie を止められるのは、このグループの Genie の持ち主だけです',
    );
    expect(await ask('Umama', 'このグループをやめる')).toContain('やめました');
    expect(await ask('Upapa', '買い物リスト')).toContain('このグループでは Genie を止めています');
    expect(await quiet(() => say('Upapa', '牛乳を追加', false))).toEqual([]);

    // 外して招き直しても、勝手には再開しない
    const before = sent.length;
    await deliver({ type: 'join', source: { type: 'group', groupId: GROUP } });
    await waitFor(() => texts(before).length > 0, 'rejoin');
    expect(texts(before)[0]).toContain('このグループでは Genie を止めています');
    expect(await ask('Upapa', '買い物リスト')).toContain('このグループでは Genie を止めています');

    // 止めた持ち主の「再開」で、前のリストのまま戻る
    expect(await ask('Upapa', '再開')).toContain(
      '再開できるのは、このグループの Genie の持ち主だけ',
    );
    expect(await ask('Umama', '再開')).toContain('再開しました');
    expect(await ask('Upapa', '買い物リスト')).toBe('買い物リスト（1 件）\n・卵');
  });
});
