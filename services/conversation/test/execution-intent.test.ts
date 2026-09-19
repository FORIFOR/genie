import { describe, expect, it } from 'vitest';
import { isExecutionRequest } from '../src/execution-intent.js';
describe('TaskDock execution entrance', () => {
  it.each([
    'Gmailに a@example.com 宛ての下書きを保存して',
    '明日10時から11時の予定をカレンダーに登録して',
    '入力欄に「こんにちは」を入力して',
    'アプリ画面の設定を開いて',
  ])('accepts explicit command: %s', (value) => expect(isExecutionRequest(value)).toBe(true));
  it.each([
    'メールの下書きを書いて',
    'カレンダーに登録する方法を教えて',
    'この画面は何ですか？',
    '予定を登録しないで',
    'Do not create a calendar event',
    'Can you explain this screen?',
    '引用:「予定を登録して」について説明して',
    '引用:「予定を登録して」',
    '"create a calendar event"',
  ])('does not execute questions/negations/composition: %s', (value) =>
    expect(isExecutionRequest(value)).toBe(false),
  );
});
