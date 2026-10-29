/**
 * グループの会話を文脈として覚え、呼ばれたときだけ答える（本人の設計 2026-10-28）。LINE・お店検索・モデルは代役。
 *
 * 見ること（受け入れの条件）:
 *   - 呼ばれなければ話さない（覚えるだけ）
 *   - 「ジーニー、」で始まる・Genie の返事への引用返信でも呼べる
 *   - 「土曜・夕方・新宿か渋谷」の流れから探す。人数は会話の人数で仮に置き、そう言う。候補は決定にしない
 *   - 送信を取り消した発言は使わない
 *   - モデルに渡すのはこのグループの会話だけ（名前は伏せる）
 *   - 一時停止中は覚えない・答えない。「忘れて」で消える
 *   - Webhook の再送で二度動かない
 *   ./infra/db/with-test-db.sh pnpm --filter @genie/service-api-gateway test
 */
import { createHmac } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { type TokenResponse, uuidv7 } from '@genie/contracts';
import { withTenant } from '@genie/db';
import { makeTestApp, makeTokens, testDbConfig, type TestApp } from './support.js';
import type { App } from '../src/fastify.js';

const url = process.env['TEST_DATABASE_URL'];
const identityUrl = process.env['TEST_IDENTITY_DATABASE_URL'];
const LINE_SECRET = 'line-group-context-secret';
const GROUP = 'Cfriends0001';
const NAMES: Record<string, string> = { Uaki: 'あき', Uben: 'ベン', Uchika: 'ちか' };

describe.skipIf(!url)('LINE group context (understand quietly, speak when called)', () => {
  let harness: TestApp;
  let app: App;
  let tenantId: string;
  const sent: { url: string; id: string; body: Record<string, unknown> }[] = [];
  const queries: string[] = [];
  let sentSerial = 0;
  const fetchImpl = vi.fn(async (target: string, init?: RequestInit) => {
    const member = /\/v2\/bot\/group\/[^/]+\/member\/([^/]+)$/.exec(target);
    if (member) return Response.json({ displayName: NAMES[member[1]!] ?? '誰か' });
    const id = `sent-${String(++sentSerial)}`;
    sent.push({
      url: target,
      id,
      body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
    });
    // LINE は送った吹き出しの ID を返す（引用返信の見分けに使う）
    return Response.json({ sentMessages: [{ id, quoteToken: 'q' }] });
  });
  const placesFetch = (async (_url: string, init?: RequestInit) => {
    queries.push((JSON.parse(String(init?.body)) as { textQuery: string }).textQuery);
    return Response.json({
      places: [
        { id: 'p1', displayName: { text: 'ラウンドワン 新宿' }, rating: 4.1 },
        { id: 'p2', displayName: { text: '新宿御苑' }, rating: 4.6 },
      ],
    });
  }) as typeof fetch;

  const replies = (since: number) =>
    sent.slice(since).filter((s) => !s.url.endsWith('/chat/loading/start'));
  const texts = (since: number) =>
    replies(since).map((s) =>
      String((s.body['messages'] as { text?: string }[] | undefined)?.[0]?.text ?? ''),
    );
  const waitFor = async (check: () => boolean, label: string) => {
    for (let i = 0; i < 500; i += 1) {
      if (check()) return;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error(`timed out: ${label}`);
  };

  let serial = 0;
  const deliver = async (event: Record<string, unknown>, eventId?: string) => {
    const raw = JSON.stringify({
      destination: 'Ubot-friends',
      events: [
        {
          mode: 'active',
          timestamp: Date.now(),
          webhookEventId: eventId ?? `01CONTEXT${String(++serial).padStart(4, '0')}`,
          replyToken: `reply-c-${String(serial)}`,
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
  const textEvent = (
    user: string,
    text: string,
    options: { mention?: boolean; quoted?: string; id?: string } = {},
  ) => ({
    type: 'message',
    source: { type: 'group', groupId: GROUP, userId: user },
    message: {
      type: 'text',
      id: options.id ?? String(5_000_000 + serial),
      text: options.mention ? `@Genie ${text}` : text,
      ...(options.mention
        ? { mention: { mentionees: [{ index: 0, length: 6, type: 'user', isSelf: true }] } }
        : {}),
      ...(options.quoted ? { quotedMessageId: options.quoted } : {}),
    },
  });
  /** 送って、返事を待つ（返事の吹き出しの本文）。 */
  const ask = async (
    user: string,
    text: string,
    options: { mention?: boolean; quoted?: string } = { mention: true },
  ) => {
    const before = sent.length;
    await deliver(textEvent(user, text, options));
    await waitFor(() => texts(before).length > 0, text);
    return texts(before)[0]!;
  };
  /** 送って、少し待っても返事が無いこと。 */
  const quiet = async (act: () => Promise<void>) => {
    const before = sent.length;
    await act();
    await new Promise((r) => setTimeout(r, 300));
    return texts(before);
  };
  const remembered = () =>
    withTenant(harness.db, tenantId, (tx) =>
      tx
        .selectFrom('group_messages')
        .select(['message_id', 'sender_id', 'text', 'from_genie', 'deleted_at'])
        .orderBy('sent_at')
        .orderBy('message_id')
        .execute(),
    );

  beforeAll(async () => {
    harness = await makeTestApp({
      dbConfig: testDbConfig(url!, identityUrl),
      tokens: await makeTokens(),
      understand: [],
      restaurants: { fetchImpl: placesFetch },
      channels: {
        env: { LINE_CHANNEL_SECRET: LINE_SECRET, LINE_CHANNEL_ACCESS_TOKEN: 'line-token' },
        fetchImpl: fetchImpl as unknown as typeof fetch,
      },
    });
    app = harness.app;
    const issued = await app.inject({
      method: 'POST',
      url: '/v1/auth/dev/token',
      payload: { email: `ctx-${uuidv7()}@example.com`, display_name: 'Aki' },
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
    const before = sent.length;
    await deliver({
      type: 'message',
      source: { type: 'user', userId: 'Uaki' },
      message: { type: 'text', id: '1', text: code.json<{ message: string }>().message },
    });
    await waitFor(() => texts(before).length > 0, 'linked');
  });

  afterAll(async () => {
    await harness?.close();
  });

  it('is usable right after the invite, but keeps no conversation until the group says so', async () => {
    const before = sent.length;
    await deliver({ type: 'join', source: { type: 'group', groupId: GROUP } });
    await waitFor(() => texts(before).length > 0, 'join');
    expect(texts(before)[0]).toContain('すぐに使えます');

    // 招かれただけでは覚えない
    expect(await quiet(() => deliver(textEvent('Uben', 'まだ覚えないでね')))).toEqual([]);
    expect(await remembered()).toEqual([]);
    // 覚えていないので「さっきの話」は、覚え方を案内する（作り話をしない）
    const past = await ask('Uchika', 'さっきの話まとめて');
    expect(past).toContain('さっきの会話は覚えていません');
    expect(harness.understander!.groupCalls).toEqual([]);

    // 設定は誰でも見られる
    expect(await ask('Uben', '設定')).toContain('呼ばれたときだけ');
    // 文脈を使うと決めたら、そのことを全員に知らせる
    const on = await ask('Uaki', '会話の文脈を使う');
    expect(on).toContain('7 日間覚えて');
    expect(on).toContain('呼ばれなければ話しかけません');
    expect(on).toContain('「@Genie 一時停止」');
    expect(await ask('Uben', '設定')).toContain('会話の文脈を使う');
  });

  it('keeps the conversation without speaking when nobody calls it', async () => {
    const said = await quiet(async () => {
      await deliver(textEvent('Uaki', '土曜ひま？どっか遊びに行かない？'));
      await deliver(textEvent('Uben', '夕方からならいける'));
      await deliver(textEvent('Uchika', '新宿か渋谷がいいな'));
    });
    expect(said).toEqual([]);
    // 呼びかけ（「@Genie 設定」はメンションを外した「設定」）と Genie の返事も文脈に入る。ここで見るのはふだんの会話
    const rows = (await remembered()).filter((r) => !r.from_genie && r.text !== '設定');
    expect(rows.map((r) => r.text)).toEqual([
      '土曜ひま？どっか遊びに行かない？',
      '夕方からならいける',
      '新宿か渋谷がいいな',
    ]);
    expect(harness.understander!.groupCalls).toEqual([]);
  });

  it('searches from the talk when called by name, saying the party size is assumed', async () => {
    const before = sent.length;
    const answer = await ask('Uben', 'ジーニー、いい感じの場所探して', {});
    expect(queries).toEqual(['新宿 駅 遊べる スポット']);
    expect(answer).toContain('新宿');
    expect(answer).toContain('17:00');
    expect(answer).toContain('3 人で仮に置いた');
    // 「新宿か渋谷」は希望。決めたことにせず、もう一方に替える言い方を添える
    expect(answer).toContain('新宿か渋谷の話だったので、まず新宿で探したよ');
    const messages = replies(before)[0]!.body['messages'] as { type: string }[];
    expect(messages.map((m) => m.type)).toEqual(['text', 'flex']);
  });

  it('puts the plan on a board the group can open, and updates it from the chat', async () => {
    // 探したときのカードに「みんなの計画を見る」が付いている
    const searched = sent.filter((x) => JSON.stringify(x.body).includes('みんなの計画を見る'));
    expect(searched).toHaveLength(1);
    const token = /channels\/board\/([A-Za-z0-9_-]{32})/.exec(
      JSON.stringify(searched[0]!.body),
    )![1]!;
    const state = async () => {
      const res = await app.inject({ method: 'GET', url: `/v1/channels/board/${token}/state` });
      expect(res.statusCode).toBe(200);
      return res.json<{
        title: string;
        status: string;
        wants: string[];
        decided: string[];
        open: string[];
        candidates: { name: string; chosen: boolean }[];
        events: { text: string }[];
      }>();
    };
    const first = await state();
    expect(first.title).toBe('新宿でお出かけ');
    expect(first.status).toBe('planning');
    expect(first.wants).toEqual(
      expect.arrayContaining(['場所: 新宿か渋谷（希望）', '遊べる場所', '3 人（仮）']),
    );
    expect(first.decided).toEqual([]);
    expect(first.open).toEqual(
      expect.arrayContaining(['行く場所を候補から決める', '人数を確かめる（いまは 3 人で仮置き）']),
    );
    expect(first.candidates.map((c) => c.name)).toEqual(['ラウンドワン 新宿', '新宿御苑']);
    // ページに、発言の本文・名前・LINE の ID は出ない
    expect(JSON.stringify(first)).not.toMatch(/土曜ひま|夕方から|Uaki|Uben|Uchika|あき|ベン|ちか/);

    // グループで選ぶと、ボードの「決まったこと」に載り、何が起きたかが残る
    const chosen = await ask('Uaki', '2番目にする');
    expect(chosen).toContain('新宿御苑');
    expect(chosen).toContain('みんなの計画にも「決まったこと」として載せました');
    const after = await state();
    expect(after.decided).toEqual(['場所: 新宿御苑']);
    expect(after.candidates.find((c) => c.chosen)?.name).toBe('新宿御苑');
    expect(after.open).toContain('予約する（Genie はまだ予約していません）');
    expect(after.events.map((e) => e.text)).toEqual(
      expect.arrayContaining([
        '行く場所を「新宿御苑」にしました',
        'Genie が新宿で 2 件の候補を探しました',
        '「新宿でお出かけ」の計画を作りました',
      ]),
    );
    expect(queries).toHaveLength(1);

    // 「@Genie ボード」で、いつでもリンクを出す。ページは読むだけ
    expect(await ask('Uben', 'ボード')).toMatch(
      /^「新宿でお出かけ」のボードです。.*\nhttps:\/\/genie\.test\/v1\/channels\/board\/[A-Za-z0-9_-]{32}$/s,
    );
    const page = await app.inject({ method: 'GET', url: `/v1/channels/board/${token}` });
    expect(page.statusCode).toBe(200);
    expect(page.headers['x-robots-tag']).toBe('noindex');
    expect(
      (await app.inject({ method: 'GET', url: `/v1/channels/board/${'Z'.repeat(32)}/state` }))
        .statusCode,
    ).toBe(410);
    // LINE の中で開く入口（LIFF）。liff.state のリンクのページへ移るだけ。変な値は使えないページ
    const entry = await app.inject({
      method: 'GET',
      url: `/v1/channels/board?liff.state=${encodeURIComponent(`/${token}?openExternalBrowser=1`)}`,
    });
    expect(entry.statusCode).toBe(200);
    expect(entry.body).toContain(`location.replace("/v1/channels/board/${token}")`);
    for (const bad of [
      '',
      '?liff.state=%2Fshort',
      `?liff.state=${encodeURIComponent('//evil.example/' + token)}`,
    ])
      expect(
        (await app.inject({ method: 'GET', url: `/v1/channels/board${bad}` })).statusCode,
      ).toBe(410);
  });

  it('answers a quoted reply to its own message, from this group’s talk only, without names', async () => {
    // Genie の返事は、送ったあとで覚える（送った ID が要るため）
    let genieMessage = (await remembered()).find((r) => r.from_genie && r.text.includes('新宿'));
    for (let i = 0; i < 100 && !genieMessage; i += 1) {
      await new Promise((r) => setTimeout(r, 20));
      genieMessage = (await remembered()).find((r) => r.from_genie && r.text.includes('新宿'));
    }
    expect(genieMessage?.text).toContain('新宿');
    harness.understander!.groupAnswer =
      '決まったこと: なし\nまだ決まっていないこと: 新宿か渋谷\n次にやること: 場所を決める';
    const answer = await ask('Uchika', 'これまとめて', { quoted: genieMessage!.message_id });
    expect(answer).toContain('まだ決まっていないこと: 新宿か渋谷');
    const call = harness.understander!.groupCalls.at(-1)!;
    expect(call.request).toContain('決まったこと・まだ決まっていないこと');
    const speakers = new Set(call.transcript.map((l) => l.speaker));
    expect([...speakers].sort()).toEqual(['Genie', 'メンバーA', 'メンバーB', 'メンバーC']);
    // 名前・LINE の ID は渡さない
    expect(JSON.stringify(call)).not.toMatch(/Uaki|Uben|Uchika|あき|ベン|ちか/);

    // Genie 以外の発言への引用返信では呼ばれない
    const first = (await remembered()).find((r) => !r.from_genie)!;
    expect(
      await quiet(() => deliver(textEvent('Uaki', 'それね', { quoted: first.message_id }))),
    ).toEqual([]);
  });

  it('sends a free answer without Markdown symbols showing in LINE', async () => {
    // 2026-10-28 の実機: ドライブの案が「**8:30 竹ノ塚出発**」のまま届いた
    const previous = harness.understander!.groupAnswer;
    harness.understander!.groupAnswer =
      '## 日帰りの案\n- **8:30 出発** → 海へ\n- **12:00 昼ごはん**\n\n目安にしてね。';
    const before = sent.length;
    await deliver(textEvent('Uaki', 'ドライブの日帰りプラン作って', { mention: true }));
    await waitFor(() => replies(before).length > 0, 'free answer');
    const body = JSON.stringify(replies(before)[0]!.body);
    expect(body).toContain('8:30 出発');
    expect(body).not.toContain('**');
    expect(body).not.toContain('## ');
    harness.understander!.groupAnswer = previous;
  });

  it('does not use a message after it is unsent', async () => {
    await quiet(() => deliver(textEvent('Uben', '暗証番号は4821だよ', { id: '6600001' })));
    expect((await remembered()).some((r) => r.text.includes('4821'))).toBe(true);
    await deliver({
      type: 'unsend',
      source: { type: 'group', groupId: GROUP, userId: 'Uben' },
      unsend: { messageId: '6600001' },
    });
    let row = (await remembered()).find((r) => r.message_id === '6600001')!;
    for (let i = 0; i < 100 && row.deleted_at === null; i += 1) {
      await new Promise((r) => setTimeout(r, 20));
      row = (await remembered()).find((r) => r.message_id === '6600001')!;
    }
    expect(row.text).toBe('');
    expect(row.deleted_at).not.toBeNull();
    await ask('Uaki', '今の話まとめて');
    expect(JSON.stringify(harness.understander!.groupCalls.at(-1))).not.toContain('4821');
  });

  it('runs once when LINE redelivers the same event', async () => {
    const calls = harness.understander!.groupCalls.length;
    const before = sent.length;
    const event = textEvent('Uchika', 'ジーニー、まとめて');
    await deliver(event, '01CONTEXTREDELIVER');
    await deliver({ ...event, deliveryContext: { isRedelivery: true } }, '01CONTEXTREDELIVER');
    await waitFor(() => texts(before).length > 0, 'redelivered');
    await new Promise((r) => setTimeout(r, 300));
    expect(texts(before)).toHaveLength(1);
    expect(harness.understander!.groupCalls.length).toBe(calls + 1);
  });

  it('stops keeping and speaking while paused, and forgets on request', async () => {
    expect(await ask('Uaki', '一時停止')).toContain('一時停止しました');
    const count = (await remembered()).length;
    expect(
      await quiet(async () => {
        await deliver(textEvent('Uben', '日曜でもいいよ'));
        await deliver(textEvent('Uchika', 'ジーニー、まとめて'));
      }),
    ).toEqual([]);
    // 一時停止中の発言は覚えていない（一時停止の知らせを Genie が言った分だけ増える）
    const paused = await remembered();
    expect(paused.some((r) => r.text.includes('日曜'))).toBe(false);
    expect(paused.length).toBeLessThanOrEqual(count + 1);

    // 再開すると、止める前の覚え方（文脈を使う）に戻る
    expect(await ask('Uaki', '再開')).toContain('覚えて');
    expect(await ask('Uaki', '今の話忘れて')).toBe('覚えていたこのグループの会話を消しました。');
    const left = (await remembered()).filter((r) => r.deleted_at === null);
    // 残るのは、消したと伝えた Genie の返事だけ
    expect(left.every((r) => r.from_genie)).toBe(true);
    expect(left.some((r) => r.text.includes('新宿'))).toBe(false);
  });

  it('deletes what is past the keep period, not just hides it', async () => {
    const household = await withTenant(harness.db, tenantId, (tx) =>
      tx.selectFrom('group_messages').select('household_id').executeTakeFirstOrThrow(),
    );
    await withTenant(harness.db, tenantId, (tx) =>
      tx
        .insertInto('group_messages')
        .values({
          tenant_id: tenantId,
          household_id: household.household_id,
          message_id: 'old-1',
          sender_id: 'Uaki',
          text: '先月の話',
          quoted_message_id: null,
          from_genie: false,
          sent_at: new Date(Date.now() - 8 * 86_400_000),
          expires_at: new Date(Date.now() - 86_400_000),
        })
        .execute(),
    );
    await quiet(() => deliver(textEvent('Uben', '了解')));
    let rows = await remembered();
    for (let i = 0; i < 100 && rows.some((r) => r.message_id === 'old-1'); i += 1) {
      await new Promise((r) => setTimeout(r, 20));
      rows = await remembered();
    }
    expect(rows.some((r) => r.message_id === 'old-1')).toBe(false);
    expect(rows.some((r) => r.text === '了解')).toBe(true);
  });
});
