import { describe, expect, it } from 'vitest';
import { isKnownTaskKind, isMeteredStep, planTask, requiresSingleAttempt } from '../src/plan.js';
import { formatBrowserArtifact } from '../src/browser-artifact.js';
import { formatBrowserReadArtifact } from '../src/browser-read-artifact.js';

describe('opening an official site', () => {
  it('runs one local read step that is never retried automatically', () => {
    expect(isKnownTaskKind('browser.open_official')).toBe(true);
    const step = planTask('browser.open_official', { subject: ' マクドナルド ' }).steps[0]!;
    expect(step).toMatchObject({
      toolId: 'browser.open_official',
      surface: 'local',
      risk: 'READ',
      args: { subject: 'マクドナルド' },
    });
    expect(isMeteredStep(step)).toBe(true);
    expect(requiresSingleAttempt(step)).toBe(false);
    expect(() => planTask('browser.open_official', {})).toThrow();
  });

  it('says it opened the page only when the device says so', () => {
    const opened = formatBrowserArtifact('browser.open_official', [
      {
        subject: 'マクドナルド',
        url: 'https://www.mcdonalds.co.jp/',
        title: '日本マクドナルド',
        opened: true,
        reason: '運営会社のドメイン',
        shown: true,
      },
    ])!;
    expect(opened.markdown.split('\n')[0]).toBe(
      '承知しました。マクドナルドの公式サイトをブラウザで開き、表示されたのを確認しました。',
    );
    const unconfirmed = formatBrowserArtifact('browser.open_official', [
      {
        subject: 'マクドナルド',
        url: 'https://www.mcdonalds.co.jp/',
        title: '',
        opened: true,
        reason: '',
        shown: null,
      },
    ])!;
    expect(unconfirmed.markdown).toContain('表示まではまだ確認できていません');
    expect(opened.markdown).toContain('https://www.mcdonalds.co.jp/');
    const failed = formatBrowserArtifact('browser.open_official', [
      {
        subject: 'マクドナルド',
        url: 'https://www.mcdonalds.co.jp/',
        title: '',
        opened: false,
        reason: '',
        problem: '公式サイトと確かめられるページがありませんでした。',
      },
    ])!;
    expect(failed.markdown).toBe(
      '申し訳ありません。公式サイトと確かめられるページがありませんでした。',
    );
    // 読み上げる本文に見出しや URL の文字列を入れない。
    const spoken = formatBrowserArtifact('browser.open_official', [
      { subject: 'A', url: 'https://a.example/', title: 'A社', opened: true, reason: 'x' },
    ])!.markdown;
    expect(spoken).not.toMatch(/^#/m);
    expect(formatBrowserArtifact('office.edit', [])).toBeNull();
  });
});

describe('reading a page in the Genie browser', () => {
  it('plans one local read step for a public address only', () => {
    expect(isKnownTaskKind('browser.read')).toBe(true);
    const step = planTask('browser.read', {
      url: 'https://example.com/a',
      question: ' このページを要約して ',
    }).steps[0]!;
    expect(step).toMatchObject({
      toolId: 'browser.read_page',
      surface: 'local',
      risk: 'READ',
      args: { url: 'https://example.com/a', question: 'このページを要約して' },
    });
    expect(isMeteredStep(step)).toBe(true);
    for (const url of ['http://localhost/', 'http://10.1.2.3/', 'file:///etc/hosts', 42])
      expect(() => planTask('browser.read', { url, question: '要約して' })).toThrow();
    expect(() => planTask('browser.read', { url: 'https://example.com/' })).toThrow();
  });

  it('answers only from what the device read, and says which page', () => {
    const read = formatBrowserReadArtifact('browser.read', [
      {
        url: 'https://example.com/a',
        finalUrl: 'https://example.com/b',
        title: '料金の[お知らせ]',
        read: true,
        chars: 120,
        answer: '来年から月 980 円です。',
      },
    ])!;
    expect(read.markdown).toBe(
      [
        '来年から月 980 円です。',
        '',
        '[料金のお知らせ](https://example.com/b)',
        '',
        'Genie 専用のブラウザ（ログインしていない状態）で見えた本文から答えています。',
      ].join('\n'),
    );
    const notRead = formatBrowserReadArtifact('browser.read', [
      {
        url: 'http://localhost/',
        finalUrl: null,
        title: '',
        read: false,
        chars: 0,
        answer: null,
        problem: 'Mac の中や家の中のアドレスは開きません。',
      },
    ])!;
    expect(notRead.markdown).toBe('申し訳ありません。Mac の中や家の中のアドレスは開きません。');
    expect(formatBrowserReadArtifact('browser.open_official', [])).toBeNull();
  });
});
