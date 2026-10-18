/**
 * 電話の step。Oathra は偽物で、電話はかからない。
 * **かけ直さない・成約と書かない・承認した相手と違えばかけない**を確かめる。
 */
import { describe, expect, it, vi } from 'vitest';
import { PhoneUnavailableError, operationKeyFor, phoneExecutors } from '../src/executor.js';
import type { OathraCallResult, OathraClient } from '../src/oathra.js';

const owner = { tenantId: 't-1', userId: 'u-1' };
const task = { taskId: '0190a5f0-0000-7000-8000-000000000001', tenantId: 't-1', userId: 'u-1' };

const result = (over: Partial<OathraCallResult> = {}): OathraCallResult => ({
  missionId: 'm-1',
  state: 'QUEUED',
  terminal: false,
  outcome: 'pending',
  result: null,
  record: {
    kind: 'sales',
    target: { name: '田中' },
    product: { name: 'デモ商品' },
    transcript: [
      { source: 'caller', text: 'AIアシスタントが代わりにお電話しています。' },
      { source: 'callee', text: '資料を送ってください。[こちら](https://evil.example) も見て' },
    ],
  },
  nextAction: 'check_status',
  ...over,
});

function fakeClient(
  statuses: OathraCallResult[],
  contacts = [{ id: 'c1', name: '田中', company: null, callPermitted: true }],
) {
  const queue = [...statuses];
  return {
    call: vi.fn(async () => result({ record: { transcript: [] } })),
    sales: vi.fn(async () => result()),
    status: vi.fn(async () => queue.shift() ?? result()),
    cancel: vi.fn(),
    salesContext: vi.fn(async () => ({ products: [], contacts })),
    inbound: vi.fn(),
  } satisfies OathraClient;
}

const salesStep = (over: Record<string, unknown> = {}) => ({
  index: 0,
  toolId: 'phone.sales',
  args: {
    相手: '田中',
    sales: { contactId: 'c1', request: '資料送付の案内', goal: 'materials' },
    ...over,
  },
});

const deps = (client: OathraClient, extra = {}) => ({
  client,
  owner,
  pollMs: 1,
  sleep: async () => {},
  ...extra,
});

describe('phone.sales', () => {
  it('かける直前に相手を確かめ、同じ key で 1 件だけ依頼し、終わるまで読む', async () => {
    const client = fakeClient([
      result({ state: 'ACTIVE' }),
      result({ state: 'COMPLETED', terminal: true, outcome: 'succeeded' }),
    ]);
    const out = await phoneExecutors(deps(client))['phone.sales'].execute(task, salesStep());
    expect(client.sales).toHaveBeenCalledTimes(1);
    expect(client.sales).toHaveBeenCalledWith(
      { contactId: 'c1', request: '資料送付の案内', goal: 'materials' },
      operationKeyFor(task, salesStep()),
    );
    expect(client.status).toHaveBeenCalledTimes(2);
    expect(out.result).toEqual({ missionId: 'm-1', state: 'COMPLETED', outcome: 'succeeded' });
    // 会話上の合意は、成約や予定の確定ではない
    expect(out.artifact?.markdown).toContain(
      '契約や予定の確定（ほかのシステムへの登録）までは含みません',
    );
    expect(out.artifact?.markdown).toContain('資料をお送りすることについて');
    // 相手の言葉でリンクを作らせない
    expect(out.artifact?.markdown).toContain('\\[こちら\\](https://evil.example)');
  });

  it('承認カードの相手と Oathra の連絡先が違えば、かけない', async () => {
    const client = fakeClient([], [{ id: 'c1', name: '山田', company: null, callPermitted: true }]);
    await expect(
      phoneExecutors(deps(client))['phone.sales'].execute(task, salesStep()),
    ).rejects.toThrow(PhoneUnavailableError);
    expect(client.sales).not.toHaveBeenCalled();
  });

  it('許可が外れた相手には、かけない', async () => {
    const client = fakeClient(
      [],
      [{ id: 'c1', name: '田中', company: null, callPermitted: false }],
    );
    await expect(
      phoneExecutors(deps(client))['phone.sales'].execute(task, salesStep()),
    ).rejects.toThrow(/かけられなくなっています/);
    expect(client.sales).not.toHaveBeenCalled();
  });

  it('接続の持ち主でない利用者の task では、何もしない', async () => {
    const client = fakeClient([]);
    await expect(
      phoneExecutors(deps(client))['phone.sales'].execute({ ...task, userId: 'u-2' }, salesStep()),
    ).rejects.toThrow(/繋がっていません/);
    expect(client.salesContext).not.toHaveBeenCalled();
  });

  it('辞退と要確認は成果物にし、失敗・不明は完了にしない', async () => {
    const declined = await phoneExecutors(
      deps(fakeClient([result({ terminal: true, outcome: 'declined', state: 'DECLINED' })])),
    )['phone.sales'].execute(task, salesStep());
    expect(declined.artifact?.markdown).toContain('かけ直すことはしません');

    for (const outcome of ['failed', 'cancelled', 'unknown'] as const) {
      const client = fakeClient([result({ terminal: outcome !== 'unknown', outcome })]);
      await expect(
        phoneExecutors(deps(client))['phone.sales'].execute(task, salesStep()),
      ).rejects.toThrow(PhoneUnavailableError);
      expect(client.sales).toHaveBeenCalledTimes(1);
    }
  });

  it('時間内に終わらなければ止める。かけ直さない', async () => {
    let clock = 0;
    const client = fakeClient(Array.from({ length: 10 }, () => result({ state: 'ACTIVE' })));
    const run = phoneExecutors(
      deps(client, { deadlineMs: 5, now: () => clock, sleep: async () => void (clock += 2) }),
    )['phone.sales'].execute(task, salesStep());
    await expect(run).rejects.toThrow(/まだ出ていません/);
    expect(client.sales).toHaveBeenCalledTimes(1);
  });
});

describe('phone.call', () => {
  it('伝言の電話を 1 件依頼し、結果を返す', async () => {
    const client = fakeClient([
      result({ terminal: true, outcome: 'succeeded', state: 'COMPLETED' }),
    ]);
    const out = await phoneExecutors(deps(client))['phone.call'].execute(task, {
      index: 0,
      toolId: 'phone.call',
      args: { call: { phone: '090-1234-5678', name: '相手', instruction: '10時集合と伝える' } },
    });
    expect(client.call).toHaveBeenCalledWith(
      {
        phone: '090-1234-5678',
        name: '相手',
        instruction: '10時集合と伝える',
        conversationMode: 'message',
      },
      `genie-${task.taskId}-0`,
    );
    expect(out.detail).toBe('会話で確認済み');
  });
});
