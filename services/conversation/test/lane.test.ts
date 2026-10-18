/**
 * Lane Router。正本 §7.4、Phase 7 §2.1。
 * **利用者に Lane を見せない**が、なぜそうなったかは説明できる。
 */
import { describe, expect, it } from 'vitest';
import { routeLane } from '../src/lane.js';

const lane = (text: string, over: Record<string, unknown> = {}) =>
  routeLane({ text, modality: 'text', ...over } as never);

describe('routeLane', () => {
  it('sends a question that needs looking up to research', () => {
    for (const text of ['競合を調べて', '半導体市場を調査して', 'A社とB社を比較して']) {
      expect(lane(text).lane, text).toBe('research');
    }
  });

  it('sends an outward request to action', () => {
    for (const text of ['見積を送信して', '会議室を予約して', 'CRM を更新して']) {
      expect(lane(text).lane, text).toBe('action');
    }
  });

  it('sends a request to place a phone call to action, but not talk about phones', () => {
    for (const text of [
      '田中さんにデモ商品の営業電話をかけて',
      '090-1234-5678に電話して10時集合と伝えて',
      '山田商事にテレアポして',
      '鈴木さんとのアポを取って',
    ]) {
      expect(lane(text).lane, text).toBe('action');
    }
    for (const text of [
      '田中さんの電話番号を教えて',
      '昨日の電話の内容をまとめて',
      '営業電話はかけてはいけない',
    ]) {
      expect(lane(text).lane, text).not.toBe('action');
    }
  });

  it('only edits when there is something selected', () => {
    // 選択が無い「直して」は、何を直すか決まらない
    expect(lane('この文を短くして').lane).toBe('chat');
    expect(lane('この文を短くして', { hasSelection: true }).lane).toBe('edit');
  });

  it('treats anything said during a meeting as part of the meeting', () => {
    // ここで chat に落とすと、会議の途中で別の話が始まる
    expect(lane('売上はどうだった', { meetingActive: true }).lane).toBe('meeting');
  });

  it('picks meeting over action when asked to record one', () => {
    // 「記録して」は action にも見える。会議として先に拾う。
    expect(lane('会議を記録して').lane).toBe('meeting');
  });

  it('defers to a named agent above everything else', () => {
    expect(lane('調べて', { namedAgent: 'crm-analyst' }).lane).toBe('specialist-agent');
  });

  it('falls back to chat rather than guessing', () => {
    // 推測で振り分けない
    for (const text of ['こんにちは', 'ありがとう', 'うーん']) {
      expect(lane(text).lane, text).toBe('chat');
    }
  });

  it('creates written deliverables without mistaking them for external actions', () => {
    for (const text of [
      '動画の構成案の文章だけを作成してください。',
      'Webサイトの改善提案をまとめてください。会社の説明は以下です。',
      'アイデアを小さく検証する計画にしてください。',
      '短い動画の構成を3案つくってください。',
      'チーム内レビュー用の案内文を日本語で作成してください。件名と本文を分けてください。',
      '新商品の紹介文を作成してください。',
      'メールを作成してください。',
      'メールの下書きを作成してください。送信しないでください。',
      '新規登録についての案内文を書いてください。',
      '予約についてのメールを作成して。送ってはいけません。',
      '顧客に送るメールの文面を書いてください。',
      'SNS投稿文を書いてください。',
      '新しいものを作成してください。',
    ])
      expect(lane(text).lane, text).toBe('chat');
  });

  it('keeps research and external actions distinct from drafting', () => {
    expect(lane('競合を調べて企画書を作成してください').lane).toBe('research');
    expect(lane('メールの下書きを作成して顧客に送って').lane).toBe('action');
    expect(lane('カレンダーに予定を作成して').lane).toBe('action');
    expect(lane('新しいアカウントを作成してください').lane).toBe('action');
  });

  it('can always say why', () => {
    for (const text of ['調べて', '送信して', 'こんにちは']) {
      expect(lane(text).reason.length, text).toBeGreaterThan(0);
    }
  });
});
