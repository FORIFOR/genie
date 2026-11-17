/**
 * LINE に写真・外国語の文を送るだけで、Genie が判断する。LINE の API とモデルは代役。
 *
 * 見ること:
 *   - レシートの写真 → 家計簿に付く（DB に行ができる）→ 「取り消して」で取り消せる
 *   - 同じレシートをもう一度送っても、二度は付かない
 *   - 案内の写真 → 予定に入れるか聞く → 「はい」で、カレンダーの頼みとして仕事になる
 *   - 外国語の文 → 日本語で返す
 *   - 音声は、まだ読めないと答える
 *   - Task Dock（HTTP）からも「家計簿を見せて」が効く
 *   ./infra/db/with-test-db.sh pnpm --filter @genie/service-api-gateway test
 */
import { createHmac } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { type TokenResponse, uuidv7 } from '@genie/contracts';
import { withTenant } from '@genie/db';
import { sql } from 'kysely';
import type { Understanding } from '@genie/service-understand';
import { makeTestApp, makeTokens, testDbConfig, type TestApp } from './support.js';
import type { App } from '../src/fastify.js';

const url = process.env['TEST_DATABASE_URL'];
const identityUrl = process.env['TEST_IDENTITY_DATABASE_URL'];
const LINE_SECRET = 'line-understand-secret';

const blank: Understanding = {
  kind: 'other',
  intent: 'explain',
  confidence: 0.95,
  source_language: 'ja',
  summary_ja: '',
  translation_ja: null,
  receipt: null,
  meal: null,
  event: null,
  request_ja: null,
  question_ja: null,
};
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tokyo' }).format(new Date());
const receipt: Understanding = {
  ...blank,
  kind: 'receipt',
  intent: 'record_expense',
  confidence: 0.97,
  receipt: {
    merchant: 'テストスーパー',
    date: today,
    total: 2480,
    currency: 'JPY',
    category: '食費',
    items_sum: 2480,
  },
};

describe.skipIf(!url)('send a photo, Genie decides', () => {
  let harness: TestApp;
  let app: App;
  let auth: { authorization: string };
  let tenantId: string;
  const sent: { url: string; body: Record<string, unknown> }[] = [];
  const fetchImpl = vi.fn(async (target: string, init?: RequestInit) => {
    if (target.startsWith('https://api-data.line.me/')) {
      // 写真ごとに違う中身（同じ写真の指紋で二度付けを見分けるので）
      const id = target.split('/').at(-2) ?? '';
      return new Response(new TextEncoder().encode(`jpeg-${id}`), {
        headers: { 'content-type': 'image/jpeg' },
      });
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
  const line = async (message: Record<string, unknown>) => {
    const raw = JSON.stringify({
      destination: 'Ubot-understand',
      events: [
        {
          type: 'message',
          mode: 'active',
          timestamp: Date.now(),
          webhookEventId: `01UNDERSTAND${String(++serial).padStart(4, '0')}`,
          replyToken: `reply-${String(serial)}`,
          source: { type: 'user', userId: 'Uunderstand' },
          message: { id: String(9_000_000 + serial), ...message },
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
  /** 送って、返事が 1 通来るまで待つ。 */
  const say = async (message: Record<string, unknown>) => {
    const before = sent.length;
    await line(message);
    await waitFor(() => texts(before).length > 0, `reply to ${JSON.stringify(message)}`);
    return texts(before)[0]!;
  };
  const photo = () => say({ type: 'image' });

  const expenses = () =>
    withTenant(harness.db, tenantId, (tx) =>
      tx.selectFrom('expenses').select(['amount', 'category', 'voided_at']).execute(),
    );

  beforeAll(async () => {
    harness = await makeTestApp({
      dbConfig: testDbConfig(url!, identityUrl),
      tokens: await makeTokens(),
      understand: [
        receipt,
        receipt,
        {
          ...blank,
          kind: 'event',
          intent: 'add_event',
          event: {
            title: '保護者会',
            date: '2026-11-12',
            start_time: '10:00',
            end_time: null,
            place: '体育館',
          },
        },
        {
          ...blank,
          kind: 'message',
          intent: 'translate',
          source_language: 'en',
          translation_ja: '悪天候のため、出発が約2時間遅れています。',
        },
      ],
      channels: {
        env: { LINE_CHANNEL_SECRET: LINE_SECRET, LINE_CHANNEL_ACCESS_TOKEN: 'line-token' },
        fetchImpl: fetchImpl as unknown as typeof fetch,
      },
    });
    app = harness.app;
    const issued = await app.inject({
      method: 'POST',
      url: '/v1/auth/dev/token',
      payload: { email: `u-${uuidv7()}@example.com`, display_name: 'U' },
    });
    const access = issued.json<TokenResponse>().access_token;
    auth = { authorization: `Bearer ${access}` };
    tenantId = (
      JSON.parse(Buffer.from(access.split('.')[1]!, 'base64url').toString()) as { tid: string }
    ).tid;
    const code = await app.inject({
      method: 'POST',
      url: '/v1/channels/link-codes',
      headers: auth,
      payload: { provider: 'line' },
    });
    expect(await say({ type: 'text', text: code.json<{ message: string }>().message })).toContain(
      '連携しました',
    );
  });

  afterAll(async () => {
    await harness?.close();
  });

  it('records a receipt photo, refuses the same receipt twice, and undoes it', async () => {
    expect(await photo()).toBe(
      '食費 ¥2,480を家計簿に付けました。今月の食費は ¥2,480です。違っていたら「取り消して」。',
    );
    // 写真は LINE の content から取った
    expect(fetchImpl.mock.calls.some(([u]) => String(u).includes('api-data.line.me'))).toBe(true);
    expect(await expenses()).toMatchObject([
      { amount: '2480.00', category: '食費', voided_at: null },
    ]);

    // 別の写真でも、店・日付・合計が同じなら同じレシート
    expect(await photo()).toContain('このレシートはもう付けてあります');
    expect(await expenses()).toHaveLength(1);

    expect(await say({ type: 'text', text: '取り消して' })).toContain('を取り消しました。');
    const rows = await expenses();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.voided_at).not.toBeNull();
  });

  it('asks before putting an event in the calendar, and makes it a task on はい', async () => {
    expect(await photo()).toBe(
      '予定を見つけました: 保護者会\n2026-11-12 10:00〜（体育館）\nカレンダーに入れますか？ はい / いいえ',
    );
    const before = sent.length;
    await line({ type: 'text', text: 'はい' });
    await waitFor(() => texts(before).length > 0, 'calendar request');
    // ここから先はいつもの仕事の流れ（試験の環境には担当のエージェントが居ないので、そう答える）
    expect(texts(before)[0]).toBe(
      'General Assistant が追加されていません。Apps から追加してください。',
    );
    // 「はい」は、カレンダーへの頼みとして振り分け直される（家計簿や予約の答えにはならない）
    const rows = await withTenant(harness.db, tenantId, (tx) =>
      tx
        .selectFrom('turns')
        .select(['role', sql<string>`content->>'text'`.as('text')])
        .where(sql`content->>'text'`, 'like', 'カレンダーに予定を入れて:%')
        .execute(),
    );
    expect(rows).toEqual([
      { text: 'カレンダーに予定を入れて: 保護者会 2026-11-12 10:00〜 場所: 体育館', role: 'user' },
    ]);
  });

  it('answers a foreign message in Japanese', async () => {
    expect(
      await say({ type: 'text', text: 'Your flight has been delayed by approximately two hours.' }),
    ).toBe('英語 → 日本語\n悪天候のため、出発が約2時間遅れています。');
    expect(await say({ type: 'text', text: 'これに返信して' })).toBe(
      '返信の案（英語）:\nSure, see you then.',
    );
  });

  it('says plainly that voice messages cannot be read yet', async () => {
    expect(await say({ type: 'audio', duration: 3000 })).toBe(
      '音声・動画・ファイルはまだ読めません。写真か文字で送ってください。',
    );
  });

  it('shows the household book from the Task Dock as well', async () => {
    const conversation = await app.inject({
      method: 'POST',
      url: '/v1/conversations',
      headers: auth,
      payload: {},
    });
    const id = conversation.json<{ id: string }>().id;
    const turn = await app.inject({
      method: 'POST',
      url: `/v1/conversations/${id}/turns`,
      headers: { ...auth, 'idempotency-key': uuidv7() },
      payload: { text: '家計簿を見せて', modality: 'text' },
    });
    expect(turn.statusCode).toBeLessThan(300);
    expect(JSON.stringify(turn.json())).toContain('今月の家計簿はまだ空です');
  });
});
