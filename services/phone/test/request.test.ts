/**
 * 「電話して」から仕事へ。営業は Oathra の連絡先で相手が一人に決まったときだけ仕事になる。
 */
import { describe, expect, it, vi } from 'vitest';
import { phoneTaskFor } from '../src/request.js';
import { OathraError, type OathraClient } from '../src/oathra.js';

const client = (salesContext: OathraClient['salesContext']) =>
  ({ salesContext: vi.fn(salesContext) }) as unknown as OathraClient;

const context = async () => ({
  products: [{ id: 'p1', name: 'デモ商品' }],
  contacts: [{ id: 'c1', name: '田中', company: null, callPermitted: true }],
});

describe('phoneTaskFor', () => {
  it('電話の頼みでなければ何もしない（Oathra も呼ばない）', async () => {
    const c = client(context);
    expect(await phoneTaskFor('資料をまとめて', c)).toBeNull();
    expect(c.salesContext).not.toHaveBeenCalled();
  });

  it('営業電話は相手と商品を決めて phone.sales にする', async () => {
    expect(
      await phoneTaskFor('田中さんにデモ商品の資料送付で営業電話して', client(context)),
    ).toEqual({
      kind: 'task',
      request: {
        kind: 'phone.sales',
        title: '営業電話: 田中',
        input: {
          contact_id: 'c1',
          contact_name: '田中',
          product_id: 'p1',
          product_name: 'デモ商品',
          request: '田中さんにデモ商品の資料送付で営業電話して',
          goal: 'materials',
        },
      },
    });
  });

  it('伝言の電話は番号ごと phone.call にする', async () => {
    const decision = await phoneTaskFor('090-1234-5678に電話して10時集合と伝えて', client(context));
    expect(decision).toMatchObject({
      kind: 'task',
      request: { kind: 'phone.call', input: { phone: '090-1234-5678' } },
    });
  });

  it('接続が無い・委任が無い・相手が決まらないときは、直し方を返す', async () => {
    expect(await phoneTaskFor('田中さんに営業電話して', null)).toMatchObject({ kind: 'notice' });
    const refused = client(async () => {
      throw new OathraError('sales_not_delegated', 403);
    });
    expect(await phoneTaskFor('田中さんに営業電話して', refused)).toEqual({
      kind: 'notice',
      notice: expect.stringContaining('営業電話を任せていません'),
    });
    expect(await phoneTaskFor('高橋さんに営業電話して', client(context))).toMatchObject({
      kind: 'notice',
    });
  });
});
