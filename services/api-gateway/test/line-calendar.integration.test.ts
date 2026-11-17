/**
 * チャットでの会話（あいさつ・質問）は「受け付けました」を返さず、答えの文をそのまま返す。
 * 調べもの・操作などの仕事は、これまでどおり受付を返す。LINE の API は代役。
 *   ./infra/db/with-test-db.sh pnpm --filter @genie/service-api-gateway test
 */
import { createHmac } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { canonicalSha256, type TokenResponse, uuidv7 } from '@genie/contracts';
import { withTenant } from '@genie/db';
import { appendEvent } from '@genie/service-task';
import { AgentHostService, HostBridge as HostStepBridge } from '@genie/service-agent-host';
import { makeTestApp, makeTokens, testDbConfig, type TestApp } from './support.js';
import type { App } from '../src/fastify.js';

const url = process.env['TEST_DATABASE_URL'];
const identityUrl = process.env['TEST_IDENTITY_DATABASE_URL'];
const LINE_SECRET = 'line-calendar-secret';

describe.skipIf(!url)('calendar in LINE: read, move with approval, undo (spec v1.0 §11)', () => {
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
      // カード（Flex Message）は、通知・一覧に出る文（altText）で読む
      .map((s) => {
        const first = (
          s.body['messages'] as { text?: string; altText?: string }[] | undefined
        )?.[0];
        return String(first?.text ?? first?.altText ?? '');
      });
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
      destination: 'Ubot-calendar',
      events: [
        {
          type: 'message',
          mode: 'active',
          timestamp: Date.now(),
          webhookEventId: `01CALENDAR${String(++serial).padStart(4, '0')}`,
          replyToken: `reply-cal-${String(serial)}`,
          source: { type: 'user', userId: 'Ucalendarperson' },
          message: { type: 'text', id: String(9_100_000 + serial), text },
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
      // 2026-10-27（火）09:30 JST。「明日」は 10/28
      calendar: { now: () => new Date('2026-10-27T00:30:00Z') },
      // 写真・家計簿の決まった言い方（「レシートを家計簿に」）。写真は読まない
      understand: [],
      // お店探し（Google Places の代役）
      restaurants: {
        now: () => new Date('2026-10-27T00:30:00Z'),
        fetchImpl: (async () =>
          Response.json({
            places: [
              {
                id: 'p1',
                displayName: { text: '焼き鳥 とり新' },
                rating: 4.1,
                userRatingCount: 520,
                googleMapsUri: 'https://maps.google.com/?cid=p1',
                websiteUri: 'https://example.com/p1',
                nationalPhoneNumber: '03-1234-5678',
                reservable: true,
              },
            ],
          })) as unknown as typeof fetch,
      },
      channels: {
        env: {
          LINE_CHANNEL_SECRET: LINE_SECRET,
          LINE_CHANNEL_ACCESS_TOKEN: 'line-token',
          GENIE_LINE_ORCA_PROJECT: '/projects/app',
        },
        fetchImpl: fetchImpl as unknown as typeof fetch,
      },
    });
    app = harness.app;
    const issued = await app.inject({
      method: 'POST',
      url: '/v1/auth/dev/token',
      payload: { email: `cal-${uuidv7()}@example.com`, display_name: 'Cal' },
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

  const taskRow = async (id: string) =>
    withTenant(harness.db, tenantId, (tx) =>
      tx
        .selectFrom('tasks')
        .select(['kind', 'input', 'status'])
        .where('id', '=', id)
        .executeTakeFirstOrThrow(),
    );
  const newest = async (kind: string, seen: Set<string>) => {
    for (let i = 0; i < 250; i += 1) {
      const found = (await tasks()).find((t) => t.kind === kind && !seen.has(t.id));
      if (found) {
        seen.add(found.id);
        return found;
      }
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error(`no ${kind} task`);
  };

  it('reads tomorrow, moves the meeting to the afternoon with approval, then puts it back', async () => {
    const seen = new Set<string>();
    // 1. 明日の予定 → 予定の一覧を読む仕事（受付は送らない）
    let before = sent.length;
    await line('明日の予定教えて');
    const agenda = await newest('calendar.agenda', seen);
    expect((await taskRow(agenda.id)).input).toMatchObject({
      time_min: '2026-10-28T00:00:00+09:00',
      time_max: '2026-10-29T00:00:00+09:00',
      label: '明日',
    });
    expect(texts(before)).toEqual([]);
    // 端末が読んだ予定（Genie の一覧カード）
    await complete(
      agenda.id,
      JSON.stringify({
        schema: 'genie.agenda/v1',
        text: '明日の予定は 2 件です。\n・10:00〜11:00 定例ミーティング\n・14:30〜15:30 打ち合わせ',
        label: '明日',
        events: [
          {
            id: 'ev-1',
            title: '定例ミーティング',
            start: '2026-10-28T10:00:00+09:00',
            end: '2026-10-28T11:00:00+09:00',
            allDay: false,
          },
          {
            id: 'ev-2',
            title: '打ち合わせ',
            start: '2026-10-28T14:30:00+09:00',
            end: '2026-10-28T15:30:00+09:00',
            allDay: false,
          },
        ],
      }),
      'application/vnd.genie.agenda+json',
    );
    await harness.channels!.service.pump(tenantId);
    await harness.channels!.service.pump(tenantId);
    expect(texts(before).join('\n')).toContain('明日の予定は 2 件です。');
    // 予定はカードで届く（時刻と題名が並ぶ）
    const card = sent
      .slice(before)
      .map((x) => (x.body['messages'] as Record<string, unknown>[] | undefined)?.[0])
      .find((m) => m?.['type'] === 'flex');
    expect(JSON.stringify(card)).toContain('明日の予定（2 件）');
    expect(JSON.stringify(card)).toContain('10:00–11:00');

    // 2. 対象が 2 つあるのに「それ」だけ → 実行せずに聞き返す
    before = sent.length;
    await line('それ午後にずらして');
    await waitFor(() => texts(before).length > 0, 'which one');
    expect(texts(before)[0]).toContain('どの予定を変えますか？');
    expect(texts(before)[0]).toContain('定例ミーティング');

    // 3. 名前で指す → 変更前・後つきの、承認が要る仕事
    await line('定例ミーティングを午後にずらして');
    const move = await newest('calendar.move', seen);
    expect((await taskRow(move.id)).input).toMatchObject({
      event_id: 'ev-1',
      before_start: '2026-10-28T10:00:00+09:00',
      after_start: '2026-10-28T14:00:00+09:00',
      after_end: '2026-10-28T15:00:00+09:00',
      before_label: '10/28（水） 10:00〜11:00',
      after_label: '10/28（水） 14:00〜15:00',
    });
    // 承認されて変わった（端末が返した事実から作った文）
    before = sent.length;
    await complete(
      move.id,
      '予定「定例ミーティング」を 14:00〜15:00 に変更しました。元に戻すときは「元に戻して」と送ってください。',
    );
    await harness.channels!.service.pump(tenantId);
    await harness.channels!.service.pump(tenantId);
    expect(texts(before).join('\n')).toContain('14:00〜15:00 に変更しました');

    // 4. やっぱり元に戻して → 前後を入れ替えた、承認が要る仕事
    await line('やっぱり元に戻して');
    const undo = await newest('calendar.move', seen);
    expect((await taskRow(undo.id)).input).toMatchObject({
      event_id: 'ev-1',
      after_start: '2026-10-28T10:00:00+09:00',
      after_end: '2026-10-28T11:00:00+09:00',
      after_label: '10/28（水） 10:00〜11:00',
      undo: true,
    });
  });

  it('moves the event the person names by a relative time, keeping its length', async () => {
    const seen = new Set((await tasks()).map((t) => t.id));
    await line('打ち合わせを30分遅らせて');
    const move = await newest('calendar.move', seen);
    expect((await taskRow(move.id)).input).toMatchObject({
      event_id: 'ev-2',
      after_start: '2026-10-28T15:00:00+09:00',
      after_end: '2026-10-28T16:00:00+09:00',
    });
  });

  // 仕様 v1.0 §1 の例: 済んだことと、要ること（写真）を分けて 1 通で返し、予定は届いたら本文で返す
  it('answers several requests in one message, separating what is done from what is needed', async () => {
    const seen = new Set((await tasks()).map((t) => t.id));
    let before = sent.length;
    await line('明日の予定教えて。あと、昨日のレシートも家計簿に入れて');
    await waitFor(() => texts(before).length > 0, 'combined');
    const combined = texts(before)[0]!;
    expect(combined).toContain('・明日の予定教えて：確認しています。このあと届きます。');
    expect(combined).toContain(
      '・昨日のレシートも家計簿に入れて：レシートの写真はまだ届いていません。写真を送ってください。',
    );
    expect(combined).not.toContain('受け付けました');
    const agenda = await newest('calendar.agenda', seen);
    before = sent.length;
    await complete(
      agenda.id,
      JSON.stringify({
        schema: 'genie.agenda/v1',
        text: '明日の予定は 1 件です。\n・10:00〜11:00 定例ミーティング',
        label: '明日',
        events: [],
      }),
      'application/vnd.genie.agenda+json',
    );
    await harness.channels!.service.pump(tenantId);
    await harness.channels!.service.pump(tenantId);
    expect(texts(before).join('\n')).toContain('明日の予定は 1 件です。');
  });

  // 本人の合格基準（2026-10-27）の入口: 店はカード、次の一手はボタン。文で「分かりません」と止めない
  it('answers a restaurant question with store cards and next-step buttons', async () => {
    const before = sent.length;
    await line('新橋あたりでいい店ある？');
    await waitFor(() => texts(before).length > 0, 'shops');
    const messages = sent.slice(before).find((x) => x.body['messages'])!.body['messages'] as Record<
      string,
      unknown
    >[];
    expect(messages[0]).toMatchObject({ type: 'text' });
    expect(String(messages[0]!['text'])).toContain('何時ごろ行く？');
    expect(messages[1]).toMatchObject({ type: 'flex', contents: { type: 'carousel' } });
    expect(JSON.stringify(messages[1])).toContain('焼き鳥 とり新');
    expect(JSON.stringify(messages[1]!['quickReply'])).toContain('今日18時');
    expect(String(messages[0]!['text'])).not.toContain('分かりません');
  });

  it('notifies the linked LINE DM once when a local Orca task switches agents', async () => {
    const made = await app.inject({
      method: 'POST',
      url: '/v1/tasks',
      headers: { ...auth, 'idempotency-key': `orca-line-${uuidv7()}` },
      payload: {
        kind: 'coding.orca.launch',
        input: {
          host_id: '123e4567-e89b-42d3-a456-426614174000',
          path: '/projects/app',
          agent: 'claude',
          fallback_agent: 'codex',
          prompt: 'Implement',
        },
      },
    });
    expect(made.statusCode).toBe(202);
    const taskId = made.json<{ id: string }>().id;
    const before = sent.length;
    await complete(
      taskId,
      JSON.stringify({
        state: 'launched',
        agent: 'codex',
        failover: { from: 'claude', reason: 'rate_limited' },
      }),
      'application/json',
    );
    await harness.channels!.service.pump(tenantId);
    await harness.channels!.service.pump(tenantId);
    const notices = texts(before).filter((text) => text.includes('Codex に作業を引き継ぎました'));
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain('完了はまだ確認していません');
  });

  it('notifies the linked LINE DM when all approved agents are unavailable', async () => {
    const made = await app.inject({
      method: 'POST',
      url: '/v1/tasks',
      headers: { ...auth, 'idempotency-key': `orca-line-failed-${uuidv7()}` },
      payload: {
        kind: 'coding.orca.launch',
        input: {
          host_id: '123e4567-e89b-42d3-a456-426614174000',
          path: '/projects/app',
          agent: 'claude',
          fallback_agent: 'codex',
          prompt: 'Implement',
        },
      },
    });
    expect(made.statusCode).toBe(202);
    const taskId = made.json<{ id: string }>().id;
    const before = sent.length;
    const error = {
      code: 'task.step_failed',
      message: '両方が利用上限に達しています。',
      step_index: 0,
      retryable: false,
    };
    await withTenant(harness.db, tenantId, async (tx) => {
      await tx
        .updateTable('tasks')
        .set({ status: 'FAILED', error })
        .where('id', '=', taskId)
        .execute();
      await appendEvent(tx, {
        tenantId,
        streamKind: 'task',
        streamId: taskId,
        taskId,
        type: 'task.failed',
        payload: { error },
      });
    });
    await harness.channels!.service.pump(tenantId);
    await harness.channels!.service.pump(tenantId);
    expect(texts(before).filter((text) => text.includes('両方が利用上限'))).toHaveLength(1);
  });

  it('delivers a late Orca handoff notice once after the launch task has ended', async () => {
    const made = await app.inject({
      method: 'POST',
      url: '/v1/tasks',
      headers: { ...auth, 'idempotency-key': `orca-late-line-${uuidv7()}` },
      payload: {
        kind: 'coding.orca.launch',
        input: {
          host_id: '123e4567-e89b-42d3-a456-426614174000',
          path: '/projects/app',
          agent: 'claude',
          fallback_agent: 'codex',
          prompt: 'Implement',
        },
      },
    });
    expect(made.statusCode).toBe(202);
    const taskId = made.json<{ id: string }>().id;
    const before = sent.length;
    const outcome = {
      state: 'switched' as const,
      agent: 'codex' as const,
      terminal: 'term_223e4567-e89b-42d3-a456-426614174000',
    };
    await harness.channels!.service.notifyOrcaSupervision(tenantId, userId, taskId, outcome);
    await harness.channels!.service.notifyOrcaSupervision(tenantId, userId, taskId, outcome);
    await harness.channels!.service.pump(tenantId);
    expect(
      texts(before).filter((text) => text.includes('Codex に作業を引き継ぎました')),
    ).toHaveLength(1);
  });

  it('does not create a coding task when the owner has no online host', async () => {
    const seen = new Set((await tasks()).map((task) => task.id));
    const before = sent.length;
    await line('GenieのREADMEをClaudeで修正してください。');
    await waitFor(
      () => texts(before).some((text) => text.includes('端末がオンラインではありません')),
      'offline host notice',
    );
    expect((await tasks()).filter((task) => !seen.has(task.id))).toHaveLength(0);
  });

  it('turns a linked LINE coding request into an approved Orca task with fallback', async () => {
    const hostId = (
      await new AgentHostService({ db: harness.db }).heartbeat({
        tenantId,
        userId,
        deviceLabel: `line-coding-${uuidv7()}`,
        models: ['claude', 'codex'],
      })
    ).id;
    const seen = new Set((await tasks()).map((task) => task.id));
    const prompt =
      'GenieのREADMEにセットアップ手順を追記してください。Claudeの利用上限に達した場合はCodexへ引き継いで、進捗をLINEへ通知してください。';
    const before = sent.length;
    await line(prompt);
    const task = await newest('coding.orca.launch', seen);
    expect(await taskRow(task.id)).toMatchObject({
      kind: 'coding.orca.launch',
      input: {
        host_id: hostId,
        path: '/projects/app',
        agent: 'claude',
        fallback_agent: 'codex',
        prompt,
      },
    });
    expect(texts(before).join('\n')).toContain('Orca での作業を受け付けました');
    expect(sent.slice(before).some((item) => item.url.endsWith('/message/reply'))).toBe(true);
    expect(
      (await tasks()).filter(
        (item) => !seen.has(item.id) && item.kind === 'plugin:com.astra.general:assistant',
      ),
    ).toHaveLength(0);

    const args = (await taskRow(task.id)).input as Record<string, unknown>;
    const inputsHash = await canonicalSha256(args);
    const approvalId = uuidv7();
    const expiresAt = new Date(Date.now() + 60_000);
    await withTenant(harness.db, tenantId, (tx) =>
      tx
        .insertInto('approvals')
        .values({
          id: approvalId,
          tenant_id: tenantId,
          task_id: task.id,
          step_index: 0,
          risk: 'REVERSIBLE_WRITE',
          summary: 'Launch',
          details: JSON.stringify({ inputsHash }),
          editable_fields: JSON.stringify([]),
          status: 'APPROVED',
          expires_at: expiresAt,
          decided_by: userId,
          decided_at: new Date(),
        })
        .execute(),
    );
    const bridge = new HostStepBridge({ db: harness.db });
    const request = await bridge.request({
      tenantId,
      userId,
      taskId: task.id,
      stepIndex: 0,
      toolId: 'coding.orca.launch',
      args,
      approval: {
        approvalId,
        operationId: 'coding.orca.launch',
        decision: 'APPROVED',
        decidedBy: userId,
        decidedAt: new Date().toISOString(),
        expiresAt: expiresAt.toISOString(),
        inputsHash,
      },
    });
    await bridge.claimNext({ tenantId, hostId });
    await bridge.complete({
      tenantId,
      hostId,
      requestId: request.id,
      result: {
        state: 'launched',
        terminal: 'term_123e4567-e89b-42d3-a456-426614174000',
        agent: 'claude',
      },
    });
    await withTenant(harness.db, tenantId, (tx) =>
      tx.updateTable('tasks').set({ status: 'COMPLETED' }).where('id', '=', task.id).execute(),
    );
    const claimed = await app.inject({
      method: 'POST',
      url: `/v1/host-steps/${request.id}/orca-supervision/begin`,
      headers: auth,
      payload: { host_id: hostId },
    });
    expect(claimed.json()).toEqual({ claimed: true });
    const beforeNotice = sent.length;
    const outcome = {
      state: 'switched',
      agent: 'codex',
      terminal: 'term_223e4567-e89b-42d3-a456-426614174000',
    };
    const finished = await app.inject({
      method: 'POST',
      url: `/v1/host-steps/${request.id}/orca-supervision/finish`,
      headers: auth,
      payload: { host_id: hostId, outcome },
    });
    expect(finished.statusCode).toBe(204);
    await harness.channels!.service.pump(tenantId);
    await harness.channels!.service.pump(tenantId);
    expect(
      texts(beforeNotice).filter((text) => text.includes('Codex に作業を引き継ぎました')),
    ).toHaveLength(1);
  });

  it('records a late switch through the authenticated Gateway and queues one LINE notice', async () => {
    const hostId = (
      await new AgentHostService({ db: harness.db }).heartbeat({
        tenantId,
        userId,
        deviceLabel: `orca-test-${uuidv7()}`,
        models: ['codex'],
      })
    ).id;
    const args = {
      host_id: hostId,
      path: '/projects/app',
      agent: 'claude',
      fallback_agent: 'codex',
      prompt: 'Implement',
    };
    const made = await app.inject({
      method: 'POST',
      url: '/v1/tasks',
      headers: { ...auth, 'idempotency-key': `orca-late-api-${uuidv7()}` },
      payload: { kind: 'coding.orca.launch', input: args },
    });
    expect(made.statusCode).toBe(202);
    const taskId = made.json<{ id: string }>().id;
    const inputsHash = await canonicalSha256(args);
    const approvalId = uuidv7();
    const expiresAt = new Date(Date.now() + 60_000);
    await withTenant(harness.db, tenantId, (tx) =>
      tx
        .insertInto('approvals')
        .values({
          id: approvalId,
          tenant_id: tenantId,
          task_id: taskId,
          step_index: 0,
          risk: 'REVERSIBLE_WRITE',
          summary: 'Launch',
          details: JSON.stringify({ inputsHash }),
          editable_fields: JSON.stringify([]),
          status: 'APPROVED',
          expires_at: expiresAt,
          decided_by: userId,
          decided_at: new Date(),
        })
        .execute(),
    );
    const bridge = new HostStepBridge({ db: harness.db });
    const request = await bridge.request({
      tenantId,
      userId,
      taskId,
      stepIndex: 0,
      toolId: 'coding.orca.launch',
      args,
      approval: {
        approvalId,
        operationId: 'coding.orca.launch',
        decision: 'APPROVED',
        decidedBy: userId,
        decidedAt: new Date().toISOString(),
        expiresAt: expiresAt.toISOString(),
        inputsHash,
      },
    });
    await bridge.claimNext({ tenantId, hostId });
    await bridge.complete({
      tenantId,
      hostId,
      requestId: request.id,
      result: {
        state: 'launched',
        terminal: 'term_123e4567-e89b-42d3-a456-426614174000',
        agent: 'claude',
      },
    });
    await withTenant(harness.db, tenantId, (tx) =>
      tx.updateTable('tasks').set({ status: 'COMPLETED' }).where('id', '=', taskId).execute(),
    );
    const list = await app.inject({
      method: 'GET',
      url: `/v1/host-steps/orca-supervisions?host_id=${hostId}`,
      headers: auth,
    });
    expect(list.statusCode).toBe(200);
    expect(list.json<{ items: { requestId: string }[] }>().items).toContainEqual(
      expect.objectContaining({ requestId: request.id }),
    );
    const begin = await app.inject({
      method: 'POST',
      url: `/v1/host-steps/${request.id}/orca-supervision/begin`,
      headers: auth,
      payload: { host_id: hostId },
    });
    expect(begin.json()).toEqual({ claimed: true });
    const before = sent.length;
    const outcome = {
      state: 'switched',
      agent: 'codex',
      terminal: 'term_223e4567-e89b-42d3-a456-426614174000',
    };
    const finish = await app.inject({
      method: 'POST',
      url: `/v1/host-steps/${request.id}/orca-supervision/finish`,
      headers: auth,
      payload: { host_id: hostId, outcome },
    });
    expect(finish.statusCode).toBe(204);
    const state = await app.inject({
      method: 'GET',
      url: `/v1/tasks/${taskId}/orca-supervision`,
      headers: auth,
    });
    expect(state.json()).toMatchObject({ state: 'switched', outcome });
    await harness.channels!.service.pump(tenantId);
    expect(
      texts(before).filter((text) => text.includes('Codex に作業を引き継ぎました')),
    ).toHaveLength(1);
  });
});
