/**
 * 文を返すだけの答え（llm.answer）が、実行していない操作を完了と言わない（仕様 v1.0 §5）。
 * 例は evals/line-conversation 2026-10-27 の実際の答えから。
 */
import { describe, expect, it } from 'vitest';
import { actionClaim, guardActionClaims } from '../src/action-claims.js';

describe('action claims in a plain answer', () => {
  it('finds claims of doing something it did not do', () => {
    for (const answer of [
      '承知しました。買い物リストに次の2点を入れました。\n- 牛乳\n- 卵',
      '承知しました。家計簿に「スーパー 2500円」で入れました。2000円は入れていません。',
      '承知しました。今からグループへの送信は、確認なしで行います。',
      '承知しました。次の内容で控えました。\n- 予定: 娘の運動会',
      '承知しました。固定費に次の内容で入れておきます。',
    ])
      expect(actionClaim(answer), answer).not.toBeNull();
  });

  it('leaves answers, questions, explanations and drafts alone', () => {
    for (const answer of [
      'おはようございます。',
      '家計簿に付けますか？（はい / いいえ）',
      'このボタンを押すと、内容を送信します。',
      '2018年に熊谷で41.1℃を記録しました。',
      '送信前の確認は、これまでどおり行います。',
      '妻への文の例です。\n「今日は19時に帰ります。夕飯は食べてきました」',
      '> 先ほど送りました。よろしくお願いします。\nこの文で送ってよいか確かめてください。',
    ])
      expect(actionClaim(answer), answer).toBeNull();
  });

  it('reads a Work Context summary as the user’s own past, unless the answer takes on a request', () => {
    expect(
      actionClaim('田中さんに見積をメールで送りました（10/20）。返事待ちです。', true),
    ).toBeNull();
    expect(actionClaim('承知しました。田中さんにメールを送りました。', true)).not.toBeNull();
  });

  it('replaces the answer with an honest one and keeps the result shape', () => {
    const guarded = guardActionClaims(
      { answer: '承知しました。買い物リストに牛乳を入れました。' },
      '牛乳、買い物リストに',
    );
    expect(guarded.claim).toContain('入れました');
    expect(guarded.result).toEqual({
      answer:
        '「牛乳、買い物リストに」は、まだ実行していません。\nこの返事では、記録・送信・予定の変更などはしていません。',
    });
    expect(guardActionClaims('おはようございます。', 'おはよう')).toEqual({
      result: 'おはようございます。',
      claim: null,
    });
  });
});
