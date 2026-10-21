/**
 * 辞書の言い方の読み取りと、置き換え。普通の頼みを辞書の登録と読まないこと。
 */
import { describe, expect, it } from 'vitest';
import { applyVocabulary, parseVocabularyCommand } from '../src/index.js';

describe('parseVocabularyCommand', () => {
  it('reads the ways to add a word', () => {
    expect(parseVocabularyCommand('辞書に登録: ジーニーは Genie')).toEqual({
      kind: 'add',
      spoken: 'ジーニー',
      written: 'Genie',
    });
    expect(parseVocabularyCommand('ジーニーはGenieと書くように辞書に登録して')).toEqual({
      kind: 'add',
      spoken: 'ジーニー',
      written: 'Genie',
    });
    expect(parseVocabularyCommand('「すーぱーいんたーん」は「SuperIntern」と書いて')).toEqual({
      kind: 'add',
      spoken: 'すーぱーいんたーん',
      written: 'SuperIntern',
    });
    expect(
      parseVocabularyCommand('カレンダーリンクと言ったら https://cal.example.com/me と入れて'),
    ).toEqual({ kind: 'add', spoken: 'カレンダーリンク', written: 'https://cal.example.com/me' });
    expect(parseVocabularyCommand('オープンクローを辞書に登録して')).toEqual({
      kind: 'add',
      spoken: 'オープンクロー',
      written: 'オープンクロー',
    });
  });

  it('reads list and remove', () => {
    expect(parseVocabularyCommand('辞書を見せて')).toEqual({ kind: 'list' });
    expect(parseVocabularyCommand('辞書の一覧')).toEqual({ kind: 'list' });
    expect(parseVocabularyCommand('辞書からジーニーを消して')).toEqual({
      kind: 'remove',
      spoken: 'ジーニー',
    });
  });

  it('does not read ordinary requests as dictionary changes', () => {
    expect(parseVocabularyCommand('この文を英語に変えて')).toBeNull();
    expect(parseVocabularyCommand('返事はOKと書いて')).toBeNull();
    expect(parseVocabularyCommand('辞書で意味を調べて')).toBeNull();
    expect(parseVocabularyCommand('英和辞書を開いて')).toBeNull();
  });
});

describe('applyVocabulary', () => {
  it('replaces longer phrases first and does not replace its own output again', () => {
    const entries = [
      { spoken: 'ジーニー', written: 'Genie' },
      { spoken: 'ジーニーアプリ', written: 'Genie.app' },
      { spoken: 'Genie', written: 'XXX' },
      { spoken: 'ヒント', written: 'ヒント' },
    ];
    expect(applyVocabulary('ジーニーアプリでジーニーを開く。ヒント', entries)).toBe(
      'Genie.appでGenieを開く。ヒント',
    );
    expect(applyVocabulary('変わらない', [])).toBe('変わらない');
    expect(applyVocabulary('a.b と a+b', [{ spoken: 'a.b', written: 'ok' }])).toBe('ok と a+b');
  });
});
