/**
 * チャット（Slack / LINE）から Genie へ、Genie からチャットへ。Slack / LINE の API は代役（fetch を捕まえる）。
 *
 * 見ること:
 *   - 署名の無い・違う配信は受けない
 *   - 連携していない人には連携の促しだけ。コードで結ぶと、以後の発話が仕事になる
 *   - 同じ配信は二度仕事にしない
 *   - 区切り（承認待ち・終わり）は 1 回ずつ返す。承認待ちのボタンは押した本人の連携でだけ効く
 *   - 「連携解除」で切れる
 *   ./infra/db/with-test-db.sh pnpm --filter @genie/service-api-gateway test
 */
import { createHmac } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { type TokenResponse, uuidv7 } from '@genie/contracts';
import { withTenant } from '@genie/db';
import { appendEvent } from '@genie/service-task';
import { phoneTaskFor, type OathraClient } from '@genie/service-phone';
import { makeTestApp, makeTokens, testDbConfig, type TestApp } from './support.js';
import type { App } from '../src/fastify.js';

const url = process.env['TEST_DATABASE_URL'];
const identityUrl = process.env['TEST_IDENTITY_DATABASE_URL'];

const SLACK_SECRET = 'slack-signing-secret';
const LINE_SECRET = 'line-channel-secret';

type Sent = { url: string; body: Record<string, unknown> };

describe.skipIf(!url)('chat channels', () => {
  let harness: TestApp;
  let app: App;
  let auth: { authorization: string };
  let tenantId: string;
  const sent: Sent[] = [];
  const fetchImpl = vi.fn(async (target: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    sent.push({ url: target, body });
    if (target.endsWith('conversations.open'))
      return Response.json({ ok: true, channel: { id: 'D-mention' } });
    if (target.startsWith('https://slack.com'))
      return Response.json({ ok: true, ts: `${sent.length}.0` });
    return Response.json({});
  });

  const texts = (since = 0) =>
    sent
      .slice(since)
      .map((s) =>
        String(
          s.body['text'] ??
            (s.body['messages'] as { text?: string }[] | undefined)?.[0]?.text ??
            '',
        ),
      );

  const waitFor = async (check: () => boolean, label: string) => {
    for (let i = 0; i < 100; i += 1) {
      if (check()) return;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error(`timed out: ${label}`);
  };

  const slackSigned = (raw: string, contentType = 'application/json') => {
    const ts = String(Math.floor(Date.now() / 1000));
    const signature =
      'v0=' + createHmac('sha256', SLACK_SECRET).update(`v0:${ts}:${raw}`).digest('hex');
    return {
      'content-type': contentType,
      'x-slack-request-timestamp': ts,
      'x-slack-signature': signature,
    };
  };

  let serial = 0;
  const slackDm = async (text: string, user = 'U1', eventId = `Ev${++serial}`) => {
    const raw = JSON.stringify({
      type: 'event_callback',
      team_id: 'T1',
      event_id: eventId,
      event_time: Math.floor(Date.now() / 1000),
      event: {
        type: 'message',
        channel_type: 'im',
        user,
        channel: `D-${user}`,
        ts: `17600000${String(serial).padStart(2, '0')}.000100`,
        text,
      },
    });
    return app.inject({
      method: 'POST',
      url: '/v1/channels/slack/events',
      headers: slackSigned(raw),
      payload: raw,
    });
  };

  const linkCode = async (provider: 'slack' | 'line') => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/channels/link-codes',
      headers: auth,
      payload: { provider },
    });
    expect(res.statusCode).toBe(201);
    return res.json<{ code: string; message: string }>();
  };

  const oathra = {
    salesContext: async () => ({
      products: [{ id: 'p-1', name: 'デモ商品' }],
      contacts: [{ id: 'c-1', name: '田中', company: null, callPermitted: true }],
    }),
  } as unknown as OathraClient;

  beforeAll(async () => {
    const tokens = await makeTokens();
    harness = await makeTestApp({
      dbConfig: testDbConfig(url!, identityUrl),
      tokens,
      phone: { taskFor: (_principal, text) => phoneTaskFor(text, oathra) },
      channels: {
        env: {
          SLACK_SIGNING_SECRET: SLACK_SECRET,
          SLACK_BOT_TOKEN: 'xoxb-test',
          LINE_CHANNEL_SECRET: LINE_SECRET,
          LINE_CHANNEL_ACCESS_TOKEN: 'line-token',
          GENIE_CHANNEL_ACTION_SECRET: 'a'.repeat(40),
        },
        fetchImpl: fetchImpl as unknown as typeof fetch,
      },
    });
    app = harness.app;
    const issued = await app.inject({
      method: 'POST',
      url: '/v1/auth/dev/token',
      payload: { email: `c-${uuidv7()}@example.com`, display_name: 'C' },
    });
    const access = issued.json<TokenResponse>().access_token;
    auth = { authorization: `Bearer ${access}` };
    tenantId = (
      JSON.parse(Buffer.from(access.split('.')[1]!, 'base64url').toString()) as { tid: string }
    ).tid;
  });

  afterAll(async () => {
    await harness?.close();
  });

  it('refuses unsigned or wrongly signed deliveries', async () => {
    const raw = JSON.stringify({ type: 'url_verification', challenge: 'c' });
    const unsigned = await app.inject({
      method: 'POST',
      url: '/v1/channels/slack/events',
      headers: { 'content-type': 'application/json' },
      payload: raw,
    });
    expect(unsigned.statusCode).toBe(403);
    const signed = await app.inject({
      method: 'POST',
      url: '/v1/channels/slack/events',
      headers: slackSigned(raw),
      payload: raw,
    });
    expect(signed.json()).toEqual({ challenge: 'c' });
    const line = await app.inject({
      method: 'POST',
      url: '/v1/channels/line/webhook',
      headers: { 'content-type': 'application/json', 'x-line-signature': 'bad' },
      payload: '{"destination":"Ubot","events":[]}',
    });
    expect(line.statusCode).toBe(403);
  });

  it('answers someone who is not linked with how to link, and starts no work', async () => {
    const before = sent.length;
    expect((await slackDm('競合を調べて', 'U-stranger')).statusCode).toBe(200);
    await waitFor(() => sent.length > before, 'link prompt');
    expect(texts(before)[0]).toContain('連携 XXXXXXXX');
    const tasks = await app.inject({ method: 'GET', url: '/v1/tasks', headers: auth });
    expect(tasks.json<{ items: unknown[] }>().items).toHaveLength(0);
  });

  it('links with a one-time code, then turns a message into one task even when Slack retries', async () => {
    const { message } = await linkCode('slack');
    let before = sent.length;
    await slackDm(message);
    await waitFor(() => sent.length > before, 'linked');
    expect(texts(before)[0]).toContain('連携しました');
    // 同じコードは二度使えない
    before = sent.length;
    await slackDm(message, 'U-other');
    await waitFor(() => sent.length > before, 'reused code');
    expect(texts(before)[0]).toContain('期限');

    const links = await app.inject({ method: 'GET', url: '/v1/channels/links', headers: auth });
    expect(links.json<{ items: { provider: string; posting_policy: string }[] }>().items).toEqual([
      expect.objectContaining({ provider: 'slack', posting_policy: 'summary_and_link' }),
    ]);

    before = sent.length;
    await slackDm('競合を調べて', 'U1', 'Ev-research');
    await slackDm('競合を調べて', 'U1', 'Ev-research');
    await waitFor(() => sent.length > before, 'accepted');
    await new Promise((r) => setTimeout(r, 100));
    expect(texts(before)).toEqual([expect.stringContaining('受け付けました')]);
    const tasks = await app.inject({ method: 'GET', url: '/v1/tasks', headers: auth });
    expect(tasks.json<{ items: { kind: string }[] }>().items.map((t) => t.kind)).toEqual([
      'research',
    ]);
  });

  it("asks for approval with buttons, accepts only the linked person's press, and reports the end once", async () => {
    let before = sent.length;
    await slackDm('田中さんにデモ商品の資料送付について営業電話をかけて', 'U1', 'Ev-sales');
    await waitFor(() => sent.length > before, 'sales accepted');
    expect(texts(before)[0]).toContain('受け付けました：営業電話: 田中');
    const tasks = await app.inject({ method: 'GET', url: '/v1/tasks', headers: auth });
    const task = tasks
      .json<{ items: { id: string; kind: string }[] }>()
      .items.find((t) => t.kind === 'phone.sales')!;

    // workflow の代わりに、承認待ちを起こす
    const approvalId = uuidv7();
    await withTenant(harness.db, tenantId, async (tx) => {
      await tx
        .insertInto('approvals')
        .values({
          id: approvalId,
          tenant_id: tenantId,
          task_id: task.id,
          step_index: 0,
          risk: 'EXTERNAL_COMMIT',
          summary: '田中さんに営業の電話をかけます',
          details: JSON.stringify([{ label: '相手', value: '田中' }]),
          status: 'PENDING',
          expires_at: new Date(Date.now() + 30 * 60_000),
        })
        .execute();
      await appendEvent(tx, {
        tenantId,
        streamKind: 'task',
        streamId: task.id,
        taskId: task.id,
        type: 'task.waiting_approval',
        payload: {
          approval_id: approvalId,
          risk: 'EXTERNAL_COMMIT',
          summary: '田中さんに営業の電話をかけます',
          primary_action_label: '電話をかける',
          expires_at: new Date(Date.now() + 30 * 60_000).toISOString(),
        },
      });
    });
    before = sent.length;
    await harness.channels!.service.pump();
    await harness.channels!.service.pump();
    const approvalMessages = sent
      .slice(before)
      .filter((s) => String(s.body['text']).includes('確認してください'));
    expect(approvalMessages).toHaveLength(1);
    expect(String(approvalMessages[0]!.body['text'])).toContain('・相手：田中');
    const blocks = approvalMessages[0]!.body['blocks'] as {
      elements?: { value: string; text: { text: string } }[];
    }[];
    const [approve, reject] = blocks[1]!.elements!;
    expect(approve!.text.text).toBe('電話をかける');

    const press = async (value: string, user: string, trigger: string) => {
      const raw = new URLSearchParams({
        payload: JSON.stringify({
          type: 'block_actions',
          trigger_id: trigger,
          user: { id: user, team_id: 'T1' },
          team: { id: 'T1' },
          channel: { id: `D-${user}` },
          actions: [{ value }],
        }),
      }).toString();
      return app.inject({
        method: 'POST',
        url: '/v1/channels/slack/interactions',
        headers: slackSigned(raw, 'application/x-www-form-urlencoded'),
        payload: raw,
      });
    };

    // 別の人が押しても、改ざんしても通らない
    before = sent.length;
    await press(approve!.value, 'U-stranger', 'trig-a');
    await press(reject!.value.replace('.R.', '.A.'), 'U1', 'trig-b');
    await waitFor(() => sent.length >= before + 2, 'refusals');
    expect(texts(before).every((t) => t.includes('操作できません'))).toBe(true);
    const pending = await app.inject({
      method: 'GET',
      url: `/v1/tasks/${task.id}/approvals`,
      headers: auth,
    });
    expect(pending.json<{ items: unknown[] }>().items).toHaveLength(1);

    before = sent.length;
    await press(approve!.value, 'U1', 'trig-c');
    await waitFor(() => sent.length > before, 'decided');
    expect(texts(before)[0]).toContain('承認しました');
    expect(harness.runtime.signals).toContainEqual(
      expect.objectContaining({ kind: 'approve', approvalId, decision: 'APPROVED' }),
    );
    // 二度押しは「もう済んでいる」
    before = sent.length;
    await press(approve!.value, 'U1', 'trig-d');
    await waitFor(() => sent.length > before, 'second press');
    expect(texts(before)[0]).toContain('もう済んでいます');

    await withTenant(harness.db, tenantId, (tx) =>
      appendEvent(tx, {
        tenantId,
        streamKind: 'task',
        streamId: task.id,
        taskId: task.id,
        type: 'task.completed',
        payload: { result_artifact_id: null, duration_ms: 1 },
      }),
    );
    before = sent.length;
    await harness.channels!.service.pump();
    await harness.channels!.service.pump();
    expect(texts(before)).toEqual([expect.stringContaining('終わりました：営業電話: 田中')]);
  });

  it('links LINE the same way and answers with the reply token', async () => {
    const { message } = await linkCode('line');
    const webhook = (event: Record<string, unknown>) => {
      const raw = JSON.stringify({
        destination: 'Ubot',
        events: [
          {
            mode: 'active',
            timestamp: Date.now(),
            source: { type: 'user', userId: 'Uline' },
            ...event,
          },
        ],
      });
      const signature = createHmac('sha256', LINE_SECRET).update(raw).digest('base64');
      return app.inject({
        method: 'POST',
        url: '/v1/channels/line/webhook',
        headers: { 'content-type': 'application/json', 'x-line-signature': signature },
        payload: raw,
      });
    };
    let before = sent.length;
    await webhook({
      type: 'message',
      webhookEventId: 'L1',
      replyToken: 'rt-1',
      message: { type: 'text', id: 'm1', text: message },
    });
    await waitFor(() => sent.length > before, 'line linked');
    expect(sent[before]).toMatchObject({
      url: 'https://api.line.me/v2/bot/message/reply',
      body: { replyToken: 'rt-1' },
    });
    expect(texts(before)[0]).toContain('連携しました');

    before = sent.length;
    await webhook({
      type: 'message',
      webhookEventId: 'L2',
      replyToken: 'rt-2',
      message: { type: 'text', id: 'm2', text: '半導体市場を調査して' },
    });
    await waitFor(() => sent.length > before, 'line accepted');
    expect(texts(before)[0]).toContain('受け付けました');
  });

  it('answers a Slack mention in the channel briefly and the work in a DM', async () => {
    const raw = JSON.stringify({
      type: 'event_callback',
      team_id: 'T1',
      event_id: 'Ev-mention',
      event_time: Math.floor(Date.now() / 1000),
      event: {
        type: 'app_mention',
        user: 'U1',
        channel: 'C-team',
        ts: '1760000100.000100',
        text: '<@UBOT> 競合を調べて',
      },
    });
    const before = sent.length;
    await app.inject({
      method: 'POST',
      url: '/v1/channels/slack/events',
      headers: slackSigned(raw),
      payload: raw,
    });
    await waitFor(
      () => sent.slice(before).some((s) => s.body['channel'] === 'D-mention'),
      'mention dm',
    );
    const channelPosts = sent.slice(before).filter((s) => s.body['channel'] === 'C-team');
    expect(channelPosts.map((s) => s.body['text'])).toEqual([
      '受け取りました。結果は DM でお返しします。',
    ]);
    const dm = sent.slice(before).find((s) => s.body['channel'] === 'D-mention')!;
    expect(String(dm.body['text'])).toContain('受け付けました');
  });

  it('unlinks with 「連携解除」 and then stops taking requests', async () => {
    let before = sent.length;
    await slackDm('連携解除');
    await waitFor(() => sent.length > before, 'unlinked');
    expect(texts(before)[0]).toContain('連携を解除しました');
    const links = await app.inject({ method: 'GET', url: '/v1/channels/links', headers: auth });
    expect(links.json<{ items: { provider: string }[] }>().items.map((l) => l.provider)).toEqual([
      'line',
    ]);
    before = sent.length;
    await slackDm('競合を調べて');
    await waitFor(() => sent.length > before, 'prompt after unlink');
    expect(texts(before)[0]).toContain('連携 XXXXXXXX');
  });
});
