/**
 * 議事録・貼った文から予定と締切の候補を拾う。時計は止めて（固定の now）確かめる。
 */
import { describe, expect, it } from 'vitest';
import { extractCandidates } from '../src/extract.js';
import { dueLabel } from '../src/todo-parse.js';

// 2026-11-05（木）12:00 JST
const NOW = Date.parse('2026-11-05T12:00:00+09:00');
const ctx = { now: NOW, tz: 'Asia/Tokyo' };
const jst = (ms: number) =>
  new Intl.DateTimeFormat('ja-JP', {
    timeZone: 'Asia/Tokyo',
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(ms);

describe('extractCandidates', () => {
  it('finds the next meeting and the deadlines in minutes, keeping the source line', () => {
    const minutes = [
      '議事録 11/5 24Call 定例',
      '・決定事項: 次回の定例は来週水曜14時から15時に行う',
      '・金曜までに見積書提出（田中）',
      '・11/20までに契約書のドラフトを送付する',
      '・例えば月曜10時に集まる案も出た',
      '・次回の議題は何にする？',
    ].join('\n');
    const found = extractCandidates(minutes, ctx);
    expect(found).toHaveLength(3);
    const meeting = found[0]!;
    const quote = found[1]!;
    const contract = found[2]!;
    expect(meeting).toMatchObject({ kind: 'event', title: expect.stringContaining('次回の定例') });
    expect(jst(meeting.kind === 'event' ? meeting.start : 0)).toBe('11/11 14:00');
    expect(meeting.kind === 'event' && meeting.end ? jst(meeting.end) : null).toBe('11/11 15:00');
    expect(meeting.excerpt).toBe('・決定事項: 次回の定例は来週水曜14時から15時に行う');
    expect(quote).toMatchObject({ kind: 'todo', title: '見積書提出' });
    expect(quote.kind === 'todo' && dueLabel(quote.due)).toBe('11/6(金)');
    expect(contract).toMatchObject({ kind: 'todo', title: '契約書のドラフトを送付' });
  });

  it('reads 11/11(水) 14:00 written as in an email', () => {
    const e = extractCandidates(
      '打ち合わせ候補: 11/11(水) 14:00〜 先方オフィスで打ち合わせ',
      ctx,
    )[0]!;
    expect(e).toMatchObject({ kind: 'event' });
    expect(jst(e.kind === 'event' ? e.start : 0)).toBe('11/11 14:00');
  });

  it('leaves out times with no day, past dates and plain chat', () => {
    expect(extractCandidates('14時に打ち合わせ', ctx)).toEqual([]);
    expect(extractCandidates('昨日の会議はおつかれさまでした', ctx)).toEqual([]);
    expect(extractCandidates('11/1までに出した請求書の件', ctx)).toEqual([]);
    expect(extractCandidates('11/2(月) 10:00から キックオフを行った', ctx)).toEqual([]);
    expect(extractCandidates('ありがとうございます。よろしくお願いします。', ctx)).toEqual([]);
  });
});
