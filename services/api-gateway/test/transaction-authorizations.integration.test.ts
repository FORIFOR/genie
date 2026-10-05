/** Real PostgreSQL + HTTP + task activities; fictional orders only, no native input. */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  canonicalSha256,
  simulationOrderIntent,
  transactionAuthorizationScope,
  uuidv7,
} from '@genie/contracts';
import { withTenant } from '@genie/db';
import { createTaskActivities } from '@genie/service-task';
import { planTask, withTransactionQuote } from '../../task/src/plan.js';
import { makeTestApp, makeTokens, testDbConfig, type TestApp } from './support.js';

const url = process.env['TEST_DATABASE_URL'];
describe.skipIf(!url)('bounded transaction consent HTTP and task integration', () => {
  let h: TestApp, auth: { authorization: string }, foreignAuth: { authorization: string };
  let tenantId: string, userId: string;
  let activities: ReturnType<typeof createTaskActivities>;
  let dispatched = 0;
  beforeAll(async () => {
    h = await makeTestApp({
      dbConfig: testDbConfig(url!, process.env['TEST_IDENTITY_DATABASE_URL']),
      tokens: await makeTokens(),
    });
    const token = async () => {
      const r = await h.app.inject({
        method: 'POST',
        url: '/v1/auth/dev/token',
        payload: {
          email: `grant-${uuidv7()}@example.invalid`,
          display_name: 'Fictional authorization test',
        },
      });
      expect(r.statusCode).toBe(200);
      return { authorization: `Bearer ${r.json().access_token}` };
    };
    auth = await token();
    foreignAuth = await token();
    const me = (await h.app.inject({ method: 'GET', url: '/v1/me', headers: auth })).json();
    tenantId = me.tenant.id;
    userId = me.user.id;
    activities = createTaskActivities({
      db: h.db,
      library: h.library,
      publisher: { async publish() {} },
      hostExecutor: {
        async execute() {
          dispatched++;
          return { result: { status: 'unknown' } };
        },
      },
    });
  });
  afterAll(async () => {
    await h?.close();
  });
  const api = (
    method: 'GET' | 'POST',
    url: string,
    payload?: Record<string, unknown>,
    headers = auth,
  ) => h.app.inject({ method, url, headers, ...(payload === undefined ? {} : { payload }) });
  async function order(kind: 'pizza' | 'burger' = 'pizza') {
    const intent = simulationOrderIntent(kind, uuidv7());
    const { maxTotalMinor: _limit, ...scope } = intent;
    const unit = kind === 'pizza' ? 1200 : 500;
    const quote = {
      ...scope,
      quoteId: uuidv7(),
      items: intent.items.map((i) => ({ ...i, unitMinor: unit, lineMinor: unit * i.quantity })),
      totals: {
        subtotalMinor: unit,
        taxMinor: 0,
        feeMinor: 300,
        tipMinor: 0,
        totalMinor: unit + 300,
      },
      expiresAt: new Date(Date.now() + 120000).toISOString(),
    };
    const args = { intent, quote, quoteHash: await canonicalSha256(quote) };
    const { task } = await h.tasks.create({
      tenantId,
      userId,
      request: { kind: 'transaction.order', input: { intent } },
      idempotencyKey: uuidv7(),
    });
    const input = {
      taskId: task.id,
      tenantId,
      userId,
      kind: 'transaction.order',
      input: { intent },
    };
    const plan = planTask(input.kind, input.input);
    const step = withTransactionQuote(plan.steps[1]!, plan.steps, [{ ...args, submitArgs: args }]);
    await activities.startTask(input, {
      kind: input.kind,
      title: '模擬注文',
      step_count: 2,
      run_id: uuidv7(),
    });
    const approval = await activities.requestApprovalIfNeeded(input, step);
    return { input, step, args, approval };
  }
  const specFor = (intent: ReturnType<typeof simulationOrderIntent>, maxOrders = 2) => ({
    scope: transactionAuthorizationScope(intent),
    maxPerOrderMinor: intent.maxTotalMinor,
    maxTotalMinor: intent.maxTotalMinor * maxOrders,
    maxOrders,
    expiresAt: new Date(Date.now() + 86400000).toISOString(),
  });

  it('requires authentication and never accepts a live standing authorization', async () => {
    expect(
      (await h.app.inject({ method: 'GET', url: '/v1/transaction-authorizations' })).statusCode,
    ).toBe(401);
    const spec = specFor(simulationOrderIntent('pizza', uuidv7()));
    expect(
      (
        await api('POST', '/v1/transaction-authorizations', {
          requestId: uuidv7(),
          spec: { ...spec, scope: { ...spec.scope, mode: 'live' } },
        })
      ).statusCode,
    ).toBe(400);
  });
  it('exposes exact current terms only to the owner, atomically reserves the first order, and recovers an acknowledgement loss', async () => {
    const f = await order();
    expect(f.approval).not.toBeNull();
    const context = `/v1/approvals/${f.approval!.approvalId}/transaction-context`;
    expect((await api('GET', context, undefined, foreignAuth)).statusCode).toBe(404);
    const terms = await api('GET', context);
    expect(terms.statusCode).toBe(200);
    expect(terms.json()).toEqual(f.args);
    const body = {
      requestId: uuidv7(),
      spec: specFor(f.args.intent),
      approvalId: f.approval!.approvalId,
    };
    const created = await api('POST', '/v1/transaction-authorizations', body);
    expect(created.statusCode).toBe(200);
    const result = created.json();
    expect(result).toMatchObject({
      approvalId: f.approval!.approvalId,
      authorization: { usedOrders: 1, usedTotalMinor: 1500 },
    });
    const again = await api('POST', '/v1/transaction-authorizations', body);
    expect(again.statusCode).toBe(200);
    expect(again.json()).toEqual(result);
    expect(
      h.runtime.signals.filter(
        (s) => s.kind === 'approve' && s.approvalId === f.approval!.approvalId,
      ),
    ).toHaveLength(2);
    expect((await api('GET', context)).statusCode).toBe(404);
    expect(
      (
        await api('POST', '/v1/transaction-authorizations', {
          ...body,
          spec: { ...body.spec, maxOrders: 3 },
        })
      ).statusCode,
    ).toBe(409);
    await activities.acceptApproval(f.input, f.approval!.approvalId);
    expect(await activities.requestApprovalIfNeeded(f.input, f.step)).toBeNull();
    await activities.executeStep(f.input, f.step);
    expect(dispatched).toBe(1);
    const second = await order();
    expect(second.approval).toBeNull();
    const third = await order();
    expect(third.approval).not.toBeNull();
    const listed = (await api('GET', '/v1/transaction-authorizations')).json().items;
    expect(listed.find((g: { id: string }) => g.id === result.authorization.id)).toMatchObject({
      usedOrders: 2,
      usedTotalMinor: 3000,
    });
    expect(
      (
        await api(
          'POST',
          `/v1/transaction-authorizations/${result.authorization.id}/revoke`,
          {},
          foreignAuth,
        )
      ).statusCode,
    ).toBe(404);
    expect(
      (await api('POST', `/v1/transaction-authorizations/${result.authorization.id}/revoke`, {}))
        .statusCode,
    ).toBe(200);
    const before = dispatched;
    await expect(activities.executeStep(second.input, second.step)).rejects.toMatchObject({
      type: 'ApprovalStale',
    });
    expect(dispatched).toBe(before);
    await withTenant(h.db, tenantId, (tx) =>
      tx
        .updateTable('tasks')
        .set({ status: 'COMPLETED' })
        .where('id', '=', f.input.taskId)
        .execute(),
    );
    const signalsBefore = h.runtime.signals.length;
    const recovered = await api('POST', '/v1/transaction-authorizations', body);
    expect(recovered.statusCode).toBe(200);
    expect(recovered.json()).toMatchObject({
      approvalId: f.approval!.approvalId,
      authorization: { id: result.authorization.id, status: 'REVOKED', usedOrders: 2 },
    });
    expect(h.runtime.signals.length).toBe(signalsBefore);
  });
  it('leaves no grant when the first pending order differs from the reviewed scope', async () => {
    const f = await order('burger');
    const before = (await api('GET', '/v1/transaction-authorizations')).json().items.length;
    const r = await api('POST', '/v1/transaction-authorizations', {
      requestId: uuidv7(),
      spec: specFor(simulationOrderIntent('pizza', uuidv7())),
      approvalId: f.approval!.approvalId,
    });
    expect([400, 409]).toContain(r.statusCode);
    expect((await api('GET', '/v1/transaction-authorizations')).json().items).toHaveLength(before);
    const row = await withTenant(h.db, tenantId, (tx) =>
      tx
        .selectFrom('approvals')
        .select('status')
        .where('id', '=', f.approval!.approvalId)
        .executeTakeFirstOrThrow(),
    );
    expect(row.status).toBe('PENDING');
    expect(
      (await api('GET', '/v1/transaction-authorizations', undefined, foreignAuth)).json().items,
    ).toEqual([]);
  });
  it('recovers a failed workflow signal with one reservation and returns a receipt while running after revocation', async () => {
    const f = await order('burger');
    const body = {
      requestId: uuidv7(),
      spec: specFor(f.args.intent),
      approvalId: f.approval!.approvalId,
    };
    const original = h.runtime.approve.bind(h.runtime);
    const signal = vi.spyOn(h.runtime, 'approve').mockImplementationOnce(async () => {
      throw new Error('lost workflow signal');
    });
    try {
      expect((await api('POST', '/v1/transaction-authorizations', body)).statusCode).toBe(500);
      signal.mockImplementation(original);
      const recovered = await api('POST', '/v1/transaction-authorizations', body);
      expect(recovered.statusCode).toBe(200);
      const grant = recovered.json().authorization;
      expect(grant).toMatchObject({ usedOrders: 1, usedTotalMinor: 800 });
      expect(signal).toHaveBeenCalledTimes(2);
      const uses = await withTenant(h.db, tenantId, (tx) =>
        tx
          .selectFrom('transaction_authorization_uses')
          .select('id')
          .where('approval_id', '=', f.approval!.approvalId)
          .execute(),
      );
      expect(uses).toHaveLength(1);
      await activities.acceptApproval(f.input, f.approval!.approvalId);
      expect(
        (await api('POST', `/v1/transaction-authorizations/${grant.id}/revoke`, {})).statusCode,
      ).toBe(200);
      const again = await api('POST', '/v1/transaction-authorizations', body);
      expect(again.statusCode).toBe(200);
      expect(again.json().authorization).toMatchObject({
        id: grant.id,
        status: 'REVOKED',
        usedOrders: 1,
      });
      expect(signal).toHaveBeenCalledTimes(2);
    } finally {
      signal.mockRestore();
    }
  });
});
