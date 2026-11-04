/**
 * グループで頼まれた会議（「@Genie 明日15時から30分 打ち合わせ、Meet作って」）。LINE の API は代役。
 *
 * 見ること:
 *   - グループの誰が頼んでも、仕事は持ち主の会話に作られ、確認は持ち主の 1:1 トークへ行く
 *   - グループには「持ち主に確認しています」とだけ返す（承認のボタンはグループに出さない）
 *   - 入れたら Meet のリンクをグループへ 1 回だけ送る。見送ったら見送ったと送る
 *   - 会議の言い方でないメンションは、これまでどおり共有スペースへ
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
const LINE_SECRET = 'line-group-meeting-secret';
const GROUP = 'Cmeeting0001';
const NAMES: Record<string, string> = { Uowner: '持ち主', Ufriend: '田中' };
const MEET = 'https://meet.google.com/abc-defg-hij';

describe.skipIf(!url)('a meeting asked for in a LINE group, approved by the owner', () => {
  let harness: TestApp;
  let app: App;
  let auth: { authorization: string };
  let tenantId: string;
  let userId: string;
  const sent: { url: string; body: Record<string, unknown> }[] = [];
  const fetchImpl = vi.fn(async (target: string, init?: RequestInit) => {
    const member = /\/v2\/bot\/group\/[^/]+\/member\/([^/]+)$/.exec(target);
    if (member) return Response.json({ displayName: NAMES[member[1]!] ?? '誰か' });
    sent.push({
      url: target,
      body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
    });
    return Response.json({});
  });
  /** 送った先（push の to。返信は replyToken なので、どのトークへの返信かを replyTo で覚える） */
  const replyTo = new Map<string, string>();
  const messages = (since: number) =>
    sent
      .slice(since)
      .filter((s) => !s.url.endsWith('/chat/loading/start'))
      .map((s) => {
        const first = (
          s.body['messages'] as { text?: string; altText?: string }[] | undefined
        )?.[0];
        const to =
          typeof s.body['to'] === 'string'
            ? s.body['to']
            : (replyTo.get(String(s.body['replyToken'])) ?? '?');
        return { to, text: String(first?.text ?? first?.altText ?? '') };
      });
  const waitFor = async (check: () => boolean | Promise<boolean>, label: string) => {
    for (let i = 0; i < 500; i += 1) {
      if (await check()) return;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error(`timed out: ${label}`);
  };

  let serial = 0;
  const deliver = async (event: Record<string, unknown>, where: string) => {
    serial += 1;
    const replyToken = `reply-m-${String(serial)}`;
    replyTo.set(replyToken, where);
    const raw = JSON.stringify({
      destination: 'Ubot-meeting',
      events: [
        {
          mode: 'active',
          timestamp: Date.now(),
          webhookEventId: `01MEETING${String(serial).padStart(4, '0')}`,
          replyToken,
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
  const inGroup = (user: string, text: string) =>
    deliver(
      {
        type: 'message',
        source: { type: 'group', groupId: GROUP, userId: user },
        message: {
          type: 'text',
          id: String(8_000_000 + serial),
          text: `@Genie ${text}`,
          mention: { mentionees: [{ index: 0, length: 6, type: 'user', isSelf: true }] },
        },
      },
      GROUP,
    );

  const meetingTasks = async () =>
    withTenant(harness.db, tenantId, (tx) =>
      tx
        .selectFrom('tasks')
        .select(['id', 'kind', 'input', 'conversation_id', 'created_by'])
        .where('kind', '=', 'calendar.meeting')
        .orderBy('created_at')
        .execute(),
    );
  const finish = async (taskId: string, type: 'task.completed' | 'task.cancelled', md?: string) => {
    const artifact = md
      ? await harness.library.create({
          tenantId,
          ownerId: userId,
          type: 'DOCUMENT',
          title: '会議',
          mimeType: 'text/markdown',
          body: Buffer.from(md, 'utf8'),
          sourceTaskId: taskId,
        })
      : null;
    await withTenant(harness.db, tenantId, async (tx) => {
      await tx
        .updateTable('tasks')
        .set({
          status: type === 'task.completed' ? 'COMPLETED' : 'CANCELLED',
          result_artifact_id: artifact?.id ?? null,
        })
        .where('id', '=', taskId)
        .execute();
      await appendEvent(tx, {
        tenantId,
        streamKind: 'task',
        streamId: taskId,
        taskId,
        type,
        payload: artifact
          ? { result_artifact_id: artifact.id, duration_ms: 1 }
          : { reason: 'approval rejected' },
      });
    });
  };

  beforeAll(async () => {
    harness = await makeTestApp({
      dbConfig: testDbConfig(url!, identityUrl),
      tokens: await makeTokens(),
      understand: [],
      channels: {
        env: { LINE_CHANNEL_SECRET: LINE_SECRET, LINE_CHANNEL_ACCESS_TOKEN: 'line-token' },
        fetchImpl: fetchImpl as unknown as typeof fetch,
      },
    });
    app = harness.app;
    const issued = await app.inject({
      method: 'POST',
      url: '/v1/auth/dev/token',
      payload: { email: `meet-${uuidv7()}@example.com`, display_name: 'Owner' },
    });
    const access = issued.json<TokenResponse>().access_token;
    auth = { authorization: `Bearer ${access}` };
    const claims = JSON.parse(Buffer.from(access.split('.')[1]!, 'base64url').toString()) as {
      tid: string;
      sub: string;
    };
    tenantId = claims.tid;
    userId = claims.sub;
    // 持ち主だけが Genie と 1:1 で連携している
    const code = await app.inject({
      method: 'POST',
      url: '/v1/channels/link-codes',
      headers: auth,
      payload: { provider: 'line' },
    });
    const before = sent.length;
    await deliver(
      {
        type: 'message',
        source: { type: 'user', userId: 'Uowner' },
        message: { type: 'text', id: '1', text: code.json<{ message: string }>().message },
      },
      'Uowner',
    );
    await waitFor(() => messages(before).length > 0, 'linked');
    // グループに招く（持ち主のグループとして使い始める）
    await deliver({ type: 'join', source: { type: 'group', groupId: GROUP } }, GROUP);
    await inGroup('Uowner', 'このグループで使う');
    // 招かれたときの挨拶と「使う」への返事が、両方届いてから始める（後の頼みの返事と混ざらないように）
    await waitFor(() => messages(before).filter((m) => m.to === GROUP).length >= 2, 'group ready');
  });

  afterAll(async () => {
    await harness?.close();
  });

  it('asks the owner in 1:1, then sends the Meet link to the group once', async () => {
    let before = sent.length;
    // 頼んだのは連携していない友だち。仕事は持ち主のもの
    await inGroup('Ufriend', '明日15時から30分 打ち合わせ、Meet作って');
    await waitFor(async () => (await meetingTasks()).length === 1, 'meeting task');
    const [task] = await meetingTasks();
    expect(task!.created_by).toBe(userId);
    expect(task!.input).toMatchObject({
      title: '打ち合わせ',
      group_id: GROUP,
      group_provider: 'line',
      requested_by: '田中',
    });
    const input = task!.input as Record<string, string>;
    expect(input['start']).toMatch(/T15:00:00\+09:00$/);
    expect(input['end']).toMatch(/T15:30:00\+09:00$/);
    expect(input['when_label']).toMatch(/15:00〜15:30$/);
    await waitFor(
      () => messages(before).some((m) => m.to === GROUP && m.text.includes('持ち主に確認')),
      'group answer',
    );
    const toGroup = messages(before).filter((m) => m.to === GROUP);
    expect(toGroup.map((m) => m.text).join('\n')).toContain('持ち主に確認しています');
    // 持ち主の 1:1 に受付が届く（承認のカードもこのトークに出る）
    await harness.channels!.service.pump(tenantId);
    expect(messages(before).some((m) => m.to === 'Uowner')).toBe(true);
    // グループには承認のボタンを出さない
    expect(toGroup.map((m) => m.text).join('\n')).not.toContain('承認');

    // 入った → グループに Meet のリンク。もう一度見回っても送り直さない
    before = sent.length;
    await finish(
      task!.id,
      'task.completed',
      `予定「打ち合わせ」（${input['when_label']!}）をカレンダーに入れました。\nGoogle Meet: ${MEET}`,
    );
    await harness.channels!.service.pump(tenantId);
    await harness.channels!.service.pump(tenantId);
    const afterDone = messages(before);
    const groupLinks = afterDone.filter((m) => m.to === GROUP && m.text.includes(MEET));
    expect(groupLinks).toHaveLength(1);
    expect(afterDone.some((m) => m.to === 'Uowner')).toBe(true);
    before = sent.length;
    await harness.channels!.service.pump(tenantId);
    expect(messages(before)).toEqual([]);
  });

  it('tells the group when the owner turns it down', async () => {
    const before = sent.length;
    await inGroup('Ufriend', '11/30 10:00〜11:00 採用面談 Meetで');
    await waitFor(async () => (await meetingTasks()).length === 2, 'second meeting task');
    const task = (await meetingTasks())[1]!;
    expect(task.input).toMatchObject({ title: '採用面談' });
    await harness.channels!.service.pump(tenantId);
    await finish(task.id, 'task.cancelled');
    await harness.channels!.service.pump(tenantId);
    const toGroup = messages(before).filter((m) => m.to === GROUP);
    expect(toGroup.map((m) => m.text).join('\n')).toContain('持ち主が見送った');
  });

  it('leaves other mentions to the shared space', async () => {
    const before = await meetingTasks();
    await inGroup('Ufriend', '明日の会議は何時？');
    await new Promise((r) => setTimeout(r, 300));
    expect(await meetingTasks()).toHaveLength(before.length);
  });
});
