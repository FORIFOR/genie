/**
 * 予定の頼みを決まった形にする（仕様 v1.0 §11）。時刻は本人の時間帯（東京）で読む。
 */
import { describe, expect, it } from 'vitest';
import {
  applyChange,
  parseCalendarIntent,
  pickTarget,
  rangeLabel,
  zonedIso,
  type ListedEvent,
} from '../src/calendar-intent.js';

const TZ = 'Asia/Tokyo';
// 2026-10-27（火）09:30 JST
const NOW = new Date('2026-10-27T00:30:00Z');
const read = (text: string) => parseCalendarIntent(text, NOW, TZ);

const events: ListedEvent[] = [
  {
    id: 'e1',
    title: '定例ミーティング',
    start: '2026-10-28T10:00:00+09:00',
    end: '2026-10-28T11:00:00+09:00',
    allDay: false,
  },
  {
    id: 'e2',
    title: '打ち合わせ',
    start: '2026-10-28T14:30:00+09:00',
    end: '2026-10-28T15:30:00+09:00',
    allDay: false,
  },
  { id: 'e3', title: '誕生日', start: '2026-10-28', end: '2026-10-29', allDay: true },
];

describe('reading calendar requests', () => {
  it('reads the agenda for a day in the user’s time zone', () => {
    expect(read('明日の予定教えて')).toEqual({
      kind: 'agenda',
      label: '明日',
      timeMin: '2026-10-28T00:00:00+09:00',
      timeMax: '2026-10-29T00:00:00+09:00',
    });
    expect(read('あしたよてい')).toMatchObject({ kind: 'agenda', label: '明日' });
    expect(read('今日の予定ある？')).toMatchObject({
      label: '今日',
      timeMin: '2026-10-27T00:00:00+09:00',
    });
    expect(read('11/3の予定は')).toMatchObject({
      label: '11/3',
      timeMin: '2026-11-03T00:00:00+09:00',
    });
    // 「なんかあったっけ」「入ってる？」「どうなってる？」もその日の予定（評価 2026-10-27 のケースから）
    expect(read('今日なんかあったっけ')).toMatchObject({ kind: 'agenda', label: '今日' });
    expect(read('あさっての午後どうなってる？')).toMatchObject({ kind: 'agenda', label: '明後日' });
    // 今日は火曜 → 土曜 10/31 から 2 日
    expect(read('今週末なんか入ってる？')).toMatchObject({
      label: '今週末',
      timeMin: '2026-10-31T00:00:00+09:00',
      timeMax: '2026-11-02T00:00:00+09:00',
    });
    expect(read('再来週の月曜あいてる？')).toMatchObject({
      label: '再来週',
      timeMin: '2026-11-09T00:00:00+09:00',
    });
    // 来週 = 次の月曜から 7 日
    expect(read('来週の予定')).toMatchObject({
      timeMin: '2026-11-02T00:00:00+09:00',
      timeMax: '2026-11-09T00:00:00+09:00',
    });
  });

  it('reads changes to an event, and undo', () => {
    expect(read('午後にずらして')).toMatchObject({
      kind: 'move',
      change: { kind: 'at', hour: 14, minute: 0 },
      target: { pronoun: false },
    });
    expect(read('それ30分遅らせて')).toMatchObject({
      kind: 'move',
      change: { kind: 'shift', minutes: 30 },
      target: { pronoun: true },
    });
    expect(read('打ち合わせを1時間早めて')).toMatchObject({
      change: { kind: 'shift', minutes: -60 },
      target: { words: ['打ち合わせ'] },
    });
    expect(read('10時のやつ15時半に変更して')).toMatchObject({
      change: { kind: 'at', hour: 15, minute: 30 },
      target: { hour: 10 },
    });
    expect(read('15時の会議、30分うしろにずらしといて')).toMatchObject({
      change: { kind: 'shift', minutes: 30 },
      target: { hour: 15 },
    });
    expect(read('やっぱり元に戻して')).toEqual({ kind: 'undo' });
    expect(read('さっきのやっぱなし')).toEqual({ kind: 'undo' });
  });

  it('leaves other requests to the usual routing', () => {
    for (const t of [
      '来週火曜10時に歯医者入れといて',
      '明日の天気は？',
      'おはよう',
      '予定を消して',
      'ずらしたい',
    ])
      expect(read(t), t).toBeNull();
  });
});

describe('picking the event and the new time', () => {
  it('picks one event by title, hour or the only timed one; otherwise returns candidates', () => {
    expect(pickTarget({ words: ['打ち合わせ'], hour: null, pronoun: false }, events, TZ)).toEqual({
      event: events[1],
    });
    expect(pickTarget({ words: [], hour: 10, pronoun: false }, events, TZ)).toEqual({
      event: events[0],
    });
    expect(pickTarget({ words: [], hour: null, pronoun: true }, events, TZ)).toEqual({
      candidates: [events[0], events[1]],
    });
    expect(
      pickTarget({ words: [], hour: null, pronoun: true }, [events[0]!, events[2]!], TZ),
    ).toEqual({ event: events[0] });
  });

  it('keeps the length when moving, and labels times in the user’s time zone', () => {
    expect(
      applyChange(events[0]!, { kind: 'at', hour: 14, minute: 0, label: '14:00' }, TZ),
    ).toEqual({
      start: '2026-10-28T14:00:00+09:00',
      end: '2026-10-28T15:00:00+09:00',
    });
    expect(applyChange(events[1]!, { kind: 'shift', minutes: 30 }, TZ)).toEqual({
      start: '2026-10-28T15:00:00+09:00',
      end: '2026-10-28T16:00:00+09:00',
    });
    expect(rangeLabel('2026-10-28T10:00:00+09:00', '2026-10-28T11:00:00+09:00', TZ)).toBe(
      '10/28（水） 10:00〜11:00',
    );
    expect(zonedIso(2026, 3, 8, 12, 0, 'America/New_York')).toBe('2026-03-08T12:00:00-04:00');
  });
});
