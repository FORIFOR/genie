/**
 * 締切のある「やること」の読み取り。時計は止めて（固定の now）確かめる。
 */
import { describe, expect, it } from 'vitest';
import { dueLabel, parseTodoRequest } from '../src/todo-parse.js';
import { refTitle } from '../src/todo-service.js';

// 2026-11-05（木）12:00 JST
const NOW = Date.parse('2026-11-05T12:00:00+09:00');
const read = (text: string) => parseTodoRequest(text, { now: NOW, tz: 'Asia/Tokyo' });

describe('parseTodoRequest', () => {
  it('reads a deadline the user sets for themselves', () => {
    expect(read('金曜までに見積書を出す')).toEqual({
      kind: 'add',
      title: '見積書を出す',
      due: { year: 2026, month: 11, day: 6 },
    });
    expect(read('見積書を金曜までに出さないと')).toMatchObject({ title: '見積書を出す' });
    expect(read('11/13までに請求書を送らないと')).toMatchObject({
      title: '請求書を送る',
      due: { year: 2026, month: 11, day: 13 },
    });
    expect(read('月末までに家賃を払う')).toMatchObject({ due: { month: 11, day: 30 } });
    expect(read('今週中に経費精算する')).toMatchObject({ due: { day: 6 } });
    expect(read('明日が締切の申請書を出す')).toMatchObject({
      title: '申請書を出す',
      due: { day: 6 },
    });
  });

  it('reads an explicit "add to my to-dos"', () => {
    expect(read('やることに追加: 資料作成 来週水曜まで')).toEqual({
      kind: 'add',
      title: '資料作成',
      due: { year: 2026, month: 11, day: 11 },
    });
  });

  it('leaves requests for Genie, questions and "this" to the usual routing', () => {
    // Genie への頼み（Genie の仕事）は読まない
    expect(read('金曜までに競合を調べてまとめて')).toBeNull();
    expect(read('金曜までに出せる？')).toBeNull();
    expect(read('明日の予定を教えて')).toBeNull();
    expect(read('30分後に通知して')).toBeNull();
  });

  it('reads "do this by Friday" as a to-do whose name comes from what was said before', () => {
    for (const text of [
      'これを金曜までにやって',
      'それ明日までにお願い',
      'この件、今週中に対応して',
      'これを金曜までに出す',
    ])
      expect(read(text), text).toMatchObject({ kind: 'add-ref', due: expect.any(Object) });
    // Genie にやってほしい中身が書いてある頼みは、いつもの振り分けへ
    expect(read('これを金曜までに調べてまとめて')).toBeNull();
  });

  it('reads the list, done and delete', () => {
    expect(read('やることは？')).toEqual({ kind: 'list' });
    expect(read('締切の一覧')).toEqual({ kind: 'list' });
    expect(read('やること 1 終わった')).toEqual({ kind: 'done', ref: 1 });
    expect(read('見積書出した')).toEqual({ kind: 'done', ref: '見積書' });
    expect(read('やること 2 を消して')).toEqual({ kind: 'delete', ref: 2 });
    expect(read('今日ジム行った')).toBeNull();
  });

  it('labels the due date with the weekday', () => {
    expect(dueLabel({ year: 2026, month: 11, day: 13 })).toBe('11/13(金)');
  });
});

describe('refTitle', () => {
  it('names the to-do from the sentence "this" points at', () => {
    expect(refTitle('24Call の提案資料を作成して')).toBe('24Call の提案資料を作成');
    expect(refTitle('見積書の送付をお願いします。')).toBe('見積書の送付');
    expect(refTitle('取引先に契約書の控えを返送')).toBe('取引先に契約書の控えを返送');
    // 問い・相づちは名前にしない（聞き返す）
    expect(refTitle('明日の予定は？')).toBe('');
    expect(refTitle('はい')).toBe('');
    expect(refTitle('x'.repeat(80))).toHaveLength(60);
  });
});
