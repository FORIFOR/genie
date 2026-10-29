/**
 * 一度に頼まれた複数のことを分ける（仕様 v1.0 §1）。分けすぎない。
 */
import { describe, expect, it } from 'vitest';
import { splitRequests } from '../src/split.js';

describe('splitting several requests', () => {
  it('splits at connectors between requests', () => {
    expect(splitRequests('明日の予定教えて。あと、昨日のレシートも家計簿に入れて')).toEqual([
      '明日の予定教えて',
      '昨日のレシートも家計簿に入れて',
    ]);
    expect(splitRequests('牛乳を買い物リストに入れて、それとTODOに区役所で住民票')).toEqual([
      '牛乳を買い物リストに入れて',
      'TODOに区役所で住民票',
    ]);
    expect(splitRequests('今月の支出確認して、ついでに来月の予算も考えて')).toEqual([
      '今月の支出確認して',
      '来月の予算も考えて',
    ]);
  });

  it('splits listed topics and carries the day to each', () => {
    expect(splitRequests('予定と天気とニュース')).toEqual(['予定を教えて', '天気を教えて', 'ニュースを教えて']);
    expect(splitRequests('明日の予定と天気教えて')).toEqual(['明日の予定を教えて', '明日の天気を教えて']);
  });

  it('keeps single requests whole', () => {
    for (const t of [
      '明日の予定教えて',
      'あと30分で着く',
      '会議まであと何日？',
      '打ち合わせのあとで電話して',
      'それから先のことはまた考える',
      '牛乳と卵を買い物リストに',
      'あと',
      // 評価 2026-10-27 で分けすぎたもの
      'トイレットペーパーとティッシュ、あと洗剤',
      '送って、あと最後に「よろしく」つけて',
      'はい。あとそれ妻にも送っといて',
    ])
      expect(splitRequests(t), t).toBeNull();
  });
});
