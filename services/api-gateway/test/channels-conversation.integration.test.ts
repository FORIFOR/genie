/**
 * チャットでの会話（あいさつ・質問）は「受け付けました」を返さず、答えの文をそのまま返す。
 * 調べもの・操作などの仕事は、これまでどおり受付を返す。LINE の API は代役。
 *   ./infra/db/with-test-db.sh pnpm --filter @genie/service-api-gateway test
 */
import { createHmac } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { type TokenResponse, uuidv7 } from '@genie/contracts';
import { withTenant } from '@genie/db';
import { appendEvent } from '@genie/service-task';
import { makeTestApp, makeTokens, testDbConfig, type TestApp } from './support.js';
import type { App } from '../src/fastify.js';

const url = process.env['TEST_DATABASE_URL'];
const identityUrl = process.env['TEST_IDENTITY_DATABASE_URL'];
const LINE_SECRET = 'line-conversation-secret';

describe.skipIf(!url)('chat conversation in LINE', () => {
  let harness: TestApp;
  let app: App;
  let auth: { authorization: string };
  let tenantId: string;
  let userId: string;
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
      destination: 'Ubot-conversation',
      events: [
        {
          type: 'message',
          mode: 'active',
          timestamp: Date.now(),
          webhookEventId: `01CONVERSATION${String(++serial).padStart(4, '0')}`,
          replyToken: `reply-c-${String(serial)}`,
          source: { type: 'user', userId: 'Uconversation' },
          message: { type: 'text', id: String(8_000_000 + serial), text },
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
  const done = new Set<string>();
  const tasks = async () =>
    (await app.inject({ method: 'GET', url: '/v1/tasks', headers: auth })).json<{
      items: { id: string; kind: string }[];
    }>().items;

  /** 仕事の結果（答えの文書）を置いて、終わったことにする。 */
  const complete = async (taskId: string, markdown: string, mimeType = 'text/markdown') => {
    const artifact = await harness.library.create({
      tenantId,
      ownerId: userId,
      type: 'DOCUMENT',
      title: '答え',
      mimeType,
      body: Buffer.from(markdown, 'utf8'),
      sourceTaskId: taskId,
    });
    await withTenant(harness.db, tenantId, async (tx) => {
      await tx
        .updateTable('tasks')
        .set({ status: 'COMPLETED', result_artifact_id: artifact.id })
        .where('id', '=', taskId)
        .execute();
      await appendEvent(tx, {
        tenantId,
        streamKind: 'task',
        streamId: taskId,
        taskId,
        type: 'task.completed',
        payload: { result_artifact_id: artifact.id, duration_ms: 1 },
      });
    });
  };

  beforeAll(async () => {
    harness = await makeTestApp({
      dbConfig: testDbConfig(url!, identityUrl),
      tokens: await makeTokens(),
      seedPlugins: true,
      channels: {
        env: { LINE_CHANNEL_SECRET: LINE_SECRET, LINE_CHANNEL_ACCESS_TOKEN: 'line-token' },
        fetchImpl: fetchImpl as unknown as typeof fetch,
      },
    });
    app = harness.app;
    const issued = await app.inject({
      method: 'POST',
      url: '/v1/auth/dev/token',
      payload: { email: `cv-${uuidv7()}@example.com`, display_name: 'CV' },
    });
    const access = issued.json<TokenResponse>().access_token;
    auth = { authorization: `Bearer ${access}` };
    const claims = JSON.parse(Buffer.from(access.split('.')[1]!, 'base64url').toString()) as {
      tid: string;
      sub: string;
    };
    tenantId = claims.tid;
    userId = claims.sub;
    // 会話（chat lane）は General Assistant の仕事になる
    await app.inject({
      method: 'POST',
      url: '/v1/plugins/com.astra.general/install',
      headers: auth,
      payload: { version: '0.1.0', granted_scopes: ['artifacts.read', 'artifacts.write'] },
    });
    const code = await app.inject({
      method: 'POST',
      url: '/v1/channels/link-codes',
      headers: auth,
      payload: { provider: 'line' },
    });
    const before = sent.length;
    await line(code.json<{ message: string }>().message);
    await waitFor(() => texts(before).length > 0, 'linked');
    expect(texts(before)[0]).toContain('連携しました');
  });

  afterAll(async () => {
    await harness?.close();
  });

  it('answers a greeting with the answer itself, without 「受け付けました」', async () => {
    const before = sent.length;
    await line('こんにちは');
    let chat: { id: string; kind: string } | undefined;
    for (let i = 0; i < 250 && !chat; i += 1) {
      chat = (await tasks())[0];
      if (!chat) await new Promise((r) => setTimeout(r, 20));
    }
    expect(chat).toBeDefined();
    done.add(chat!.id);
    // 受付を送る処理が走り終わるのを待つ（走っても何も送らないことを見る）
    await new Promise((r) => setTimeout(r, 200));
    // 受付は送らない
    expect(texts(before)).toEqual([]);

    await complete(chat!.id, '# こんにちは\n\nこんにちは！今日は何をしましょうか？');
    await harness.channels!.service.pump(tenantId);
    await harness.channels!.service.pump(tenantId);
    expect(texts(before)).toEqual(['こんにちは！今日は何をしましょうか？']);
  });

  it('reads the spoken sentence of an info card (news, weather) instead of 「作業一覧で開けます」', async () => {
    const before = sent.length;
    await line('今日はどんな日？');
    let chat: { id: string; kind: string } | undefined;
    for (let i = 0; i < 250 && !chat; i += 1) {
      chat = (await tasks()).find((t) => t.kind !== 'research' && !done.has(t.id));
      if (!chat) await new Promise((r) => setTimeout(r, 20));
    }
    done.add(chat!.id);
    await complete(
      chat!.id,
      JSON.stringify({ kind: 'news', text: '主なニュースは 3 件です。', items: [] }),
      'application/vnd.genie.info+json',
    );
    await harness.channels!.service.pump(tenantId);
    expect(texts(before)).toEqual(['主なニュースは 3 件です。']);
  });

  it('still acknowledges a request to look something up with 「承知しました」, and reports the end', async () => {
    const before = sent.length;
    await line('競合を調べて');
    await waitFor(() => texts(before).length > 0, 'accepted');
    expect(texts(before)[0]).toContain('承知しました');
    expect((await tasks()).map((t) => t.kind)).toContain('research');
  });
});
