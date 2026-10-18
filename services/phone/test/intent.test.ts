/**
 * 電話の頼みの見分け方。**頼まれていないものを電話にしない**ことを主に確かめる。
 */
import { describe, expect, it } from 'vitest';
import { phoneIntentOf, salesGoalOf, salesTargetOf } from '../src/intent.js';
import type { OathraSalesContext } from '../src/oathra.js';

describe('phoneIntentOf', () => {
  it.each([
    ['田中さんにデモ商品の資料送付について営業電話して', 'materials'],
    ['山田商事にテレアポして商談の日程を取って', 'meeting'],
    ['佐藤さんに新サービスの案内の電話をかけて', 'introduce'],
    ['鈴木さんとのアポを取って', 'meeting'],
  ])('「%s」は営業電話（%s）', (text, goal) => {
    expect(phoneIntentOf(text)).toEqual({ kind: 'sales', goal, request: text });
  });

  it('番号のある「電話して伝えて」は伝言の電話', () => {
    expect(phoneIntentOf('090-1234-5678 に電話して、明日の集合は10時だと伝えて')).toEqual({
      kind: 'call',
      phone: '090-1234-5678',
      request: '090-1234-5678 に電話して、明日の集合は10時だと伝えて',
    });
  });

  it.each([
    '営業電話のコツを教えて',
    '田中さんの電話番号を調べて',
    '昨日、田中さんと電話で話した内容をまとめて',
    '田中さんには営業電話をかけないで',
    '営業電話はしてはいけない',
    '電話して', // だれにかけるか決まらない
    '資料をまとめて',
  ])('「%s」は電話にしない', (text) => {
    expect(phoneIntentOf(text)).toBeNull();
  });
});

describe('salesGoalOf', () => {
  it('日程の話が出れば商談が勝つ', () => {
    expect(salesGoalOf('資料を送ったうえで商談の日程を決めて')).toBe('meeting');
  });
});

const context: OathraSalesContext = {
  products: [
    { id: 'p1', name: 'デモ商品' },
    { id: 'p2', name: '受付AI' },
  ],
  contacts: [
    { id: 'c1', name: '田中', company: '田中工務店', callPermitted: true },
    { id: 'c2', name: '佐藤', company: null, callPermitted: false },
    { id: 'c3', name: '山田', company: '山田商事', callPermitted: true },
  ],
};

describe('salesTargetOf', () => {
  it('名前が一人に決まり、商品も一つなら決まる', () => {
    expect(salesTargetOf('田中さんにデモ商品の営業電話して', context)).toEqual({
      ok: true,
      contact: { id: 'c1', name: '田中' },
      product: { id: 'p1', name: 'デモ商品' },
    });
  });

  it('会社名でも決まり、商品は無くてもよい', () => {
    const target = salesTargetOf('山田商事に営業電話して', context);
    expect(target).toMatchObject({ ok: true, contact: { id: 'c3' }, product: null });
  });

  it('相手がいない・二人いる・許可が無い・商品が二つなら決めない', () => {
    expect(salesTargetOf('高橋さんに営業電話して', context)).toMatchObject({
      ok: false,
      reason: 'no_contact',
    });
    expect(salesTargetOf('田中さんと山田さんに営業電話して', context)).toMatchObject({
      ok: false,
      reason: 'ambiguous_contact',
    });
    expect(salesTargetOf('佐藤さんに営業電話して', context)).toMatchObject({
      ok: false,
      reason: 'not_permitted',
    });
    expect(salesTargetOf('田中さんにデモ商品と受付AIの営業電話して', context)).toMatchObject({
      ok: false,
      reason: 'ambiguous_product',
    });
  });
});
