/** Real PostgreSQL/RLS + HTTP. Task runtime is in-memory; no provider calls. */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { SendTurnRequest, uuidv7, type TokenResponse } from '@genie/contracts';
import { withTenant } from '@genie/db';
import { ConversationService } from '@genie/service-conversation';
import { makeTestApp, makeTokens, testDbConfig, type TestApp } from './support.js';

const url = process.env['TEST_DATABASE_URL'];
describe.skipIf(!url)('durable turn acceptance recovery', () => {
  let h: TestApp;
  let conversations: ConversationService;
  let auth: { authorization: string };
  let tenantId: string;
  let userId: string;
  let foreignAuth: { authorization: string };
  const start = async () =>
    (
      await h.app.inject({ method: 'POST', url: '/v1/conversations', headers: auth, payload: {} })
    ).json<{ id: string }>().id;
  const post = (id: string, payload: Record<string, unknown>) =>
    h.app.inject({ method: 'POST', url: `/v1/conversations/${id}/turns`, headers: auth, payload });
  const get = (id: string, key: string, headers = auth) =>
    h.app.inject({ method: 'GET', url: `/v1/conversations/${id}/requests/${key}`, headers });
  const count = (id: string) =>
    withTenant(h.db, tenantId, async (tx) => ({
      turns: (await tx.selectFrom('turns').select('id').where('conversation_id', '=', id).execute())
        .length,
      tasks: (await tx.selectFrom('tasks').select('id').where('conversation_id', '=', id).execute())
        .length,
    }));
  beforeAll(async () => {
    h = await makeTestApp({
      dbConfig: testDbConfig(url!, process.env['TEST_IDENTITY_DATABASE_URL']),
      tokens: await makeTokens(),
    });
    conversations = new ConversationService({ db: h.db });
    const token = async () => {
      const res = await h.app.inject({
        method: 'POST',
        url: '/v1/auth/dev/token',
        payload: { email: `${uuidv7()}@example.com`, display_name: 'Recovery fixture' },
      });
      expect(res.statusCode).toBe(200);
      return { authorization: `Bearer ${res.json<TokenResponse>().access_token}` };
    };
    auth = await token();
    foreignAuth = await token();
    const me = (await h.app.inject({ method: 'GET', url: '/v1/me', headers: auth })).json();
    tenantId = me.tenant.id;
    userId = me.user.id;
  });
  afterAll(async () => {
    await h?.close();
  });

  it('recovers a discarded accepted response and repeats without another turn/task', async () => {
    const id = await start();
    const request_id = uuidv7();
    const payload = { request_id, text: '天気を調べて' };
    const accepted = await post(id, payload);
    expect(accepted.statusCode).toBe(202);
    expect(accepted.json().task_id).toBeTruthy();
    // Client discards POST response and recovers solely using persisted request ID.
    const recovered = await get(id, request_id);
    expect(recovered.json()).toEqual({ status: 'resolved', response: accepted.json() });
    const repeat = await post(id, { text: payload.text, modality: 'text', request_id });
    expect(repeat.statusCode).toBe(202);
    expect(repeat.json()).toEqual(accepted.json());
    expect(await count(id)).toEqual({ turns: 1, tasks: 1 });
  });
  it('stores clarification and unavailable-operation notices, including the answer', async () => {
    // 「送信して」は承認カード付きの画面操作（computer.run）になるので、ここでは使わない。
    // まだ自動では進められない依頼（書き取り）の例に替える。
    for (const text of ['これ何？', 'そのまま書き取って']) {
      const id = await start();
      const request_id = uuidv7();
      const res = await post(id, { text, request_id });
      expect([200, 202]).toContain(res.statusCode);
      expect((await get(id, request_id)).json()).toEqual({
        status: 'resolved',
        response: res.json(),
      });
      expect((await post(id, { text, request_id })).json()).toEqual(res.json());
      expect((await count(id)).tasks).toBe(0);
    }
  });
  it('rejects changed input without interrupting or appending another turn', async () => {
    const id = await start();
    const request_id = uuidv7();
    await post(id, { text: 'これ何？', request_id });
    const before = await count(id);
    expect((await post(id, { text: '別の入力', interrupt: true, request_id })).statusCode).toBe(
      409,
    );
    expect(await count(id)).toEqual(before);
    expect((await conversations.recentTurns(tenantId, id)).at(-1)?.interrupted).toBe(false);
  });
  it('concurrent same-key submission executes only once, returning conflict while pending', async () => {
    const id = await start();
    const request_id = uuidv7();
    let release!: () => void;
    let entered!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const original = h.tasks.create.bind(h.tasks);
    const spy = vi.spyOn(h.tasks, 'create').mockImplementationOnce(async (input) => {
      entered();
      await blocked;
      return original(input);
    });
    try {
      const first = post(id, { text: '天気を調べて', request_id }).then((res) => res);
      await started;
      expect((await get(id, request_id)).json()).toEqual({ status: 'pending' });
      expect((await post(id, { text: '天気を調べて', request_id })).statusCode).toBe(409);
      release();
      expect((await first).statusCode).toBe(202);
      expect(spy).toHaveBeenCalledTimes(1);
      expect(await count(id)).toEqual({ turns: 1, tasks: 1 });
    } finally {
      release();
      spy.mockRestore();
    }
  });
  it('only one concurrent database reservation wins the unique request key', async () => {
    const id = await start();
    const request_id = uuidv7();
    const body = SendTurnRequest.parse({ text: '天気を調べて', request_id });
    const receipts = await Promise.all(
      Array.from({ length: 20 }, () =>
        conversations.reserveRequest(tenantId, userId, id, request_id, body),
      ),
    );
    expect(receipts.filter((r) => r.fresh)).toHaveLength(1);
    expect(new Set(receipts.map((r) => r.turnId)).size).toBe(1);
    expect(await count(id)).toEqual({ turns: 0, tasks: 0 });
  });
  it('retains an accepted task when its runtime acknowledgement is lost', async () => {
    const id = await start();
    const request_id = uuidv7();
    const original = h.tasks.create.bind(h.tasks);
    const spy = vi.spyOn(h.tasks, 'create').mockImplementationOnce(async (input) => {
      await original(input);
      throw new Error('injected lost runtime acknowledgement');
    });
    try {
      const response = await post(id, { text: '天気を調べて', request_id });
      expect(response.statusCode).toBe(202);
      expect(response.json().task_id).toBeTruthy();
      expect(response.json().notice).toBeNull();
      expect((await get(id, request_id)).json()).toEqual({
        status: 'resolved',
        response: response.json(),
      });
      expect(await count(id)).toEqual({ turns: 1, tasks: 1 });
    } finally {
      spy.mockRestore();
    }
  });
  it('an abandoned reservation remains pending and does not resume execution', async () => {
    const id = await start();
    const request_id = uuidv7();
    const body = SendTurnRequest.parse({ text: '天気を調べて', request_id });
    await conversations.reserveRequest(tenantId, userId, id, request_id, body);
    expect((await get(id, request_id)).json()).toEqual({ status: 'pending' });
    expect((await post(id, body)).statusCode).toBe(409);
    expect(await count(id)).toEqual({ turns: 0, tasks: 0 });
  });
  it('recovers a task committed before response finalization without dispatching it again', async () => {
    const id = await start();
    const request_id = uuidv7();
    const body = SendTurnRequest.parse({ text: '天気を調べて', request_id });
    const receipt = await conversations.reserveRequest(tenantId, userId, id, request_id, body);
    const turn = await conversations.append({
      tenantId,
      conversationId: id,
      id: receipt.turnId,
      role: 'user',
      modality: 'text',
      text: body.text,
    });
    const prepared = {
      turn,
      needs_clarification: false,
      intent: 'looking_up',
      task_id: null,
      notice: null,
    };
    await conversations.prepareRequest(tenantId, userId, id, request_id, prepared);
    const { task } = await h.tasks.create({
      tenantId,
      userId,
      request: { kind: 'echo', input: {}, conversation_id: id as never },
      idempotencyKey: `turn:${receipt.turnId}`,
    });
    const spy = vi.spyOn(h.tasks, 'create');
    try {
      expect((await get(id, request_id)).json()).toEqual({
        status: 'resolved',
        response: { ...prepared, task_id: task.id },
      });
      expect((await post(id, body)).json().task_id).toBe(task.id);
      expect(spy).not.toHaveBeenCalled();
      expect(await count(id)).toEqual({ turns: 1, tasks: 1 });
    } finally {
      spy.mockRestore();
    }
  });
  it('hides receipts from other tenants/users and validates request IDs', async () => {
    const id = await start();
    const request_id = uuidv7();
    await post(id, { text: 'これ何？', request_id });
    expect((await get(id, request_id, foreignAuth)).statusCode).toBe(404);
    expect((await get(id, uuidv7())).statusCode).toBe(404);
    expect((await get(id, 'invalid')).statusCode).toBe(400);
    // Same tenant but different user must be invisible as well.
    await expect(
      conversations.requestStatus(tenantId, uuidv7(), id, request_id),
    ).rejects.toMatchObject({ code: 'common.not_found' });
    await expect(
      conversations.reserveRequest(tenantId, uuidv7(), id, uuidv7(), {}),
    ).rejects.toMatchObject({ code: 'common.not_found' });
  });
});
