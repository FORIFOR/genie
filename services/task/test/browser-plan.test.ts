import { describe, expect, it } from 'vitest';
import { isKnownTaskKind, isMeteredStep, planTask, requiresSingleAttempt } from '../src/plan.js';
import { formatBrowserArtifact } from '../src/browser-artifact.js';

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
      },
    ])!;
    expect(opened.markdown.split('\n')[0]).toBe(
      'かしこまりました。マクドナルドの公式サイトをブラウザで開きました。',
    );
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
