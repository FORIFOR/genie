/**
 * 本人が電話で頼んだことを、どの仕事にするか。Oathra は代役。
 */
import { describe, expect, it, vi } from 'vitest';
import type { OathraClient } from '@genie/service-phone';
import { ownerRequestFor } from '../src/phone.js';

const client = {
  salesContext: vi.fn(async () => ({
    products: [],
    contacts: [{ id: 'c-1', name: '田中', company: null, callPermitted: true }],
  })),
} as unknown as OathraClient;

describe('ownerRequestFor', () => {
  it('決まる営業電話は phone.sales にする', async () => {
    expect(await ownerRequestFor(client, '田中さんに営業電話をかけて')).toMatchObject({
      kind: 'phone.sales',
      input: { contact_id: 'c-1' },
    });
  });

  it('進められない電話の頼みは、黙って捨てずに phone.unresolved として残す', async () => {
    expect(await ownerRequestFor(client, '高橋さんに営業電話をかけて')).toEqual({
      kind: 'phone.unresolved',
      title: '電話の依頼を進められませんでした',
      input: {
        notice: expect.stringContaining('相手が見つかりませんでした'),
        words: '高橋さんに営業電話をかけて',
      },
    });
    expect(await ownerRequestFor(null, '田中さんに営業電話をかけて')).toMatchObject({
      kind: 'phone.unresolved',
      input: { notice: expect.stringContaining('Oathra との接続が必要') },
    });
  });

  it('調べものは research、それ以外は General Assistant', async () => {
    expect(await ownerRequestFor(client, '競合を調べて')).toMatchObject({ kind: 'research' });
    expect(await ownerRequestFor(client, '明日の会議資料を3ページでまとめておいて')).toMatchObject({
      kind: 'plugin:com.astra.general:assistant',
    });
  });
});
