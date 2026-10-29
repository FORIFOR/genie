/**
 * 予約の「いつ」。**純粋関数。**
 *
 * 形は 4 つだけ。cron の式は使わない（利用者は話し言葉で頼むので、式を見せる場面が無い）。
 *   at       1 回だけ（「30 分後に」「明日 9 時に」）
 *   every    間隔（「15 分おきに」「毎時」）
 *   weekly   曜日と時刻（「毎朝 8 時に」= 毎日、「平日 9 時に」、「毎週月曜 10 時に」）
 *   monthly  日と時刻（「毎月 25 日 10 時に」。無い日は月末に寄せる）
 *
 * 時刻は**タイムゾーンつきの壁時計**で持つ。オフセットの無い時刻を UTC と読む、といった
 * 食い違いを作らない（openclaw の at と cron の既定が食い違っていたのを避ける）。
 */

export type Schedule =
  | { readonly kind: 'at'; readonly at: string }
  | { readonly kind: 'every'; readonly everyMs: number; readonly anchorMs: number }
  | {
      readonly kind: 'weekly';
      /** 0 = 日曜 … 6 = 土曜。7 つ全部なら毎日。 */
      readonly days: readonly number[];
      readonly hour: number;
      readonly minute: number;
      readonly tz: string;
    }
  | {
      readonly kind: 'monthly';
      readonly day: number;
      readonly hour: number;
      readonly minute: number;
      readonly tz: string;
    };

/** 間隔の下限。これより短い繰り返しは受けない（通知の嵐にしない）。 */
export const MIN_EVERY_MS = 5 * 60 * 1000;

interface WallClock {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  /** 0 = 日曜 */
  readonly weekday: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
      weekday: 'short',
    });
    formatters.set(tz, f);
  }
  return f;
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** その瞬間の、そのタイムゾーンでの壁時計。 */
export function wallClock(epochMs: number, tz: string): WallClock {
  const parts = formatterFor(tz).formatToParts(new Date(epochMs));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '0';
  return {
    year: Number(get('year')),
    month: Number(get('month')),
    day: Number(get('day')),
    hour: Number(get('hour')),
    minute: Number(get('minute')),
    weekday: WEEKDAYS.indexOf(get('weekday')),
  };
}

/** そのタイムゾーンの UTC からのずれ（ms）。 */
function offsetMs(epochMs: number, tz: string): number {
  const parts = formatterFor(tz).formatToParts(new Date(epochMs));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? '0');
  const asUtc = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    get('hour'),
    get('minute'),
    get('second'),
  );
  return asUtc - Math.floor(epochMs / 1000) * 1000;
}

/**
 * 壁時計（そのタイムゾーン）→ 瞬間。夏時間の切り替えで無い時刻は後ろへ、二度ある時刻は前を取る。
 * 月・日は溢れてよい（Date.UTC と同じく繰り上がる）。
 */
export function zonedTime(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  tz: string,
): number {
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  // 切り替えの前と後のずれで 1 つずつ候補を作り、壁時計が合うものを取る
  const day_ = 24 * 60 * 60 * 1000;
  const candidates = [guess - offsetMs(guess - day_, tz), guess - offsetMs(guess + day_, tz)];
  const valid = candidates.filter((t) => t + offsetMs(t, tz) === guess);
  // 二度ある時刻（夏時間の終わり）は前、無い時刻（始まり）は後ろへ
  return valid.length > 0 ? Math.min(...valid) : Math.max(...candidates);
}

/** タイムゾーン名が使えるか。 */
export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * `after` より後の、次の実行時刻（ms）。無ければ null（1 回だけの予約が過ぎた）。
 * `after` ちょうどは含めない（同じ回を二度出さない）。
 */
export function nextRunAfter(schedule: Schedule, after: number): number | null {
  switch (schedule.kind) {
    case 'at': {
      const at = Date.parse(schedule.at);
      return Number.isFinite(at) && at > after ? at : null;
    }
    case 'every': {
      const { everyMs, anchorMs } = schedule;
      if (everyMs < 1) return null;
      if (after < anchorMs) return anchorMs;
      return anchorMs + (Math.floor((after - anchorMs) / everyMs) + 1) * everyMs;
    }
    case 'weekly': {
      if (schedule.days.length === 0) return null;
      const today = wallClock(after, schedule.tz);
      // 今日から 8 日先まで見れば、必ずどれかの曜日に当たる
      for (let offset = 0; offset <= 8; offset += 1) {
        const weekday = (today.weekday + offset) % 7;
        if (!schedule.days.includes(weekday)) continue;
        const t = zonedTime(
          today.year,
          today.month,
          today.day + offset,
          schedule.hour,
          schedule.minute,
          schedule.tz,
        );
        if (t > after) return t;
      }
      return null;
    }
    case 'monthly': {
      const now = wallClock(after, schedule.tz);
      for (let offset = 0; offset <= 2; offset += 1) {
        const month = now.month + offset;
        // その月に無い日（31 日など）は月末に寄せる
        const lastDay = new Date(Date.UTC(now.year, month, 0)).getUTCDate();
        const t = zonedTime(
          now.year,
          month,
          Math.min(schedule.day, lastDay),
          schedule.hour,
          schedule.minute,
          schedule.tz,
        );
        if (t > after) return t;
      }
      return null;
    }
  }
}

/** 次の n 回（確認のときに見せる）。 */
export function upcomingRuns(schedule: Schedule, after: number, count: number): number[] {
  const runs: number[] = [];
  let cursor = after;
  for (let i = 0; i < count; i += 1) {
    const next = nextRunAfter(schedule, cursor);
    if (next === null) break;
    runs.push(next);
    cursor = next;
  }
  return runs;
}

export const isRecurring = (schedule: Schedule): boolean => schedule.kind !== 'at';

const DAY_NAMES = ['日', '月', '火', '水', '木', '金', '土'];

const pad = (n: number) => String(n).padStart(2, '0');

/** 「10/22（水）9:00」 */
export function formatWhen(epochMs: number, tz: string): string {
  const w = wallClock(epochMs, tz);
  return `${String(w.month)}/${String(w.day)}（${DAY_NAMES[w.weekday]!}）${String(w.hour)}:${pad(w.minute)}`;
}

/** 予約の言い直し（「平日の 9:00」「毎日 8:00」「30 分ごと」「10/22（水）9:00」）。 */
export function describeSchedule(schedule: Schedule, tz: string): string {
  switch (schedule.kind) {
    case 'at':
      return formatWhen(Date.parse(schedule.at), tz);
    case 'every': {
      const minutes = Math.round(schedule.everyMs / 60_000);
      return minutes % 60 === 0 ? `${String(minutes / 60)} 時間ごと` : `${String(minutes)} 分ごと`;
    }
    case 'weekly': {
      const time = `${String(schedule.hour)}:${pad(schedule.minute)}`;
      const days = [...schedule.days].sort((a, b) => a - b);
      if (days.length === 7) return `毎日 ${time}`;
      if (days.join() === '1,2,3,4,5') return `平日の ${time}`;
      if (days.join() === '0,6') return `土日の ${time}`;
      return `毎週${days.map((d) => DAY_NAMES[d]!).join('・')}曜 ${time}`;
    }
    case 'monthly':
      return `毎月 ${String(schedule.day)} 日 ${String(schedule.hour)}:${pad(schedule.minute)}`;
  }
}
