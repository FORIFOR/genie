import { describe, expect, it } from 'vitest';
import { browserOpenRequest } from '../src/browser-request.js';

describe('asking to open an official site', () => {
  it.each([
    ['マクドナルドの公式サイトを開いて', 'マクドナルド'],
    ['ブラウザでスターバックスの公式サイトを開いてください', 'スターバックス'],
    ['ジーニー、ドミノピザのホームページを見せて', 'ドミノピザ'],
    ['JRAの公式ページを確認して', 'JRA'],
    ['ブラウザでユニクロを開いて', 'ユニクロ'],
    ['トヨタの公式HPを表示して。', 'トヨタ'],
  ])('%s → %s', (text, subject) => {
    expect(browserOpenRequest(text)).toEqual({ subject });
  });

  it.each([
    'マクドナルドの公式サイトはどこ？',
    '資料を見て',
    '天気を教えて',
    'https://example.com を開いて',
    'それの公式サイトを開いて',
  ])('leaves %s to the conversation', (text) => {
    expect(browserOpenRequest(text)).toBeNull();
  });
});
