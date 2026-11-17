/**
 * Task / SSE / 承認 / Artifact の HTTP 表面。実装仕様 §11・§7.3。
 *   ./infra/db/with-test-db.sh pnpm --filter @genie/service-api-gateway test
 *
 * ワークフローは動かさない（InMemoryTaskRuntime）。実行の縦串は
 * services/task の E2E が Temporal で確認する。ここは HTTP 契約だけを見る。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type ApiError,
  type Artifact,
  type Task,
  type TokenResponse,
  uuidv7,
} from '@genie/contracts';
import { withTenant } from '@genie/db';
import { appendEvent } from '@genie/service-task';
import { HostBridge } from '@genie/service-agent-host';
import { makeTestApp, makeTokens, testDbConfig, type TestApp } from './support.js';
import type { App } from '../src/fastify.js';

const url = process.env['TEST_DATABASE_URL'];
const identityUrl = process.env['TEST_IDENTITY_DATABASE_URL'];

describe.skipIf(!url)('task and artifact http surface', () => {
  let harness: TestApp;
  let app: App;
  let auth: { authorization: string };
  let tenantId: string;
  let userId: string;

  const createTask = async (key: string, input: Record<string, unknown> = {}) =>
    app.inject({
      method: 'POST',
      url: '/v1/tasks',
      headers: { ...auth, 'idempotency-key': key },
      payload: { kind: 'echo', input },
    });

  const seedEvents = async (taskId: string, types: readonly string[]): Promise<void> => {
    await withTenant(harness.db, tenantId, async (tx) => {
      for (const [i, type] of types.entries()) {
        await appendEvent(tx, {
          tenantId,
          streamKind: 'task',
          streamId: taskId,
          taskId,
          type: type as never,
          payload:
            type === 'task.progress'
              ? {
                  phase: 'thinking',
                  step_index: i,
                  step_count: types.length,
                  message: `step ${i}`,
                  detail: null,
                  elapsed_ms: null,
                  retrying: false,
                }
              : type === 'task.completed'
                ? { result_artifact_id: null, duration_ms: 1 }
                : { kind: 'echo', title: null, step_count: null },
        });
      }
    });
  };

  const parseSse = (body: string): { id: number; event: string }[] =>
    body
      .split('\n\n')
      .filter((block) => block.startsWith('id: '))
      .map((block) => ({
        id: Number(/^id: (\d+)/.exec(block)![1]),
        event: /event: (.+)/.exec(block)![1]!,
      }));

  beforeAll(async () => {
    const tokens = await makeTokens();
    harness = await makeTestApp({ dbConfig: testDbConfig(url!, identityUrl), tokens });
    app = harness.app;

    const issued = await app.inject({
      method: 'POST',
      url: '/v1/auth/dev/token',
      payload: { email: `t-${uuidv7()}@example.com`, display_name: 'T' },
    });
    const token = issued.json<TokenResponse>();
    auth = { authorization: `Bearer ${token.access_token}` };

    const me = await app.inject({ method: 'GET', url: '/v1/me', headers: auth });
    tenantId = me.json<{ tenant: { id: string } }>().tenant.id;
    userId = me.json<{ user: { id: string } }>().user.id;
  });

  afterAll(async () => {
    await harness?.close();
  });

  it('revokes the authenticated claimed host step when the task is cancelled through HTTP', async () => {
    const created = (await createTask(`authority-${uuidv7()}`)).json<Task>();
    const hostResponse = await app.inject({
      method: 'POST',
      url: '/v1/agent-hosts/heartbeat',
      headers: auth,
      payload: { device_label: 'authority-test', models: ['test'] },
    });
    expect(hostResponse.statusCode).toBe(200);
    const hostId = hostResponse.json<{ id: string }>().id;
    const bridge = new HostBridge({ db: harness.db });
    const request = await bridge.request({
      tenantId,
      taskId: created.id,
      stepIndex: 0,
      toolId: 'mail.send',
      args: {},
    });
    const claimed = await app.inject({
      method: 'POST',
      url: '/v1/host-steps/claim',
      headers: auth,
      payload: { host_id: hostId },
    });
    expect(claimed.statusCode).toBe(200);
    expect(claimed.json<{ id: string }>().id).toBe(request.id);
    const authority = () =>
      app.inject({
        method: 'POST',
        url: `/v1/host-steps/${request.id}/authority`,
        headers: auth,
        payload: { host_id: hostId },
      });
    expect((await authority()).json()).toEqual({ allowed: true });
    const anonymous = await app.inject({
      method: 'POST',
      url: `/v1/host-steps/${request.id}/authority`,
      payload: { host_id: hostId },
    });
    expect(anonymous.statusCode).toBe(401);
    const cancelled = await app.inject({
      method: 'POST',
      url: `/v1/tasks/${created.id}/cancel`,
      headers: auth,
      payload: { reason: 'user_requested' },
    });
    expect(cancelled.statusCode).toBe(200);
    expect((await authority()).json()).toEqual({ allowed: false });
    // Stopping future input must not discard a receipt for an input already sent.
    const completed = await app.inject({
      method: 'POST',
      url: `/v1/host-steps/${request.id}/complete`,
      headers: auth,
      payload: { host_id: hostId, result: { status: 'accepted', providerOrderId: 'already-sent' } },
    });
    expect(completed.statusCode).toBe(204);
    expect(await bridge.get(tenantId, request.id)).toMatchObject({
      status: 'DONE',
      result: { providerOrderId: 'already-sent' },
    });
  });

  it('persists unknown order identity on the failed host request for read-only reconciliation', async () => {
    const created = (await createTask(`unknown-${uuidv7()}`)).json<Task>();
    const host = await app.inject({
      method: 'POST',
      url: '/v1/agent-hosts/heartbeat',
      headers: auth,
      payload: { device_label: 'unknown-result-test', models: ['test'] },
    });
    const hostId = host.json<{ id: string }>().id;
    const bridge = new HostBridge({ db: harness.db });
    const request = await bridge.request({
      tenantId,
      taskId: created.id,
      stepIndex: 0,
      toolId: 'transaction.submit',
      args: {},
    });
    await bridge.claimNext({ tenantId, hostId });
    const result = {
      status: 'unknown',
      provider: 'fixture',
      mode: 'simulation',
      account: 'account',
      orderKey: 'order-1',
      quoteHash: 'a'.repeat(64),
    };
    const failed = await app.inject({
      method: 'POST',
      url: `/v1/host-steps/${request.id}/fail`,
      headers: auth,
      payload: {
        host_id: hostId,
        error: { code: 'transaction.result_unknown', message: '受付状況を照会してください。' },
        result,
      },
    });
    expect(failed.statusCode).toBe(204);
    expect(await bridge.get(tenantId, request.id)).toMatchObject({
      status: 'FAILED',
      result,
      error: { code: 'transaction.result_unknown' },
    });
    expect(await bridge.claimNext({ tenantId, hostId })).toBeNull();
  });

  describe('POST /v1/tasks', () => {
    it('refuses without an idempotency key', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/tasks',
        headers: auth,
        payload: { kind: 'echo', input: {} },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json<ApiError>().error.code).toBe('common.validation_failed');
    });

    it('accepts a task and starts exactly one workflow', async () => {
      const key = `k-${uuidv7()}`;
      const first = await createTask(key, { message: 'hi' });
      expect(first.statusCode).toBe(202);
      const task = first.json<Task>();
      expect(task.status).toBe('PENDING');
      expect(harness.runtime.started.size).toBeGreaterThan(0);

      const before = harness.runtime.started.size;
      const second = await createTask(key, { message: 'hi' });
      // 冪等な再送は 200（新規受理の 202 と区別できる）
      expect(second.statusCode).toBe(200);
      expect(second.json<Task>().id).toBe(task.id);
      expect(harness.runtime.started.size).toBe(before);
    });

    it('refuses a kind nothing can run', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/tasks',
        headers: { ...auth, 'idempotency-key': `k-${uuidv7()}` },
        payload: { kind: 'nope', input: {} },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json<ApiError>().error.code).toBe('task.unknown_kind');
    });

    it('requires authentication', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/tasks',
        headers: { 'idempotency-key': `k-${uuidv7()}` },
        payload: { kind: 'echo' },
      });
      expect(res.statusCode).toBe(401);
    });
  });

  describe('GET /v1/tasks', () => {
    it('returns the dock state alongside the task', async () => {
      const created = (await createTask(`k-${uuidv7()}`)).json<Task>();
      const res = await app.inject({
        method: 'GET',
        url: `/v1/tasks/${created.id}`,
        headers: auth,
      });
      expect(res.statusCode).toBe(200);
      // UI/UX §3: サーバが Dock の表示状態まで決める
      expect(res.json<{ dock_state: string }>().dock_state).toBe('WORKING');
    });

    it('pages newest first with a cursor', async () => {
      for (let i = 0; i < 3; i += 1) await createTask(`k-${uuidv7()}`);
      const page = await app.inject({ method: 'GET', url: '/v1/tasks?limit=2', headers: auth });
      const body = page.json<{ items: Task[]; next_cursor: string | null }>();
      expect(body.items).toHaveLength(2);
      expect(body.next_cursor).not.toBeNull();
      expect(body.items[0]!.id > body.items[1]!.id).toBe(true);

      const next = await app.inject({
        method: 'GET',
        url: `/v1/tasks?limit=2&cursor=${body.next_cursor}`,
        headers: auth,
      });
      const second = next.json<{ items: Task[] }>();
      expect(second.items.every((t) => t.id < body.items[1]!.id)).toBe(true);
    });

    it('hides a task from another tenant behind 404', async () => {
      const created = (await createTask(`k-${uuidv7()}`)).json<Task>();
      const other = await app.inject({
        method: 'POST',
        url: '/v1/auth/dev/token',
        payload: { email: `o-${uuidv7()}@example.com`, display_name: 'O' },
      });
      const res = await app.inject({
        method: 'GET',
        url: `/v1/tasks/${created.id}`,
        headers: { authorization: `Bearer ${other.json<TokenResponse>().access_token}` },
      });
      expect(res.statusCode).toBe(404);
      expect(res.json<ApiError>().error.code).toBe('task.not_found');
    });
  });

  describe('cancel and approve', () => {
    it('moves to CANCELLING and signals the runtime', async () => {
      const created = (await createTask(`k-${uuidv7()}`)).json<Task>();
      const res = await app.inject({
        method: 'POST',
        url: `/v1/tasks/${created.id}/cancel`,
        headers: auth,
        payload: { reason: 'user_requested' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json<Task>().status).toBe('CANCELLING');
      expect(harness.runtime.signals.some((s) => s.kind === 'cancel')).toBe(true);
    });

    it('records the decision and signals the workflow', async () => {
      const created = (await createTask(`k-${uuidv7()}`)).json<Task>();
      const approvalId = uuidv7();
      await withTenant(harness.db, tenantId, (tx) =>
        tx
          .insertInto('approvals')
          .values({
            id: approvalId,
            tenant_id: tenantId,
            task_id: created.id,
            step_index: 0,
            risk: 'EXTERNAL_COMMIT',
            summary: '3人にメールを送信します',
            details: JSON.stringify({ items: [], impact: {} }),
            editable_fields: JSON.stringify([]),
            status: 'PENDING',
            expires_at: new Date(Date.now() + 60_000),
          })
          .execute(),
      );

      const res = await app.inject({
        method: 'POST',
        url: `/v1/tasks/${created.id}/approve`,
        headers: auth,
        payload: { approval_id: approvalId, decision: 'APPROVED' },
      });
      expect(res.statusCode).toBe(204);
      expect(
        harness.runtime.signals.some((s) => s.kind === 'approve' && s.approvalId === approvalId),
      ).toBe(true);

      const again = await app.inject({
        method: 'POST',
        url: `/v1/tasks/${created.id}/approve`,
        headers: auth,
        payload: { approval_id: approvalId, decision: 'APPROVED' },
      });
      expect(again.statusCode).toBe(409);
      expect(again.json<ApiError>().error.code).toBe('approval.already_decided');
    });

    it('rejects an unknown approval', async () => {
      const created = (await createTask(`k-${uuidv7()}`)).json<Task>();
      const res = await app.inject({
        method: 'POST',
        url: `/v1/tasks/${created.id}/approve`,
        headers: auth,
        payload: { approval_id: uuidv7(), decision: 'APPROVED' },
      });
      expect(res.statusCode).toBe(404);
      expect(res.json<ApiError>().error.code).toBe('approval.not_found');
    });
  });

  describe('GET /v1/tasks/{id}/receipts', () => {
    /** 承認された step と、その結果の receipt を 1 組置く。 */
    const seedReceipt = async (
      taskId: string,
      over: { risk?: string; stepIndex?: number; approved?: boolean } = {},
    ): Promise<void> => {
      const stepIndex = over.stepIndex ?? 0;
      const risk = over.risk ?? 'EXTERNAL_COMMIT';
      const approved = over.approved ?? true;
      await withTenant(harness.db, tenantId, async (tx) => {
        if (approved) {
          await tx
            .insertInto('approvals')
            .values({
              id: uuidv7(),
              tenant_id: tenantId,
              task_id: taskId,
              step_index: stepIndex,
              risk,
              summary: '3人にメールを送信します',
              details: JSON.stringify({ items: [], impact: {} }),
              editable_fields: JSON.stringify([]),
              status: 'APPROVED',
              expires_at: new Date(Date.now() + 60_000),
              decided_by: userId,
              decided_at: new Date(),
            })
            .execute();
        }
        await tx
          .insertInto('action_receipts')
          .values({
            id: uuidv7(),
            tenant_id: tenantId,
            task_id: taskId,
            tool_id: 'gmail.send',
            actor: 'agent',
            inputs_hash: 'a'.repeat(64),
            result_ref: null,
            risk,
            approved_by: approved ? userId : null,
            reversible_until: null,
            executed_at: new Date(),
            step_index: stepIndex,
          })
          .execute();
      });
    };

    it('returns the sentence the user agreed to, not the audit row', async () => {
      const created = (await createTask(`k-${uuidv7()}`)).json<Task>();
      await seedReceipt(created.id);

      const res = await app.inject({
        method: 'GET',
        url: `/v1/tasks/${created.id}/receipts`,
        headers: auth,
      });
      expect(res.statusCode).toBe(200);
      const items = res.json<{ items: { summary: string; approved_by_name: string }[] }>().items;
      expect(items).toHaveLength(1);
      expect(items[0]!.summary).toBe('3人にメールを送信します');
      expect(items[0]!.approved_by_name).not.toBeNull();
    });

    it('leaves the summary empty when nothing was confirmed', async () => {
      const created = (await createTask(`k-${uuidv7()}`)).json<Task>();
      await seedReceipt(created.id, { risk: 'REVERSIBLE_WRITE', approved: false });

      const items = (
        await app.inject({
          method: 'GET',
          url: `/v1/tasks/${created.id}/receipts`,
          headers: auth,
        })
      ).json<{ items: { summary: string | null; approved_by_name: string | null }[] }>().items;
      // それらしい文を作らない
      expect(items[0]!.summary).toBeNull();
      expect(items[0]!.approved_by_name).toBeNull();
    });

    it('hides another tenant behind 404 rather than an empty list', async () => {
      const created = (await createTask(`k-${uuidv7()}`)).json<Task>();
      await seedReceipt(created.id);

      const other = await app.inject({
        method: 'POST',
        url: '/v1/auth/dev/token',
        payload: { email: `o-${uuidv7()}@example.com`, display_name: 'O' },
      });
      const res = await app.inject({
        method: 'GET',
        url: `/v1/tasks/${created.id}/receipts`,
        headers: { authorization: `Bearer ${other.json<TokenResponse>().access_token}` },
      });
      // 空リストだと「操作が無かった」と読める。存在ごと隠す。
      expect(res.statusCode).toBe(404);
    });
  });

  describe('GET /v1/tasks/{id}/evidence', () => {
    /** 調査 1 件と、食い違う根拠 2 件を置く。 */
    const seedResearch = async (taskId: string): Promise<{ a: string; b: string }> => {
      const runId = uuidv7();
      const a = uuidv7();
      const b = uuidv7();
      await withTenant(harness.db, tenantId, async (tx) => {
        await tx
          .insertInto('research_runs')
          .values({
            id: runId,
            tenant_id: tenantId,
            task_id: taskId,
            question: 'A社の売上は',
            sub_queries: JSON.stringify([]),
            status: 'COMPLETE',
            source_count: 2,
            confidence: 'low',
          })
          .execute();
        const evidence = (id: string, url: string, claim: string, contradicts: string[]) => ({
          id,
          tenant_id: tenantId,
          research_run_id: runId,
          source_url: url,
          source_type: 'official',
          publisher: 'Example Inc',
          published_at: new Date('2026-08-01T00:00:00.000Z'),
          claim,
          support_text_ref: null,
          quality_score: '0.90',
          freshness_score: '0.80',
          supports: [],
          contradicts,
        });
        await tx
          .insertInto('evidence')
          .values([
            evidence(a, 'https://official.example.com/ir', '売上は 100 億円', [b]),
            evidence(b, 'https://news.example.com/story', '売上は 120 億円', [a]),
          ])
          .execute();
      });
      return { a, b };
    };

    it('returns L0 through L3 in one call (§15)', async () => {
      const created = (await createTask(`k-${uuidv7()}`)).json<Task>();
      await seedResearch(created.id);

      const res = await app.inject({
        method: 'GET',
        url: `/v1/tasks/${created.id}/evidence`,
        headers: auth,
      });
      expect(res.statusCode).toBe(200);
      const ledger = res.json<{
        source_count: number;
        confidence: string;
        contradiction_count: number;
        groups: { source_type: string; count: number }[];
        items: { claim: string; contradicts: string[]; retrieved_at: string }[];
      }>();

      // L0
      expect(ledger.source_count).toBe(2);
      expect(ledger.confidence).toBe('low');
      // 行は 2 つでも、食い違いは 1 件
      expect(ledger.contradiction_count).toBe(1);
      // L1
      expect(ledger.groups).toEqual([{ source_type: 'official', count: 2 }]);
      // L2 / L3
      expect(ledger.items).toHaveLength(2);
      expect(ledger.items[0]!.contradicts).toHaveLength(1);
      expect(ledger.items[0]!.retrieved_at).toBeTruthy();
    });

    it('counts one source when the same page was used twice', async () => {
      const created = (await createTask(`k-${uuidv7()}`)).json<Task>();
      const runId = uuidv7();
      await withTenant(harness.db, tenantId, async (tx) => {
        await tx
          .insertInto('research_runs')
          .values({
            id: runId,
            tenant_id: tenantId,
            task_id: created.id,
            question: '同じページ',
            sub_queries: JSON.stringify([]),
            status: 'COMPLETE',
            source_count: 2,
            confidence: 'medium',
          })
          .execute();
        await tx
          .insertInto('evidence')
          .values(
            ['一つ目', '二つ目'].map((claim) => ({
              id: uuidv7(),
              tenant_id: tenantId,
              research_run_id: runId,
              source_url: 'https://official.example.com/ir',
              source_type: 'official',
              publisher: null,
              published_at: null,
              claim,
              support_text_ref: null,
              quality_score: '0.50',
              freshness_score: '0.50',
              supports: [],
              contradicts: [],
            })),
          )
          .execute();
      });

      const ledger = (
        await app.inject({
          method: 'GET',
          url: `/v1/tasks/${created.id}/evidence`,
          headers: auth,
        })
      ).json<{ source_count: number }>();
      // 同じページを 2 回引いて「2 sources」と言わない
      expect(ledger.source_count).toBe(1);
    });

    it('is 404 for a task that never gathered anything', async () => {
      const created = (await createTask(`k-${uuidv7()}`)).json<Task>();
      const res = await app.inject({
        method: 'GET',
        url: `/v1/tasks/${created.id}/evidence`,
        headers: auth,
      });
      // 空の台帳を返すと「調べたが何も無かった」に見える
      expect(res.statusCode).toBe(404);
    });

    it('is 404 for another tenant, before it looks at the evidence', async () => {
      const created = (await createTask(`k-${uuidv7()}`)).json<Task>();
      await seedResearch(created.id);
      const other = await app.inject({
        method: 'POST',
        url: '/v1/auth/dev/token',
        payload: { email: `e-${uuidv7()}@example.com`, display_name: 'E' },
      });
      const res = await app.inject({
        method: 'GET',
        url: `/v1/tasks/${created.id}/evidence`,
        headers: { authorization: `Bearer ${other.json<TokenResponse>().access_token}` },
      });
      expect(res.statusCode).toBe(404);
    });
  });

  describe('GET /v1/tasks/{id}/stream', () => {
    it('replays the whole stream and closes on the terminal event', async () => {
      const created = (await createTask(`k-${uuidv7()}`)).json<Task>();
      await seedEvents(created.id, [
        'task.started',
        'task.progress',
        'task.progress',
        'task.completed',
      ]);

      const res = await app.inject({
        method: 'GET',
        url: `/v1/tasks/${created.id}/stream`,
        headers: auth,
      });
      expect(res.headers['content-type']).toContain('text/event-stream');
      const frames = parseSse(res.body);
      expect(frames.map((f) => f.id)).toEqual([1, 2, 3, 4]);
      expect(frames.at(-1)!.event).toBe('task.completed');
    });

    it('resumes from Last-Event-ID without repeating', async () => {
      const created = (await createTask(`k-${uuidv7()}`)).json<Task>();
      await seedEvents(created.id, [
        'task.started',
        'task.progress',
        'task.progress',
        'task.completed',
      ]);

      const res = await app.inject({
        method: 'GET',
        url: `/v1/tasks/${created.id}/stream`,
        headers: { ...auth, 'last-event-id': '2' },
      });
      const frames = parseSse(res.body);
      expect(frames.map((f) => f.id)).toEqual([3, 4]);
    });

    it('is not reachable for another tenant', async () => {
      const created = (await createTask(`k-${uuidv7()}`)).json<Task>();
      const other = await app.inject({
        method: 'POST',
        url: '/v1/auth/dev/token',
        payload: { email: `o-${uuidv7()}@example.com`, display_name: 'O' },
      });
      const res = await app.inject({
        method: 'GET',
        url: `/v1/tasks/${created.id}/stream`,
        headers: { authorization: `Bearer ${other.json<TokenResponse>().access_token}` },
      });
      expect(res.statusCode).toBe(404);
    });
  });

  describe('artifacts', () => {
    it('stores and returns content byte for byte', async () => {
      const content = '# hello\n\n日本語も通す';
      const created = await app.inject({
        method: 'POST',
        url: '/v1/artifacts',
        headers: auth,
        payload: {
          type: 'DOCUMENT',
          title: 'Test artifact',
          mime_type: 'text/markdown',
          content_base64: Buffer.from(content, 'utf8').toString('base64'),
        },
      });
      expect(created.statusCode).toBe(201);
      const artifact = created.json<Artifact>();
      expect(artifact.owner_id).toBe(userId);

      const body = await app.inject({
        method: 'GET',
        url: `/v1/artifacts/${artifact.id}/content`,
        headers: auth,
      });
      expect(body.statusCode).toBe(200);
      expect(body.body).toBe(content);
      // 本文をブラウザに解釈させない
      expect(body.headers['content-disposition']).toBe('attachment');
      expect(body.headers['x-content-type-options']).toBe('nosniff');
    });

    it('lists newest first and filters by type', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/v1/artifacts?limit=10&type=DOCUMENT',
        headers: auth,
      });
      expect(res.statusCode).toBe(200);
      const body = res.json<{ items: Artifact[] }>();
      expect(body.items.every((a) => a.type === 'DOCUMENT')).toBe(true);
    });

    it('lists only what a given task produced (§9.2 Outputs)', async () => {
      const mine = (await createTask(`k-${uuidv7()}`)).json<Task>();
      const other = (await createTask(`k-${uuidv7()}`)).json<Task>();

      const make = async (taskId: string, title: string) =>
        app.inject({
          method: 'POST',
          url: '/v1/artifacts',
          headers: auth,
          payload: {
            type: 'REPORT',
            title,
            mime_type: 'text/markdown',
            content_base64: Buffer.from('x').toString('base64'),
            source_task_id: taskId,
          },
        });
      await make(mine.id, 'この仕事のもの');
      await make(other.id, 'よその仕事のもの');

      const items = (
        await app.inject({
          method: 'GET',
          url: `/v1/artifacts?source_task_id=${mine.id}`,
          headers: auth,
        })
      ).json<{ items: Artifact[] }>().items;

      expect(items.map((a) => a.title)).toEqual(['この仕事のもの']);
    });

    it('hides another tenant behind 404', async () => {
      const created = await app.inject({
        method: 'POST',
        url: '/v1/artifacts',
        headers: auth,
        payload: {
          type: 'DOCUMENT',
          title: 'Private',
          mime_type: 'text/plain',
          content_base64: Buffer.from('secret').toString('base64'),
        },
      });
      const artifact = created.json<Artifact>();
      const other = await app.inject({
        method: 'POST',
        url: '/v1/auth/dev/token',
        payload: { email: `o-${uuidv7()}@example.com`, display_name: 'O' },
      });
      const res = await app.inject({
        method: 'GET',
        url: `/v1/artifacts/${artifact.id}`,
        headers: { authorization: `Bearer ${other.json<TokenResponse>().access_token}` },
      });
      expect(res.statusCode).toBe(404);
      expect(res.json<ApiError>().error.code).toBe('artifact.not_found');
    });
  });
});
