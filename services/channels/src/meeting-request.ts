/**
 * グループで「@Genie 明日15時から30分 打ち合わせ、Meet作って」と頼まれた会議を読む。
 *
 * グループの発言はモデルに渡さない（家族・仲間の会話を外へ出さない）ので、**決まった言い方だけ**を読む。
 * 読めた中身は持ち主の 1:1 トークで承認を取ってから、持ち主のカレンダーに Meet 付きで入れる。
 *
 *   日  : 今日・明日・明後日（あさって）・11/6・11月6日・6日・金曜（次のその曜日。「来週金曜」は 7 日先から）
 *   時刻: 15時・15時半・15時30分・15:30・午後3時（日が無ければ今日。過ぎた時刻なら読まない）
 *   終わり: 「〜16時」「から16時まで」・「30分」「1時間」「1時間半」。無ければ 1 時間
 *   言葉: Meet・ミート・会議・打ち合わせ・ミーティング・MTG のどれかが要る
 */

export interface MeetingRequest {
  readonly title: string;
  /** 本人の時間帯の時差つきの ISO（例 2026-11-06T15:00:00+09:00） */
  readonly start: string;
  readonly end: string;
  /** 承認カード・グループへの返事に出す日時（例 11/6(金) 15:00〜15:30） */
  readonly whenLabel: string;
}

const WORD = /(?:google\s*)?meet|ミート|会議|打ち?合わ?せ|ミーティング|mtg/i;
const DOW = ['日', '月', '火', '水', '木', '金', '土'] as const;

/** 全角の数字・記号を半角に（「１５：００」「１１／６」） */
const half = (text: string) =>
  text
    .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/：/g, ':')
    .replace(/／/g, '/')
    .replace(/[〜～]/g, '〜');

interface Ymd {
  readonly y: number;
  readonly m: number;
  readonly d: number;
}

/** その時間帯での今日の日付と曜日 */
function today(now: number, timeZone: string): Ymd & { readonly dow: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    weekday: 'short',
  }).formatToParts(new Date(now));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return {
    y: Number(get('year')),
    m: Number(get('month')),
    d: Number(get('day')),
    dow: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(get('weekday')),
  };
}

const addDays = (day: Ymd, days: number): Ymd => {
  const t = new Date(Date.UTC(day.y, day.m - 1, day.d + days));
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
};

/** その時間帯の壁時計の時刻を、時差つきの ISO と UTC の時刻にする */
function zoned(day: Ymd, hour: number, minute: number, timeZone: string) {
  const wall = Date.UTC(day.y, day.m - 1, day.d, hour, minute);
  // 時差は、その時刻のあたりで 2 回測る（夏時間の切り替わりでずれないように）
  const offsetAt = (t: number) => {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
    }).formatToParts(new Date(t));
    const n = (type: string) => Number(parts.find((p) => p.type === type)?.value);
    return (Date.UTC(n('year'), n('month') - 1, n('day'), n('hour'), n('minute')) - t) / 60_000;
  };
  let offset = offsetAt(wall);
  offset = offsetAt(wall - offset * 60_000);
  const utc = wall - offset * 60_000;
  const local = new Date(wall);
  const pad = (v: number) => String(v).padStart(2, '0');
  const sign = offset >= 0 ? '+' : '-';
  const abs = Math.abs(offset);
  const iso =
    `${String(local.getUTCFullYear())}-${pad(local.getUTCMonth() + 1)}-${pad(local.getUTCDate())}` +
    `T${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}:00` +
    `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
  return { iso, utc };
}

/** 「午後3時」「15時半」「15:30」→ [時, 分]。読めなければ null */
function timeOf(text: string): { hour: number; minute: number; match: string } | null {
  const m = /(午前|午後|朝|夜)?\s*(\d{1,2})\s*(?::\s*(\d{2})|時\s*(?:(半)|(\d{1,2})\s*分)?)/.exec(
    text,
  );
  if (!m) return null;
  let hour = Number(m[2]);
  const minute = m[3] ? Number(m[3]) : m[4] ? 30 : m[5] ? Number(m[5]) : 0;
  if ((m[1] === '午後' || m[1] === '夜') && hour < 12) hour += 12;
  if (hour > 23 || minute > 59) return null;
  return { hour, minute, match: m[0] };
}

function dayOf(text: string, now: number, timeZone: string): { day: Ymd; match: string } | null {
  const t = today(now, timeZone);
  const base: Ymd = { y: t.y, m: t.m, d: t.d };
  const rel = /(今日|きょう|本日|明日|あした|あす|明後日|あさって)/.exec(text);
  if (rel) {
    const offset = /今日|きょう|本日/.test(rel[1]!) ? 0 : /明後日|あさって/.test(rel[1]!) ? 2 : 1;
    return { day: addDays(base, offset), match: rel[0] };
  }
  const md = /(\d{1,2})\s*(?:\/|月)\s*(\d{1,2})\s*日?/.exec(text);
  if (md) {
    const m = Number(md[1]);
    const d = Number(md[2]);
    if (m < 1 || m > 12 || d < 1 || d > 31) return null;
    // 過ぎた月日は来年
    const y = m < t.m || (m === t.m && d < t.d) ? t.y + 1 : t.y;
    return { day: { y, m, d }, match: md[0] };
  }
  const week = /(来週|再来週)?\s*([日月火水木金土])曜日?/.exec(text);
  if (week) {
    const target = DOW.indexOf(week[2] as (typeof DOW)[number]);
    // 前置きが無ければ、次のその曜日（今日を含む）。「来週」「再来週」は月曜始まりの週で数える
    let ahead = (target - t.dow + 7) % 7;
    if (week[1]) {
      const toNextMonday = (8 - t.dow) % 7 || 7;
      ahead = toNextMonday + ((target + 6) % 7) + (week[1] === '再来週' ? 7 : 0);
    }
    return { day: addDays(base, ahead), match: week[0] };
  }
  const dayOnly = /(?<![\d/月])(\d{1,2})\s*日(?!本)/.exec(text);
  if (dayOnly) {
    const d = Number(dayOnly[1]);
    if (d < 1 || d > 31) return null;
    const next = d < t.d ? { y: t.m === 12 ? t.y + 1 : t.y, m: t.m === 12 ? 1 : t.m + 1 } : t;
    return { day: { y: next.y, m: next.m, d }, match: dayOnly[0] };
  }
  return null;
}

/** 長さ（分）。「30分」「1時間」「1時間半」「90分間」 */
function lengthOf(text: string): { minutes: number; match: string } | null {
  const m = /(\d{1,2})\s*時間\s*(半)?|(\d{1,3})\s*分間?/.exec(text);
  if (!m) return null;
  const minutes = m[1] ? Number(m[1]) * 60 + (m[2] ? 30 : 0) : Number(m[3]);
  return minutes > 0 && minutes <= 12 * 60 ? { minutes, match: m[0] } : null;
}

const label = (day: Ymd, dow: number, sh: number, sm: number, eh: number, em: number) => {
  const pad = (v: number) => String(v).padStart(2, '0');
  return `${String(day.m)}/${String(day.d)}(${DOW[dow]!}) ${String(sh)}:${pad(sm)}〜${String(eh)}:${pad(em)}`;
};

export function parseMeetingRequest(
  raw: string,
  now: number,
  timeZone: string,
): MeetingRequest | null {
  const text = half(raw).trim();
  if (!WORD.test(text)) return null;
  const at = dayOf(text, now, timeZone);
  let rest = at ? text.replace(at.match, ' ') : text;
  const start = timeOf(rest);
  if (!start) return null;
  rest = rest.replace(start.match, ' ');
  const day = at?.day ?? (({ y, m, d }) => ({ y, m, d }))(today(now, timeZone));

  // 終わり: 「〜16時」「から16時まで」「-16:00」。無ければ長さ、それも無ければ 1 時間
  let endHour: number;
  let endMinute: number;
  const until =
    /(?:〜|-|から)\s*((?:午前|午後)?\s*\d{1,2}\s*(?::\s*\d{2}|時\s*(?:半|\d{1,2}\s*分)?))\s*(?:まで)?/.exec(
      rest,
    );
  const endTime = until ? timeOf(until[1]!) : null;
  const length = lengthOf(rest);
  if (endTime) {
    endHour = endTime.hour;
    endMinute = endTime.minute;
    // 「午後3時〜4時」の 4 時は午後
    if (endHour * 60 + endMinute <= start.hour * 60 + start.minute && endHour < 12) endHour += 12;
    rest = rest.replace(until![0], ' ');
  } else {
    const minutes = length?.minutes ?? 60;
    if (length) rest = rest.replace(length.match, ' ');
    const total = start.hour * 60 + start.minute + minutes;
    endHour = Math.floor(total / 60);
    endMinute = total % 60;
  }
  if (endHour * 60 + endMinute <= start.hour * 60 + start.minute || endHour > 23) return null;

  const from = zoned(day, start.hour, start.minute, timeZone);
  // 過ぎた時刻の会議は作らない（「今日10時」と昼に言われたら、聞き間違いかもしれない）
  if (from.utc < now) return null;
  const to = zoned(day, endHour, endMinute, timeZone);
  const dow = new Date(Date.UTC(day.y, day.m - 1, day.d)).getUTCDay();

  // 題名: 日時・頼みの言葉を除いた残り。何も残らなければ「ミーティング」
  const title =
    rest
      .replace(/(?:google\s*)?meet\s*(?:の)?(?:リンク|URL)?/gi, ' ')
      .replace(/ミート/g, ' ')
      .replace(
        /(?:を|で|の|に|は)?\s*(?:作って|つくって|作成して|設定して|入れて|いれて|予約して|お願い(?:します)?|おねがい|して(?:ください|下さい)?|ください|下さい|しよう|やろう|ほしい|欲しい|お願いできますか)/g,
        ' ',
      )
      .replace(/(?:から|まで|より)/g, ' ')
      .replace(/[、。,.!！?？\s]+/g, ' ')
      .replace(/^(?:\s|で|の|を|に|は)+|(?:\s|で|の|を|に|は)+$/g, '')
      .trim()
      .slice(0, 60) || 'ミーティング';

  return {
    title,
    start: from.iso,
    end: to.iso,
    whenLabel: label(day, dow, start.hour, start.minute, endHour, endMinute),
  };
}
