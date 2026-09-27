/**
 * いまの情報の質問は、規則で拾って端末の取得に回す。モデルに当てさせない。
 */
import { describe, expect, it } from 'vitest';
import { classifyCurrentInfo } from '../src/current-info.js';
import { routeLane } from '../src/lane.js';

describe('classifyCurrentInfo', () => {
  it('finds weather questions and the day they ask about', () => {
    expect(classifyCurrentInfo('明日の天気教えて')).toEqual({ kind: 'weather', when: 'tomorrow', place: null });
    expect(classifyCurrentInfo('今日の天気は？')).toEqual({ kind: 'weather', when: 'today', place: null });
    expect(classifyCurrentInfo('明後日の気温')).toMatchObject({ kind: 'weather', when: 'day_after' });
    expect(classifyCurrentInfo('週末の天気どう？')).toMatchObject({ kind: 'weather', when: 'weekend' });
    expect(classifyCurrentInfo('今週の天気')).toMatchObject({ kind: 'weather', when: 'week' });
    expect(classifyCurrentInfo('土曜日の天気は')).toMatchObject({ kind: 'weather', when: 'weekday:6' });
    expect(classifyCurrentInfo('傘いる？')).toEqual({ kind: 'weather', when: 'today', place: null });
    expect(classifyCurrentInfo('明日雨降るかな')).toEqual({ kind: 'weather', when: 'tomorrow', place: null });
    expect(classifyCurrentInfo('明日は雨？')).toEqual({ kind: 'weather', when: 'tomorrow', place: null });
  });

  it('takes the place named in the question', () => {
    expect(classifyCurrentInfo('大阪の週末の天気は？')).toEqual({ kind: 'weather', when: 'weekend', place: '大阪' });
    expect(classifyCurrentInfo('今日の東京の天気')).toMatchObject({ place: '東京' });
    expect(classifyCurrentInfo('札幌は明日雨降る？')).toMatchObject({ place: '札幌', when: 'tomorrow' });
    expect(classifyCurrentInfo('福岡で明日傘いる？')).toMatchObject({ place: '福岡' });
    expect(classifyCurrentInfo('明日、札幌って雪降る？')).toMatchObject({ kind: 'weather', when: 'tomorrow', place: '札幌' });
  });

  it('finds news questions and their topic', () => {
    expect(classifyCurrentInfo('今日のニュース')).toEqual({ kind: 'news', topic: null });
    expect(classifyCurrentInfo('最新ニュースを教えて')).toEqual({ kind: 'news', topic: null });
    expect(classifyCurrentInfo('AIのニュース教えて')).toEqual({ kind: 'news', topic: 'AI' });
    expect(classifyCurrentInfo('半導体に関するニュースある？')).toEqual({ kind: 'news', topic: '半導体' });
  });

  it('recognises stock questions without guessing an answer', () => {
    expect(classifyCurrentInfo('トヨタの株価は？')).toMatchObject({ kind: 'quote' });
    expect(classifyCurrentInfo('日経平均いくら？')).toMatchObject({ kind: 'quote' });
  });

  it('leaves statements and other work alone', () => {
    for (const text of [
      '天気がいいので散歩した',
      '傘を忘れた',
      '気温と売上の相関を分析して',
      'ニュースを翻訳して',
      '日経平均について教えて',
      '雨宮さんにメールの下書きを作って',
      '天気予報アプリの企画書を作って',
      'ニュース記事を書いて',
      '雪見だいふく買ってきて',
      '会議の要点をまとめて',
      'こんにちは',
    ]) {
      expect(classifyCurrentInfo(text), text).toBeNull();
    }
  });

  it('never sees requests to operate a named app, which the lane router sends to action first', () => {
    for (const text of ['Safariで天気を検索して', 'Safariでニュースを開いて']) {
      expect(routeLane({ text, modality: 'text' }).lane, text).toBe('action');
    }
  });

  it('answers a search-engine request directly and does not take the engine for a place', () => {
    // アプリの名指しが無い「検索して」は操作にしない（lane.ts）。調べたいのは天気そのもの。
    expect(routeLane({ text: 'Googleで天気を検索して', modality: 'text' }).lane).toBe('chat');
    expect(classifyCurrentInfo('Googleで天気を検索して')).toEqual({ kind: 'weather', when: 'today', place: null });
    expect(classifyCurrentInfo('ネットで明日の天気を調べて')).toEqual({ kind: 'weather', when: 'tomorrow', place: null });
  });
});
