import { describe, expect, it } from 'vitest';
import { browserOpenRequest, browserReadRequest } from '../src/browser-request.js';

describe('asking to open an official site', () => {
  it.each([
    ['マクドナルドの公式サイトを開いて', 'マクドナルド'],
    ['ブラウザでスターバックスの公式サイトを開いてください', 'スターバックス'],
    ['ジーニー、ドミノピザのホームページを見せて', 'ドミノピザ'],
    ['JRAの公式ページを確認して', 'JRA'],
    ['ブラウザでユニクロを開いて', 'ユニクロ'],
    ['トヨタの公式HPを表示して。', 'トヨタ'],
    ['オークリーのサングラスを公式サイトで見せて', 'オークリーのサングラス'],
    ['ユニクロのダウンを公式サイトで見せてください', 'ユニクロのダウン'],
  ])('%s → %s', (text, subject) => {
    expect(browserOpenRequest(text)).toEqual({ subject });
  });

  it.each([
    'マクドナルドの公式サイトはどこ？',
    '資料を見て',
    '資料をメールで見せて',
    '天気を教えて',
    'https://example.com を開いて',
    'それの公式サイトを開いて',
  ])('leaves %s to the conversation', (text) => {
    expect(browserOpenRequest(text)).toBeNull();
  });

  it('remembers which browser was named', () => {
    expect(browserOpenRequest('マクドナルドの公式サイトをSafariで開いて')).toEqual({
      subject: 'マクドナルド',
      browser: 'safari',
    });
    expect(browserOpenRequest('Chromeでユニクロの公式サイトを開いて')).toEqual({
      subject: 'ユニクロ',
      browser: 'chrome',
    });
    expect(browserOpenRequest('サファリでJRAの公式ページを開いて')).toEqual({
      subject: 'JRA',
      browser: 'safari',
    });
  });

  it('reads 「公式サイド」 as a mishearing of 「公式サイト」', () => {
    // liveflow 2026-10-06: Gemini Live の字幕が「公式サイド」になり、対象名に残って公式が見つからなかった
    expect(browserOpenRequest('マクドナルドの公式サイドを Safari で開いて。')).toEqual({
      subject: 'マクドナルド',
      browser: 'safari',
    });
  });

  it('reads spoken forms with spaces around the browser name', () => {
    // liveflow 2026-10-05: 字幕は「…公式サイトを Safari で開いて。」のように空白が入る
    expect(browserOpenRequest('マクドナルドの公式サイトを Safari で開いて。')).toEqual({
      subject: 'マクドナルド',
      browser: 'safari',
    });
    expect(browserOpenRequest('ユニクロの公式サイトを Chrome で開いて')).toEqual({
      subject: 'ユニクロ',
      browser: 'chrome',
    });
    expect(browserOpenRequest('Safariでユニクロを開いて')).toEqual({
      subject: 'ユニクロ',
      browser: 'safari',
    });
  });
});

describe('asking Genie to read a page in its own browser', () => {
  it.each([
    ['https://example.com/news/1 を読んで要約して', 'このページを読んで要約して'],
    ['このページ何が書いてある？ https://example.com/a?b=1', 'このページ何が書いてある？'],
    ['https://example.com/a の内容を教えて', 'このページの内容を教えて'],
    ['https://example.com/a、まとめて。', 'このページ、まとめて。'],
  ])('%s', (text, question) => {
    const found = browserReadRequest(text);
    expect(found?.question).toBe(question);
    expect(found?.url).toMatch(/^https:\/\/example\.com\//);
  });

  it.each([
    'https://example.com を開いて',
    'https://example.com',
    'https://a.example と https://b.example を読んで比べて',
    'http://localhost:3000 を読んで',
    'http://192.168.1.1/ の内容を教えて',
    '資料を読んで要約して',
  ])('leaves %s alone', (text) => {
    expect(browserReadRequest(text)).toBeNull();
  });
});
