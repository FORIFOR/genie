import { describe, expect, it } from 'vitest';
import { isMailCheck } from '../src/mail-intent.js';

describe('isMailCheck', () => {
  it('takes plain requests to check mail', () => {
    for (const text of [
      'メール確認して',
      'メールを確認して',
      'メールチェックして',
      'Gmail見て',
      '新着メールある？',
      '未読メールはありますか',
      '未読は？',
      'メール来てる？',
      '今日のメール教えて',
    ])
      expect(isMailCheck(text), text).toBe(true);
  });

  it('leaves named targets, actions and other topics to the usual path', () => {
    for (const text of [
      'メールを送って',
      'メールに返信して',
      '田中さんのメールを確認して',
      'メールアプリを開いて',
      'メールの設定を確認して',
      'Gmail つながってる？',
      'Gmail 切れてる？',
      'こんにちは',
      '今日の予定を確認して',
    ])
      expect(isMailCheck(text), text).toBe(false);
  });
});
