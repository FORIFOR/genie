/**
 * 質問か依頼か。質問には答えだけ、依頼には「承知しました」（2026-10-26 本人の指示）。
 */
import { describe, expect, it } from 'vitest';
import { isQuestion } from '../src/index.js';

describe('question or request', () => {
  it('reads questions', () => {
    for (const q of [
      'どのくらいのクレジットを使いましたか？',
      'また、opencodeの実装は終わっているでしょうか',
      '今日は何曜日',
      '明日の天気は?',
      'これって本当なの',
    ])
      expect(isQuestion(q), q).toBe(true);
  });
  it('reads requests', () => {
    for (const r of [
      '競合を調べて',
      '今日のメールを確認して',
      '明日の予定を整理してください。',
      'ライブ・ミニ',
    ])
      expect(isQuestion(r), r).toBe(false);
  });
});
