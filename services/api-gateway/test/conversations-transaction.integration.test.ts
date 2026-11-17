/**
 * Independent transaction entry verification: real PostgreSQL/RLS + HTTP routes.
 * InMemoryTaskRuntime records dispatch; this does not execute checkout or place an order.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { type Task, type TokenResponse, uuidv7 } from '@genie/contracts';
import { withTenant } from '@genie/db';
import { ConversationService } from '@genie/service-conversation';
import { makeTestApp, makeTokens, testDbConfig, type TestApp } from './support.js';

const url = process.env['TEST_DATABASE_URL'];

describe.skipIf(!url)(
  'simulation orders and official-site handoffs through conversation HTTP',
  () => {
    let h: TestApp;
    let auth: { authorization: string };
    let foreignAuth: { authorization: string };
    let tenantId: string;

    const start = async () => {
      const response = await h.app.inject({
        method: 'POST',
        url: '/v1/conversations',
        headers: auth,
        payload: {},
      });
      expect(response.statusCode).toBe(201);
      return response.json<{ id: string }>().id;
    };
    const post = (id: string, payload: Record<string, unknown>, headers = auth) =>
      h.app.inject({ method: 'POST', url: `/v1/conversations/${id}/turns`, headers, payload });
    const counts = (id: string) =>
      withTenant(h.db, tenantId, async (tx) => ({
        turns: (
          await tx.selectFrom('turns').select('id').where('conversation_id', '=', id).execute()
        ).length,
        tasks: (
          await tx.selectFrom('tasks').select('id').where('conversation_id', '=', id).execute()
        ).length,
      }));
    const getTask = async (id: string) => {
      const response = await h.app.inject({ method: 'GET', url: `/v1/tasks/${id}`, headers: auth });
      expect(response.statusCode).toBe(200);
      return response.json<Task>();
    };

    beforeAll(async () => {
      h = await makeTestApp({
        dbConfig: testDbConfig(url!, process.env['TEST_IDENTITY_DATABASE_URL']),
        tokens: await makeTokens(),
      });
      const issue = async () => {
        const response = await h.app.inject({
          method: 'POST',
          url: '/v1/auth/dev/token',
          payload: {
            email: `transaction-${uuidv7()}@example.com`,
            display_name: 'Fictional order test',
          },
        });
        expect(response.statusCode).toBe(200);
        return { authorization: `Bearer ${response.json<TokenResponse>().access_token}` };
      };
      auth = await issue();
      foreignAuth = await issue();
      const me = await h.app.inject({ method: 'GET', url: '/v1/me', headers: auth });
      tenantId = me.json<{ tenant: { id: string } }>().tenant.id;
    });
    afterAll(async () => {
      await h?.close();
    });

    it.each(['マックデリバリーに会員登録して', 'マクドナルドの会員登録を手伝って'])(
      'accepts only native registration preparation for %s, without email/password arguments',
      async (text) => {
        const conversation = await start();
        const request_id = uuidv7();
        const response = await post(conversation, { text, request_id });
        expect(response.statusCode).toBe(202);
        expect(response.json().notice).toContain('アカウントはまだ作成していません');
        expect(response.json().notice).toContain('規約への同意・本人確認');
        const task = await getTask(response.json().task_id);
        expect(task).toMatchObject({
          kind: 'account.registration.prepare',
          title: '会員登録の準備（未登録）',
          input: { service: 'mcdelivery_jp' },
          status: 'PENDING',
          result_artifact_id: null,
        });
        expect(Object.keys(task.input)).toEqual(['service']);
        expect((await post(conversation, { text, request_id })).json()).toEqual(response.json());
        expect(await counts(conversation)).toEqual({ turns: 1, tasks: 1 });
        expect(h.runtime.signals).toEqual([]);
      },
    );

    it('retains the incomplete-registration disclosure after a lost dispatch acknowledgement', async () => {
      const conversation = await start();
      const original = h.tasks.create.bind(h.tasks);
      const spy = vi.spyOn(h.tasks, 'create').mockImplementationOnce(async (input) => {
        await original(input);
        throw new Error('lost registration acknowledgement');
      });
      try {
        const payload = { text: 'マックデリバリーに会員登録して', request_id: uuidv7() };
        const response = await post(conversation, payload);
        expect(response.statusCode).toBe(202);
        expect(response.json().notice).toContain('アカウントはまだ作成していません');
        expect((await getTask(response.json().task_id)).kind).toBe('account.registration.prepare');
        expect((await post(conversation, payload)).json()).toEqual(response.json());
        expect(await counts(conversation)).toEqual({ turns: 1, tasks: 1 });
      } finally {
        spy.mockRestore();
      }
    });

    it.each([
      '「マックデリバリーに会員登録して」',
      'マクドナルドの会員登録を手伝ってという文を書いて',
      'マックデリバリーに会員登録してはいけない',
      'マックデリバリーに会員登録できますか？',
    ])('does not dispatch registration or computer automation for %s', async (text) => {
      const conversation = await start();
      const response = await post(conversation, { text, request_id: uuidv7() });
      expect(response.statusCode).toBe(202);
      expect(response.json().intent).toBe('talking');
      expect(response.json().task_id).toBeNull();
      expect(await counts(conversation)).toEqual({ turns: 1, tasks: 0 });
    });

    const orderState = async (id: string) =>
      (await h.app.inject({ method: 'GET', url: `/v1/conversations/${id}`, headers: auth })).json()
        .state.checkout_draft;
    const collectOrder = async (conversation: string) => {
      const request_id = uuidv7();
      const first = await post(conversation, { text: 'マックデリバリーを注文して', request_id });
      expect(first.statusCode).toBe(200);
      expect(first.json().answer.text).toContain('商品名と数量');
      expect(
        (await post(conversation, { text: 'マックデリバリーを注文して', request_id })).json(),
      ).toEqual(first.json());
      expect(await counts(conversation)).toEqual({ turns: 2, tasks: 0 });
      expect(
        (
          await post(conversation, { text: 'ビッグマック2個、ポテトM1個', request_id: uuidv7() })
        ).json().answer.text,
      ).toContain('いつ');
      expect(
        (await post(conversation, { text: 'できるだけ早く', request_id: uuidv7() })).json().answer
          .text,
      ).toContain('合計の上限');
      expect((await counts(conversation)).tasks).toBe(0);
    };

    it('collects real order terms, keeps them across pause/resume, and dispatches one unsubmitted cart task', async () => {
      const conversation = await start();
      await collectOrder(conversation);
      const initial = await orderState(conversation);
      expect((await post(conversation, { text: '注文を中断して' })).json().answer.text).toContain(
        '中断',
      );
      await post(conversation, { text: '今日の天気は？' });
      expect(await orderState(conversation)).toEqual({ ...initial, status: 'paused' });
      expect((await post(conversation, { text: '注文を再開して' })).json().answer.text).toContain(
        '合計の上限',
      );
      const request_id = uuidv7();
      const ready = await post(conversation, { text: '上限2000円', request_id });
      expect(ready.statusCode).toBe(202);
      expect(ready.json().notice).toContain('注文・支払いは確定しません');
      const task = await getTask(ready.json().task_id);
      expect(task).toMatchObject({
        kind: 'checkout.prepare',
        status: 'PENDING',
        title: 'カートの準備（未注文）',
        result_artifact_id: null,
      });
      expect(task.input).toEqual({
        service: 'mcdelivery_jp',
        orderKey: initial.orderKey,
        itemsText: 'ビッグマック2個、ポテトM1個',
        requestedTime: 'asap',
        maxTotalMinor: 2000,
        currency: 'JPY',
      });
      expect(await orderState(conversation)).toMatchObject({
        status: 'dispatched',
        taskId: task.id,
        orderKey: initial.orderKey,
      });
      expect((await post(conversation, { text: '上限2000円', request_id })).json()).toEqual(
        ready.json(),
      );
      const repeated = await post(conversation, {
        text: 'マックデリバリーを注文して',
        request_id: uuidv7(),
      });
      expect(repeated.json().task_id).toBe(task.id);
      const tasks = await withTenant(h.db, tenantId, (tx) =>
        tx
          .selectFrom('tasks')
          .select('id')
          .where('conversation_id', '=', conversation)
          .where('kind', '=', 'checkout.prepare')
          .execute(),
      );
      expect(tasks).toHaveLength(1);
      expect(h.runtime.signals).toEqual([]);
    });

    it('keeps uncertain prices and unrelated or private answers out of order terms', async () => {
      const conversation = await start();
      await collectOrder(conversation);
      const initial = await orderState(conversation);
      for (const text of [
        'ポテト2個で500円',
        '2000円くらい',
        '資料を2枚印刷して',
        '住所は架空市架空町',
      ]) {
        await post(conversation, { text, request_id: uuidv7() });
        expect(await orderState(conversation)).toEqual(initial);
      }
      expect(initial.maxTotalMinor).toBeNull();
    });

    it('recovers a lost checkout task acknowledgement without changing terms or task identity', async () => {
      const conversation = await start();
      await collectOrder(conversation);
      const original = h.tasks.create.bind(h.tasks);
      const spy = vi.spyOn(h.tasks, 'create').mockImplementationOnce(async (input) => {
        await original(input);
        throw new Error('injected lost checkout acknowledgement');
      });
      try {
        const payload = { text: '上限2000円', request_id: uuidv7() };
        const response = await post(conversation, payload);
        expect(response.json().task_id).toBeTruthy();
        expect((await getTask(response.json().task_id)).kind).toBe('checkout.prepare');
        expect((await post(conversation, payload)).json()).toEqual(response.json());
        expect((await counts(conversation)).tasks).toBe(1);
      } finally {
        spy.mockRestore();
      }
    });

    it('resumes failed dispatch using the original completion turn and immutable terms', async () => {
      const conversation = await start();
      await collectOrder(conversation);
      const spy = vi
        .spyOn(h.tasks, 'create')
        .mockRejectedValueOnce(new Error('injected before durable insertion'));
      const failed = await post(conversation, { text: '上限2000円', request_id: uuidv7() });
      spy.mockRestore();
      expect(failed.json().task_id).toBeNull();
      expect(failed.json().notice).toContain('始められません');
      const before = await orderState(conversation);
      const resumed = await post(conversation, { text: '注文を再開して', request_id: uuidv7() });
      expect(resumed.json().task_id).toBeTruthy();
      expect((await getTask(resumed.json().task_id)).input).toMatchObject({
        orderKey: before.orderKey,
        maxTotalMinor: 2000,
      });
      expect((await orderState(conversation)).dispatchTurnId).toBe(before.dispatchTurnId);
      expect((await counts(conversation)).tasks).toBe(1);
    });

    it('reconciles a resumed request after the response write fails, without exposing internal receipt metadata', async () => {
      const conversation = await start();
      await collectOrder(conversation);
      const failedCreate = vi
        .spyOn(h.tasks, 'create')
        .mockRejectedValueOnce(new Error('before durable insertion'));
      await post(conversation, { text: '上限2000円', request_id: uuidv7() });
      failedCreate.mockRestore();
      const request_id = uuidv7();
      const failedResponse = vi
        .spyOn(ConversationService.prototype, 'finishRequest')
        .mockRejectedValueOnce(new Error('after task accepted'));
      try {
        expect((await post(conversation, { text: '注文を再開して', request_id })).statusCode).toBe(
          500,
        );
      } finally {
        failedResponse.mockRestore();
      }
      const receipt = await h.app.inject({
        method: 'GET',
        url: `/v1/conversations/${conversation}/requests/${request_id}`,
        headers: auth,
      });
      expect(receipt.statusCode).toBe(200);
      expect(receipt.json().status).toBe('resolved');
      expect(receipt.json().response.task_id).toBeTruthy();
      expect(receipt.json().response.notice).toContain('確定しません');
      expect(receipt.json().response.__dispatch_turn_id).toBeUndefined();
      expect((await counts(conversation)).tasks).toBe(1);
      expect((await post(conversation, { text: '注文を再開して', request_id })).json()).toEqual(
        receipt.json().response,
      );
    });

    it('dispatches only one task when completing turns arrive concurrently', async () => {
      const conversation = await start();
      await collectOrder(conversation);
      const responses = await Promise.all([
        post(conversation, { text: '上限2000円', request_id: uuidv7() }),
        post(conversation, { text: '上限2500円', request_id: uuidv7() }),
      ]);
      expect(responses.every((r) => r.statusCode === 202)).toBe(true);
      expect(responses[0]!.json().task_id).toBeTruthy();
      expect(responses[0]!.json().task_id).toBe(responses[1]!.json().task_id);
      expect((await counts(conversation)).tasks).toBe(1);
      const stored = await orderState(conversation);
      const task = await getTask(responses[0]!.json().task_id);
      expect(task.input).toMatchObject({
        maxTotalMinor: stored.maxTotalMinor,
        orderKey: stored.orderKey,
      });
    });

    it.each([
      ['マクドナルドの注文画面を開いて', 'mcdelivery_jp'],
      ['ドミノの注文サイトを開いて', 'dominos_jp'],
    ])('keeps real merchant %s as an explicit unsubmitted site handoff', async (text, service) => {
      const conversation = await start();
      const request_id = uuidv7();
      const response = await post(conversation, { text, request_id });
      expect(response.statusCode).toBe(202);
      const accepted = response.json();
      expect(accepted.notice).toContain('カートの準備・注文・支払いを行いません');
      const task = await getTask(accepted.task_id);
      expect(task).toMatchObject({
        kind: 'checkout.assist',
        title: '注文画面への引き継ぎ（未注文）',
        input: { service },
        status: 'PENDING',
        result_artifact_id: null,
      });
      expect(Object.keys(task.input)).toEqual(['service']);
      expect([...h.runtime.started.values()].find((input) => input.taskId === task.id)?.kind).toBe(
        'checkout.assist',
      );
      const repeated = await post(conversation, { text, request_id });
      expect(repeated.statusCode).toBe(202);
      expect(repeated.json()).toEqual(accepted);
      expect(await counts(conversation)).toEqual({ turns: 1, tasks: 1 });
    });

    it('preserves the unsubmitted disclosure after a lost handoff creation acknowledgement', async () => {
      const conversation = await start();
      const request_id = uuidv7();
      const payload = { text: 'マクドナルドの注文サイトを開いて', request_id };
      const original = h.tasks.create.bind(h.tasks);
      const spy = vi.spyOn(h.tasks, 'create').mockImplementationOnce(async (input) => {
        await original(input);
        throw new Error('injected lost handoff acknowledgement');
      });
      try {
        const response = await post(conversation, payload);
        expect(response.statusCode).toBe(202);
        const accepted = response.json();
        expect(accepted.notice).toContain('カートの準備・注文・支払いを行いません');
        expect((await getTask(accepted.task_id)).kind).toBe('checkout.assist');
        expect((await post(conversation, payload)).json()).toEqual(accepted);
        expect(await counts(conversation)).toEqual({ turns: 1, tasks: 1 });
      } finally {
        spy.mockRestore();
      }
    });

    it.each(['「マクドナルドの注文画面を開いて」', 'ドミノの注文サイトを開いてという文を書いて'])(
      'keeps quoted merchant requests out of screen and order automation: %s',
      async (text) => {
        const conversation = await start();
        const response = await post(conversation, { text, request_id: uuidv7() });
        expect(response.statusCode).toBe(202); // Chat also uses the asynchronous task response contract.
        expect(response.json().intent).toBe('talking');
        expect(response.json().task_id).toBeNull();
        expect(await counts(conversation)).toEqual({ turns: 1, tasks: 0 });
      },
    );

    it.each([
      {
        text: '模擬ピザを注文して',
        kind: 'delivery',
        id: 'demo-pizza',
        label: '模擬マルゲリータ',
        quantity: 1,
        options: ['M', 'レギュラー生地'],
        budget: 1500,
      },
      {
        text: '模擬バーガーを注文してください。',
        kind: 'delivery',
        id: 'demo-burger',
        label: '模擬バーガー',
        quantity: 1,
        options: ['セットなし'],
        budget: 800,
      },
      {
        text: '模擬株を注文して！',
        kind: 'stock_paper',
        id: 'GENIE.TEST',
        label: '模擬株式 GENIE.TEST',
        quantity: 2,
        options: [],
        budget: 200,
      },
    ])(
      'persists only fictional terms and a turn-bound order identity for $text',
      async (example) => {
        const conversation = await start();
        const before = h.runtime.started.size;
        const response = await post(conversation, { text: example.text, request_id: uuidv7() });
        expect(response.statusCode).toBe(202);
        const accepted = response.json();
        expect(accepted).toMatchObject({
          needs_clarification: false,
          intent: 'doing',
          notice: null,
        });
        const task = await getTask(accepted.task_id);
        expect(task).toMatchObject({
          kind: 'transaction.order',
          title: '模擬注文（課金なし）',
          status: 'PENDING',
          conversation_id: conversation,
          result_artifact_id: null,
        });
        const paper = example.kind === 'stock_paper';
        expect(task.input).toEqual({
          intent: {
            kind: example.kind,
            mode: 'simulation',
            provider: 'genie.simulation',
            account: 'demo-account',
            orderKey: `turn:${accepted.turn.id}`,
            currency: 'JPY',
            paymentMethodRef: 'demo-no-charge',
            destination: {
              id: 'demo-destination',
              label: paper ? '模擬口座（資金移動なし）' : '模擬配送先（配達なし）',
            },
            items: [
              {
                id: example.id,
                label: example.label,
                quantity: example.quantity,
                options: example.options,
              },
            ],
            maxTotalMinor: example.budget,
            ...(paper
              ? {
                  stock: {
                    symbol: 'GENIE.TEST',
                    market: 'SIM',
                    side: 'BUY',
                    quantity: 2,
                    orderType: 'LIMIT',
                    limitPriceMinor: 100,
                    timeInForce: 'DAY',
                  },
                }
              : { requestedTime: 'asap' }),
          },
        });
        const dispatch = [...h.runtime.started.values()].find((input) => input.taskId === task.id);
        expect(dispatch).toMatchObject({ kind: task.kind, input: task.input, tenantId });
        expect(h.runtime.started.size).toBe(before + 1);
        expect(h.runtime.signals).toEqual([]); // Entry never auto-approves the transaction.
        expect(await counts(conversation)).toEqual({ turns: 1, tasks: 1 });
      },
    );

    it.each([
      'ピザを注文して',
      'マクドナルドを注文して',
      '株を注文して',
      '模擬ピザを注文しないで',
      '「模擬ピザを注文して」',
      '模擬ピザを注文してという文を書いて',
      '模擬ピザを注文して。予算は100円',
      '模擬ピザを注文して、2枚にして',
      '模擬ピザを注文して\n実際のカードで支払って',
    ])(
      'does not silently replace a different request with fixed simulation terms: %s',
      async (text) => {
        const conversation = await start();
        const response = await post(conversation, { text, request_id: uuidv7() });
        expect([200, 202]).toContain(response.statusCode);
        const body = response.json();
        if (body.task_id) expect((await getTask(body.task_id)).kind).not.toBe('transaction.order');
        const transactionTasks = await withTenant(h.db, tenantId, (tx) =>
          tx
            .selectFrom('tasks')
            .select('id')
            .where('conversation_id', '=', conversation)
            .where('kind', '=', 'transaction.order')
            .execute(),
        );
        expect(transactionTasks).toEqual([]);
      },
    );

    it('recovers a lost runtime acknowledgement and repeats with the original order key and one task', async () => {
      const conversation = await start();
      const request_id = uuidv7();
      const payload = { text: '模擬ピザを注文して', request_id };
      const original = h.tasks.create.bind(h.tasks);
      const spy = vi.spyOn(h.tasks, 'create').mockImplementationOnce(async (input) => {
        await original(input);
        throw new Error('injected lost runtime acknowledgement');
      });
      try {
        const response = await post(conversation, payload);
        expect(response.statusCode).toBe(202);
        const accepted = response.json();
        expect(accepted.task_id).toBeTruthy();
        const recovered = await h.app.inject({
          method: 'GET',
          url: `/v1/conversations/${conversation}/requests/${request_id}`,
          headers: auth,
        });
        expect(recovered.statusCode).toBe(200);
        expect(recovered.json()).toEqual({ status: 'resolved', response: accepted });
        expect((await post(conversation, payload)).json()).toEqual(accepted);
        expect(spy).toHaveBeenCalledTimes(1);
        expect((await getTask(accepted.task_id)).input['intent']).toMatchObject({
          orderKey: `turn:${accepted.turn.id}`,
        });
        expect(await counts(conversation)).toEqual({ turns: 1, tasks: 1 });
      } finally {
        spy.mockRestore();
      }
    });

    it('rejects changed input for the accepted request key without replacing the order or dispatching again', async () => {
      const conversation = await start();
      const request_id = uuidv7();
      const accepted = (
        await post(conversation, { text: '模擬ピザを注文して', request_id })
      ).json();
      const before = h.runtime.started.size;
      const changed = await post(conversation, {
        text: '模擬株を注文して',
        request_id,
        interrupt: true,
      });
      expect(changed.statusCode).toBe(409);
      expect(h.runtime.started.size).toBe(before);
      expect(h.runtime.signals).toEqual([]);
      expect((await getTask(accepted.task_id)).input['intent']).toMatchObject({
        kind: 'delivery',
        items: [{ id: 'demo-pizza' }],
      });
      expect(await counts(conversation)).toEqual({ turns: 1, tasks: 1 });
    });

    it('does not expose or duplicate a simulation task through another tenant', async () => {
      const conversation = await start();
      const request_id = uuidv7();
      const payload = { text: '模擬バーガーを注文して', request_id };
      const accepted = (await post(conversation, payload)).json();
      const before = h.runtime.started.size;
      for (const endpoint of [
        `/v1/tasks/${accepted.task_id}`,
        `/v1/conversations/${conversation}/requests/${request_id}`,
      ])
        expect(
          (await h.app.inject({ method: 'GET', url: endpoint, headers: foreignAuth })).statusCode,
        ).toBe(404);
      expect((await post(conversation, payload, foreignAuth)).statusCode).toBe(404);
      expect(h.runtime.started.size).toBe(before);
      expect(await counts(conversation)).toEqual({ turns: 1, tasks: 1 });
    });
  },
);
