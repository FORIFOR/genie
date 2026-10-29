/**
 * 「いつ・何を」の読み取りと、次の実行時刻。時計は止めて（固定の now）確かめる。
 */
import { describe, expect, it } from 'vitest';
import { parseScheduleRequest, normalizeNumbers } from '../src/parse.js';
import {
  describeSchedule,
  formatWhen,
  nextRunAfter,
  upcomingRuns,
  zonedTime,
  type Schedule,
} from '../src/time.js';

const TZ = 'Asia/Tokyo';
// 2026-10-21（水）10:15 JST
const NOW = Date.parse('2026-10-21T01:15:00Z');
const jst = (iso: string) => Date.parse(`${iso}+09:00`);
const parse = (text: string, now = NOW) => parseScheduleRequest(text, { now, tz: TZ });
const ok = (text: string, now = NOW) => {
  const result = parse(text, now);
  if (!result || !result.ok) throw new Error(`not parsed: ${text} → ${JSON.stringify(result)}`);
  return result.request;
};

describe('parseScheduleRequest', () => {
  it('reads "in N minutes" as one reminder', () => {
    const r = ok('30分後に会議だって教えて');
    expect(r.schedule).toEqual({ kind: 'at', at: '2026-10-21T01:45:00.000Z' });
    expect(r.payload).toEqual({ kind: 'reminder', text: '会議' });
    expect(ok('1時間30分後に洗濯物を取り込むことを知らせて').schedule).toEqual({
      kind: 'at',
      at: '2026-10-21T02:45:00.000Z',
    });
  });

  it('reads tomorrow / day words / weekdays / dates', () => {
    expect(ok('明日9時に資料の準備をリマインドして')).toMatchObject({
      schedule: { kind: 'at', at: new Date(jst('2026-10-22T09:00')).toISOString() },
      payload: { kind: 'reminder', text: '資料の準備' },
    });
    // 「明日 3 時」は午後
    expect(ok('明日3時に田中さんに電話するよう知らせて').schedule).toEqual({
      kind: 'at',
      at: new Date(jst('2026-10-22T15:00')).toISOString(),
    });
    expect(ok('明日の朝7時半に起こして').schedule).toEqual({
      kind: 'at',
      at: new Date(jst('2026-10-22T07:30')).toISOString(),
    });
    expect(ok('今夜8時にゴミ出しを教えて').schedule).toEqual({
      kind: 'at',
      at: new Date(jst('2026-10-21T20:00')).toISOString(),
    });
    // 水曜に「金曜の 10 時」は今週の金曜、「来週の月曜」は来週
    expect(ok('金曜の10時に経費精算をリマインドして').schedule).toEqual({
      kind: 'at',
      at: new Date(jst('2026-10-23T10:00')).toISOString(),
    });
    expect(ok('来週の月曜10時に週報を書くよう知らせて').schedule).toEqual({
      kind: 'at',
      at: new Date(jst('2026-10-26T10:00')).toISOString(),
    });
    expect(ok('11月3日の午後2時に請求書を送ることを教えて').schedule).toEqual({
      kind: 'at',
      at: new Date(jst('2026-11-03T14:00')).toISOString(),
    });
    // 過ぎた日付は来年
    expect(ok('1月5日の9時に年賀状のお礼を教えて').schedule).toEqual({
      kind: 'at',
      at: new Date(jst('2027-01-05T09:00')).toISOString(),
    });
  });

  it('picks the next matching time when no day is given', () => {
    // 10:15 に「11 時に」→ 今日 11:00、「9 時に」→ 今日 21:00
    expect(ok('11時に休憩するよう教えて').schedule).toEqual({
      kind: 'at',
      at: new Date(jst('2026-10-21T11:00')).toISOString(),
    });
    expect(ok('9時に戸締まりを教えて').schedule).toEqual({
      kind: 'at',
      at: new Date(jst('2026-10-21T21:00')).toISOString(),
    });
    // 午前と言われていて過ぎていれば明日
    expect(ok('午前9時に戸締まりを教えて').schedule).toEqual({
      kind: 'at',
      at: new Date(jst('2026-10-22T09:00')).toISOString(),
    });
  });

  it('reads recurring schedules and turns non-reminders into tasks', () => {
    expect(ok('毎朝8時に今日の予定をまとめて')).toMatchObject({
      schedule: { kind: 'weekly', days: [0, 1, 2, 3, 4, 5, 6], hour: 8, minute: 0, tz: TZ },
      payload: { kind: 'task', text: '今日の予定をまとめて' },
    });
    expect(ok('平日の18時に日報を書くよう知らせて')).toMatchObject({
      schedule: { kind: 'weekly', days: [1, 2, 3, 4, 5], hour: 18 },
      payload: { kind: 'reminder', text: '日報を書くよう' },
    });
    expect(ok('毎週月曜と木曜の10時に競合のニュースを調べて').schedule).toMatchObject({
      kind: 'weekly',
      days: [1, 4],
      hour: 10,
    });
    expect(ok('毎晩9時に明日の天気を教えて').schedule).toMatchObject({ hour: 21 });
    expect(ok('毎月25日の10時に請求書を作って').schedule).toEqual({
      kind: 'monthly',
      day: 25,
      hour: 10,
      minute: 0,
      tz: TZ,
    });
    expect(ok('15分おきにメールを確認して')).toMatchObject({
      // 区切りのよい時刻（いまの 10:15）から数える。最初は 10:30
      schedule: { kind: 'every', everyMs: 15 * 60_000, anchorMs: jst('2026-10-21T10:15') },
      payload: { kind: 'task', text: 'メールを確認して' },
    });
  });

  it('accepts full-width and kanji numbers', () => {
    expect(normalizeNumbers('十二時半')).toBe('12時半');
    expect(normalizeNumbers('二十五日')).toBe('25日');
    expect(ok('明日の９時に資料を送るよう教えて').schedule).toEqual({
      kind: 'at',
      at: new Date(jst('2026-10-22T09:00')).toISOString(),
    });
    expect(ok('三十分後に休憩を教えて').schedule).toEqual({
      kind: 'at',
      at: '2026-10-21T01:45:00.000Z',
    });
  });

  it('does not take ordinary requests as schedules', () => {
    expect(parse('9時の会議の資料を作って')).toBeNull();
    expect(parse('明日の天気を教えて')).toBeNull();
    expect(parse('毎日のニュースを調べて')).toBeNull();
    expect(parse('3時に会議がある')).toBeNull();
    expect(parse('競合を調べて')).toBeNull();
  });

  it('refuses times that cannot be made', () => {
    expect(parse('今日の9時に資料を送るよう教えて')).toEqual({ ok: false, reason: 'past' });
    expect(parse('明日の25時に資料を送るよう教えて')).toEqual({
      ok: false,
      reason: 'invalid_time',
    });
    expect(parse('1分おきにメールを確認して')).toEqual({ ok: false, reason: 'too_frequent' });
  });
});

describe('nextRunAfter', () => {
  it('walks weekly schedules in the given time zone', () => {
    const weekdays: Schedule = {
      kind: 'weekly',
      days: [1, 2, 3, 4, 5],
      hour: 9,
      minute: 0,
      tz: TZ,
    };
    // 金曜 9:00 の次は月曜 9:00
    expect(nextRunAfter(weekdays, jst('2026-10-23T09:00'))).toBe(jst('2026-10-26T09:00'));
    expect(upcomingRuns(weekdays, NOW, 3)).toEqual([
      jst('2026-10-22T09:00'),
      jst('2026-10-23T09:00'),
      jst('2026-10-26T09:00'),
    ]);
  });

  it('keeps wall-clock time across daylight saving changes', () => {
    const ny: Schedule = {
      kind: 'weekly',
      days: [0, 1, 2, 3, 4, 5, 6],
      hour: 9,
      minute: 0,
      tz: 'America/New_York',
    };
    // 2026-11-01 に夏時間が終わる。前後とも 9:00（UTC では 13:00 → 14:00）
    expect(nextRunAfter(ny, Date.parse('2026-10-31T14:00:00Z'))).toBe(
      Date.parse('2026-11-01T14:00:00Z'),
    );
    expect(nextRunAfter(ny, Date.parse('2026-10-30T14:00:00Z'))).toBe(
      Date.parse('2026-10-31T13:00:00Z'),
    );
    // 夏時間の始まりで無い 2:30 は、後ろ（3:30 EDT = 7:30Z）へ
    expect(zonedTime(2026, 3, 8, 2, 30, 'America/New_York')).toBe(
      Date.parse('2026-03-08T07:30:00Z'),
    );
    // 二度ある 1:30 は前（EDT = 5:30Z）
    expect(zonedTime(2026, 11, 1, 1, 30, 'America/New_York')).toBe(
      Date.parse('2026-11-01T05:30:00Z'),
    );
  });

  it('clamps monthly days to the end of short months', () => {
    const monthEnd: Schedule = { kind: 'monthly', day: 31, hour: 10, minute: 0, tz: TZ };
    expect(nextRunAfter(monthEnd, jst('2026-10-31T10:00'))).toBe(jst('2026-11-30T10:00'));
  });

  it('counts intervals from the anchor and ends one-shot schedules', () => {
    const every: Schedule = {
      kind: 'every',
      everyMs: 15 * 60_000,
      anchorMs: jst('2026-10-21T10:30'),
    };
    expect(nextRunAfter(every, jst('2026-10-21T10:30'))).toBe(jst('2026-10-21T10:45'));
    expect(nextRunAfter(every, jst('2026-10-21T13:01'))).toBe(jst('2026-10-21T13:15'));
    const once: Schedule = { kind: 'at', at: new Date(jst('2026-10-21T11:00')).toISOString() };
    expect(nextRunAfter(once, NOW)).toBe(jst('2026-10-21T11:00'));
    expect(nextRunAfter(once, jst('2026-10-21T11:00'))).toBeNull();
  });

  it('says the schedule back in plain words', () => {
    expect(
      describeSchedule({ kind: 'weekly', days: [1, 2, 3, 4, 5], hour: 9, minute: 0, tz: TZ }, TZ),
    ).toBe('平日の 9:00');
    expect(
      describeSchedule({ kind: 'weekly', days: [1, 4], hour: 10, minute: 5, tz: TZ }, TZ),
    ).toBe('毎週月・木曜 10:05');
    expect(describeSchedule({ kind: 'every', everyMs: 7_200_000, anchorMs: 0 }, TZ)).toBe(
      '2 時間ごと',
    );
    expect(formatWhen(jst('2026-10-22T09:00'), TZ)).toBe('10/22（木）9:00');
  });
});

describe('scheduleName', () => {
  it('reads naturally for one-shot, recurring and every-N schedules', async () => {
    const { scheduleName } = await import('../src/service.js');
    const tz = 'Asia/Tokyo';
    expect(
      scheduleName(
        { kind: 'at', at: '2026-10-21T02:51:00.000Z' },
        { kind: 'reminder', text: '動作確認' },
        tz,
      ),
    ).toBe('10/21（水）11:51 に「動作確認」をお知らせ');
    expect(
      scheduleName(
        { kind: 'every', everyMs: 15 * 60_000, anchorMs: 0 },
        { kind: 'task', text: 'メールを確認して' },
        tz,
      ),
    ).toBe('15 分ごとに「メールを確認して」を頼む');
  });
});

describe('call reminders', () => {
  it('marks 「電話で起こして」「電話で教えて」 as a reminder by call', () => {
    const at = Date.parse('2026-10-23T03:00:00Z');
    const payload = (text: string) => ok(text, at).payload;
    expect(payload('明日7時に電話で起こして')).toEqual({
      kind: 'reminder',
      text: '時間です',
      call: true,
    });
    expect(payload('30分後に会議だって電話で教えて')).toEqual({
      kind: 'reminder',
      text: '会議',
      call: true,
    });
    expect(payload('30分後に会議だって教えて')).toEqual({ kind: 'reminder', text: '会議' });
  });

  // 評価 2026-10-27: 予定を入れる頼みを、知らせの予約にしていた
  it('leaves calendar entries to the calendar, but still takes reminders that say 教えて', () => {
    const ctx = { now: Date.parse('2026-10-27T00:30:00Z'), tz: 'Asia/Tokyo' };
    expect(parseScheduleRequest('来週火曜10時に歯医者入れといて', ctx)).toBeNull();
    expect(parseScheduleRequest('明日の15時に会議を予定に追加して', ctx)).toBeNull();
    expect(parseScheduleRequest('明日の10時に歯医者って教えて', ctx)).not.toBeNull();
  });
});
