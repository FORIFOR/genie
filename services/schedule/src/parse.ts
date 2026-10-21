/**
 * 「いつ・何を」を話し言葉から読む。**純粋関数。規則だけで決める**（モデルに当てさせない）。
 *
 *   「30 分後に会議だって教えて」        → 1 回、お知らせ「会議だ」
 *   「明日 9 時に資料の準備をリマインドして」 → 1 回、お知らせ「資料の準備」
 *   「毎朝 8 時に今日の予定をまとめて」      → 毎日、仕事「今日の予定をまとめて」
 *   「平日の 18 時に日報を書くよう知らせて」  → 平日、お知らせ「日報を書く」
 *   「毎週月曜 10 時に競合のニュースを調べて」 → 毎週月曜、仕事
 *   「15 分おきにメールを確認して」          → 間隔、仕事
 *
 * 予約と読むのは**時刻のあとに「に」が続き、頼みの形で終わる**ときだけ。
 * 「9 時の会議の資料を作って」「明日の天気を教えて」は予約ではない（いまの仕事）。
 * 読み違えても、作る前に必ず言い直して確かめる（confirm）。
 */
import { MIN_EVERY_MS, isValidTimeZone, wallClock, zonedTime, type Schedule } from './time.js';

export type SchedulePayload =
  /** 時間になったら知らせるだけ（仕事にしない）。 */
  | { readonly kind: 'reminder'; readonly text: string }
  /** 時間になったら、この文で頼む（Task Dock で頼んだのと同じ入口）。 */
  | { readonly kind: 'task'; readonly text: string };

export interface ScheduleRequest {
  readonly schedule: Schedule;
  readonly payload: SchedulePayload;
  /** 時刻の言い方を取り除いた、頼みの部分。 */
  readonly action: string;
}

export type ParseResult =
  | { readonly ok: true; readonly request: ScheduleRequest }
  | {
      readonly ok: false;
      /** 予約の言い方だが、時刻が作れない（過ぎている、25 時、間隔が短すぎる）。 */
      readonly reason: 'past' | 'invalid_time' | 'too_frequent';
    };

const WEEKDAY: Readonly<Record<string, number>> = {
  日: 0,
  月: 1,
  火: 2,
  水: 3,
  木: 4,
  金: 5,
  土: 6,
};

/** 全角数字・漢数字を半角に。「十二時」「二十分」「三十分」程度まで。 */
export function normalizeNumbers(text: string): string {
  const half = text
    .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/：/g, ':');
  const digits: Readonly<Record<string, number>> = {
    一: 1,
    二: 2,
    三: 3,
    四: 4,
    五: 5,
    六: 6,
    七: 7,
    八: 8,
    九: 9,
  };
  // 「二十五」「十二」「三十」「十」を数字に（後ろに 時・分・日・月・時間 が続くものだけ）
  return half.replace(
    /([一二三四五六七八九]?十[一二三四五六七八九]?|[一二三四五六七八九])(?=\s*(?:時|分|日|月|時間|週))/g,
    (m) => {
      if (!m.includes('十')) return String(digits[m] ?? m);
      const [tens, ones] = m.split('十');
      return String((tens ? (digits[tens] ?? 1) : 1) * 10 + (ones ? (digits[ones] ?? 0) : 0));
    },
  );
}

/** 頼みの形で終わっているか（「〜して」「〜てください」「〜教えて」「〜こと」など）。 */
const REQUEST_ENDING =
  /(?:て|で|して|ください|下さい|頼む|たのむ|お願い|おねがい|ように|よう|こと|リマインド|通知)(?:ね|よ|な|ほしい|欲しい|くれる|くれ)?[。．.！!？?\s]*$/;

/** お知らせだけを頼む言い方。前の「って」「と」「を」も一緒に外す。 */
const REMINDER_ENDING =
  /\s*(?:(?:だ|だよ)?って|と|を|の)?\s*(?:教えて|おしえて|知らせて|しらせて|お知らせして|リマインドして|リマインド|思い出させて|通知して|声をかけて|起こして|呼んで)(?:ください|下さい|ね|ほしい|欲しい|くれる)?[。．.！!\s]*$/;

const DAY_WORD =
  '今日|きょう|明日|あした|あす|明後日|あさって|今夜|今晩|来週の?[日月火水木金土]曜日?|今週の?[日月火水木金土]曜日?|[日月火水木金土]曜日?|\\d{1,2}\\s*月\\s*\\d{1,2}\\s*日|\\d{1,2}\\s*日';
const RECURRING =
  '毎日|毎朝|毎晩|毎夜|毎夕|平日|週末|土日|毎週(?:\\s*[日月火水木金土](?:曜日?)?\\s*[・、と]?)+|毎月\\s*\\d{1,2}\\s*日';
const CLOCK = new RegExp(
  `(?:(?<rec>${RECURRING})\\s*(?:の)?\\s*)?` +
    `(?:(?<day>${DAY_WORD})\\s*(?:の)?\\s*)?` +
    `(?<mod>午前|午後|朝|夜|夕方|昼|深夜)?\\s*` +
    `(?:(?<h>\\d{1,2})\\s*時\\s*(?:(?<half>半)|(?<m>\\d{1,2})\\s*分)?|(?<hh>\\d{1,2}):(?<mm>\\d{2}))` +
    `\\s*(?:ちょうど)?\\s*(?:になったら|ごろに|頃に|ごろ|頃|に)`,
);
const RELATIVE =
  /(?:(?<h>\d{1,3})\s*時間\s*(?:(?<m>\d{1,3})\s*分)?|(?<m2>\d{1,4})\s*分)\s*(?:後|あと|ご)\s*に/;
const EVERY = /(?:(?<n>\d{1,3})\s*(?<unit>分|時間)\s*(?:おき|ごと|毎)|毎時間?)\s*に?/;

export interface ParseContext {
  readonly now: number;
  readonly tz: string;
}

/**
 * 予約の頼みなら読む。予約の頼みでなければ null（いつもの振り分けに任せる）。
 */
export function parseScheduleRequest(rawText: string, context: ParseContext): ParseResult | null {
  const tz = isValidTimeZone(context.tz) ? context.tz : 'Asia/Tokyo';
  const text = normalizeNumbers(rawText.trim());

  const relative = RELATIVE.exec(text);
  if (relative?.groups) {
    const minutes =
      relative.groups['m2'] !== undefined
        ? Number(relative.groups['m2'])
        : Number(relative.groups['h']) * 60 + Number(relative.groups['m'] ?? 0);
    const action = remainder(text, relative);
    if (!action || minutes < 1 || minutes > 60 * 24 * 7) return null;
    const at = Math.ceil((context.now + minutes * 60_000) / 60_000) * 60_000;
    return finish({ kind: 'at', at: new Date(at).toISOString() }, action);
  }

  const every = EVERY.exec(text);
  if (every?.groups && !CLOCK.test(text)) {
    const n = every.groups['n'] ? Number(every.groups['n']) : 1;
    const everyMs = n * (every.groups['unit'] === '分' ? 60_000 : 3_600_000);
    const action = remainder(text, every);
    if (!action) return null;
    if (everyMs < MIN_EVERY_MS) return { ok: false, reason: 'too_frequent' };
    // 区切りのよい時刻から数える（15 分おきなら :00 :15 :30 :45）
    const step = Math.min(everyMs, 3_600_000);
    const anchorMs = Math.ceil(context.now / step) * step;
    return finish({ kind: 'every', everyMs, anchorMs }, action);
  }

  const clock = CLOCK.exec(text);
  if (!clock?.groups) return null;
  const action = remainder(text, clock);
  if (!action) return null;
  const g = clock.groups;
  let hour = Number(g['h'] ?? g['hh']);
  const minute = g['half'] ? 30 : Number(g['m'] ?? g['mm'] ?? 0);
  const rec = g['rec']?.replace(/\s/g, '') ?? null;
  const day = g['day']?.replace(/\s/g, '') ?? null;
  const pm =
    g['mod'] === '午後' ||
    g['mod'] === '夜' ||
    g['mod'] === '夕方' ||
    rec === '毎晩' ||
    rec === '毎夜' ||
    rec === '毎夕' ||
    day === '今夜' ||
    day === '今晩';
  const am = g['mod'] === '午前' || g['mod'] === '朝' || g['mod'] === '深夜' || rec === '毎朝';
  if (minute > 59 || hour > 24) return { ok: false, reason: 'invalid_time' };
  if (pm && hour < 12) hour += 12;
  else if (g['mod'] === '昼' && hour < 6) hour += 12;
  // 「明日 3 時」「毎日 5 時」の 1〜6 時は午後と読む（言い直しで確かめる）
  else if (!am && !pm && g['h'] !== undefined && hour >= 1 && hour <= 6 && (day || rec))
    hour += 12;
  if (hour === 24) hour = 0;
  if (hour > 23) return { ok: false, reason: 'invalid_time' };

  if (rec) {
    const schedule = recurringSchedule(rec, hour, minute, tz);
    return schedule ? finish(schedule, action) : null;
  }

  const now = wallClock(context.now, tz);
  if (day) {
    const date = resolveDay(day, now);
    if (!date) return { ok: false, reason: 'invalid_time' };
    const at = zonedTime(date.year, date.month, date.day, hour, minute, tz);
    if (at <= context.now) return { ok: false, reason: 'past' };
    return finish({ kind: 'at', at: new Date(at).toISOString() }, action);
  }
  // 日の言葉が無い: 今日のその時刻、過ぎていれば（午前午後の指定が無ければ 12 時間後、それも過ぎていれば）明日
  const candidates = [zonedTime(now.year, now.month, now.day, hour, minute, tz)];
  if (!am && !pm && g['h'] !== undefined && hour < 12)
    candidates.push(zonedTime(now.year, now.month, now.day, hour + 12, minute, tz));
  candidates.push(zonedTime(now.year, now.month, now.day + 1, hour, minute, tz));
  const at = candidates.find((t) => t > context.now)!;
  return finish({ kind: 'at', at: new Date(at).toISOString() }, action);
}

function recurringSchedule(rec: string, hour: number, minute: number, tz: string): Schedule | null {
  const weekly = (days: number[]): Schedule => ({ kind: 'weekly', days, hour, minute, tz });
  if (/^(毎日|毎朝|毎晩|毎夜|毎夕)$/.test(rec)) return weekly([0, 1, 2, 3, 4, 5, 6]);
  if (rec === '平日') return weekly([1, 2, 3, 4, 5]);
  if (rec === '週末' || rec === '土日') return weekly([0, 6]);
  if (rec.startsWith('毎週')) {
    const days = [...rec.matchAll(/([日月火水木金土])(?:曜日?)?/g)].map((m) => WEEKDAY[m[1]!]!);
    return days.length > 0 ? weekly([...new Set(days)]) : null;
  }
  const monthly = /^毎月(\d{1,2})日$/.exec(rec);
  if (monthly) {
    const day = Number(monthly[1]);
    return day >= 1 && day <= 31 ? { kind: 'monthly', day, hour, minute, tz } : null;
  }
  return null;
}

function resolveDay(
  word: string,
  now: ReturnType<typeof wallClock>,
): { year: number; month: number; day: number } | null {
  const plus = (days: number) => {
    const d = new Date(Date.UTC(now.year, now.month - 1, now.day + days));
    return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
  };
  if (/^(今日|きょう|今夜|今晩)$/.test(word)) return plus(0);
  if (/^(明日|あした|あす)$/.test(word)) return plus(1);
  if (/^(明後日|あさって)$/.test(word)) return plus(2);
  const weekday = /^(来週|今週)?の?([日月火水木金土])曜日?$/.exec(word);
  if (weekday) {
    const target = WEEKDAY[weekday[2]!]!;
    // 週は月曜はじまり
    const monday = -((now.weekday + 6) % 7);
    const fromMonday = (target + 6) % 7;
    if (weekday[1] === '来週') return plus(monday + 7 + fromMonday);
    if (weekday[1] === '今週') return plus(monday + fromMonday);
    return plus((target - now.weekday + 7) % 7);
  }
  const md = /^(\d{1,2})月(\d{1,2})日$/.exec(word);
  if (md) {
    const month = Number(md[1]);
    const day = Number(md[2]);
    if (month < 1 || month > 12 || day < 1 || day > 31) return null;
    const passed = month < now.month || (month === now.month && day < now.day);
    return { year: now.year + (passed ? 1 : 0), month, day };
  }
  const d = /^(\d{1,2})日$/.exec(word);
  if (d) {
    const day = Number(d[1]);
    if (day < 1 || day > 31) return null;
    return day < now.day
      ? { year: now.year, month: now.month + 1, day }
      : { year: now.year, month: now.month, day };
  }
  return null;
}

/** 時刻の言い方を外した残り。頼みの形で終わっていなければ null（予約の頼みではない）。 */
function remainder(text: string, match: RegExpExecArray): string | null {
  const rest = `${text.slice(0, match.index)} ${text.slice(match.index + match[0].length)}`
    .replace(/^[\s、,。]+|[\s、,]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!rest || !REQUEST_ENDING.test(rest)) return null;
  return rest;
}

function finish(schedule: Schedule, action: string): ParseResult {
  const reminder = REMINDER_ENDING.test(action);
  const text = reminder
    ? action
        .replace(REMINDER_ENDING, '')
        .replace(/(?:の|を|って|と)$/u, '')
        .trim()
    : action.replace(/[。．.！!\s]+$/, '');
  return {
    ok: true,
    request: {
      schedule,
      action,
      payload: reminder
        ? { kind: 'reminder', text: text || '時間です' }
        : { kind: 'task', text },
    },
  };
}
