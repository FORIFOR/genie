/**
 * 予定の頼みを、決まった形にする（仕様 v1.0 §11・§5③）。純粋関数。
 *
 *   「明日の予定教えて」        → agenda（その日の 0 時〜翌 0 時）
 *   「午後にずらして」「30分遅らせて」「15時に変更して」「打ち合わせを1時間早めて」 → move（対象は直前に出した一覧から）
 *   「元に戻して」「やっぱなし」 → undo（直前に変えた予定を、変える前へ）
 *
 * 決まらないもの（対象が 2 つ以上・一覧を出していない）は、実行せずに聞き返す。
 * 時刻は本人の時間帯（GENIE_TIMEZONE）で読む。予定の長さは変えない（開始と終了を同じだけ動かす）。
 */

export type CalendarIntent =
  | {
      readonly kind: 'agenda';
      readonly label: string;
      readonly timeMin: string;
      readonly timeMax: string;
    }
  | { readonly kind: 'move'; readonly target: Target; readonly change: Change }
  | { readonly kind: 'undo' };

/** どの予定か（直前の一覧の中から選ぶ）。 */
export interface Target {
  /** 題名の一部（「打ち合わせ」）。 */
  readonly words: readonly string[];
  /** 開始の時（「10時の」）。 */
  readonly hour: number | null;
  /** 「それ」「その予定」。 */
  readonly pronoun: boolean;
}

export type Change =
  | { readonly kind: 'shift'; readonly minutes: number }
  | { readonly kind: 'at'; readonly hour: number; readonly minute: number; readonly label: string };

export interface ListedEvent {
  readonly id: string;
  readonly title: string;
  readonly start: string;
  readonly end: string;
  readonly allDay: boolean;
}

const DAY =
  /(今日|きょう|本日|明日|あした|あす|明後日|あさって|今週末|週末|土日|再来週|今週|来週|(\d{1,2})\s*[\/月]\s*(\d{1,2})\s*日?)/;
const AGENDA = /(予定|よてい|スケジュール)/;
const CHANGE_VERB = /(ずら|遅らせ|おくらせ|早め|はやめ|変更|変えて|移動|後ろ|うしろ|前倒し)/;
const UNDO =
  /(元に戻|もとに戻|もとにもど|戻して|もどして|やっぱ(?:り)?(?:なし|やめ|元)|取り消して元)/;

/** 本人の時間帯での、その瞬間の UTC からのずれ（分）。 */
export function offsetMinutes(at: Date, timeZone: string): number {
  const name =
    new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'longOffset' })
      .formatToParts(at)
      .find((p) => p.type === 'timeZoneName')?.value ?? 'GMT';
  const m = /GMT([+-])(\d{2}):?(\d{2})?/.exec(name);
  if (!m) return 0;
  return (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3] ?? 0));
}

/** その時間帯の年月日・時分を、ずれつきの ISO にする（例 2026-10-28T14:00:00+09:00）。 */
export function zonedIso(
  y: number,
  mo: number,
  d: number,
  h: number,
  mi: number,
  timeZone: string,
): string {
  const guess = new Date(Date.UTC(y, mo - 1, d, h, mi));
  const off = offsetMinutes(
    new Date(guess.getTime() - offsetMinutes(guess, timeZone) * 60_000),
    timeZone,
  );
  const sign = off < 0 ? '-' : '+';
  const abs = Math.abs(off);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${String(y)}-${p(mo)}-${p(d)}T${p(h)}:${p(mi)}:00${sign}${p(Math.floor(abs / 60))}:${p(abs % 60)}`;
}

/** その瞬間を、本人の時間帯の年月日・時分に分ける。 */
export function zonedParts(at: Date, timeZone: string) {
  const shifted = new Date(at.getTime() + offsetMinutes(at, timeZone) * 60_000);
  return {
    y: shifted.getUTCFullYear(),
    mo: shifted.getUTCMonth() + 1,
    d: shifted.getUTCDate(),
    h: shifted.getUTCHours(),
    mi: shifted.getUTCMinutes(),
    dow: shifted.getUTCDay(),
  };
}

/** ISO の日時に分を足し、本人の時間帯のずれつき ISO で返す。 */
export function shiftIso(iso: string, minutes: number, timeZone: string): string {
  const p = zonedParts(new Date(Date.parse(iso) + minutes * 60_000), timeZone);
  return zonedIso(p.y, p.mo, p.d, p.h, p.mi, timeZone);
}

const WEEK = ['日', '月', '火', '水', '木', '金', '土'];

/** 見せる時刻（「10/28（水）10:00〜11:00」）。 */
export function rangeLabel(start: string, end: string, timeZone: string, allDay = false): string {
  const s = zonedParts(new Date(allDay ? `${start}T00:00:00Z` : start), allDay ? 'UTC' : timeZone);
  const date = `${String(s.mo)}/${String(s.d)}（${WEEK[s.dow]!}）`;
  if (allDay) return `${date} 終日`;
  const e = zonedParts(new Date(end), timeZone);
  const t = (h: number, mi: number) => `${String(h)}:${String(mi).padStart(2, '0')}`;
  return `${date} ${t(s.h, s.mi)}〜${t(e.h, e.mi)}`;
}

function agendaRange(text: string, now: Date, timeZone: string) {
  const today = zonedParts(now, timeZone);
  const startOf = (offsetDays: number) => {
    const base = new Date(Date.UTC(today.y, today.mo - 1, today.d + offsetDays));
    return {
      y: base.getUTCFullYear(),
      mo: base.getUTCMonth() + 1,
      d: base.getUTCDate(),
      dow: base.getUTCDay(),
    };
  };
  const iso = (p: { y: number; mo: number; d: number }) => zonedIso(p.y, p.mo, p.d, 0, 0, timeZone);
  const day = DAY.exec(text);
  const word = day?.[1] ?? '今日';
  let from = 0;
  let days = 1;
  let label = '今日';
  if (/明後日|あさって/.test(word)) [from, label] = [2, '明後日'];
  else if (/明日|あした|あす/.test(word)) [from, label] = [1, '明日'];
  else if (/今週末|週末|土日/.test(word)) {
    // 次の土曜（今日が土日ならその週の土曜）から月曜の 0 時まで
    const toSat = today.dow === 0 ? -1 : 6 - today.dow;
    [from, days, label] = [toSat, 2, '今週末'];
  } else if (/再来週/.test(word)) [from, days, label] = [14 - ((today.dow + 6) % 7), 7, '再来週'];
  else if (/今週/.test(word)) [from, days, label] = [0, 7 - ((today.dow + 6) % 7), '今週'];
  else if (/来週/.test(word)) [from, days, label] = [7 - ((today.dow + 6) % 7), 7, '来週'];
  else if (day?.[2] && day[3]) {
    const mo = Number(day[2]);
    const d = Number(day[3]);
    let y = today.y;
    if (Date.UTC(y, mo - 1, d) < Date.UTC(today.y, today.mo - 1, today.d)) y += 1;
    const target = { y, mo, d };
    const next = new Date(Date.UTC(y, mo - 1, d + 1));
    return {
      label: `${String(mo)}/${String(d)}`,
      timeMin: iso(target),
      timeMax: iso({ y: next.getUTCFullYear(), mo: next.getUTCMonth() + 1, d: next.getUTCDate() }),
    };
  }
  return { label, timeMin: iso(startOf(from)), timeMax: iso(startOf(from + days)) };
}

function changeOf(text: string): Change | null {
  const minutes = /(\d{1,3})\s*分/.exec(text);
  const hours = /(\d{1,2})\s*時間/.exec(text);
  const back = /(遅らせ|おくらせ|後ろ|うしろ|後に|あとに|ずら)/.test(text);
  const forward = /(早め|はやめ|前倒し|前に)/.test(text);
  // 「15時の会議を30分うしろに」の「15時の」は対象で、変えたあとの時刻ではない
  const withoutTarget = text
    .replace(/\d{1,2}\s*時間/, '')
    .replace(/\d{1,2}\s*時(?:\s*\d{1,2}\s*分|半)?\s*(?:の|から始まる)/, '');
  if ((minutes || hours) && !/\d{1,2}\s*時(?!間)/.test(withoutTarget)) {
    const amount = (hours ? Number(hours[1]) * 60 : 0) + (minutes ? Number(minutes[1]) : 0);
    if (amount > 0 && (back || forward))
      return { kind: 'shift', minutes: forward && !back ? -amount : amount };
  }
  const at =
    /(午前|午後)?\s*(\d{1,2})\s*時\s*(?:(\d{1,2})\s*分|(半))?\s*(?:から|に|へ|スタート)/.exec(text);
  if (at) {
    let h = Number(at[2]);
    if (at[1] === '午後' && h < 12) h += 12;
    const mi = at[4] ? 30 : at[3] ? Number(at[3]) : 0;
    if (h <= 23 && mi <= 59)
      return {
        kind: 'at',
        hour: h,
        minute: mi,
        label: `${String(h)}:${String(mi).padStart(2, '0')}`,
      };
  }
  // 時刻を言わない「午後に」「夕方に」は、ふつうの始まりの時刻にして、承認カードで見せて直せるようにする
  if (/午後に|ごごに/.test(text)) return { kind: 'at', hour: 14, minute: 0, label: '14:00' };
  if (/午前に|ごぜんに|朝に/.test(text)) return { kind: 'at', hour: 10, minute: 0, label: '10:00' };
  if (/夕方に/.test(text)) return { kind: 'at', hour: 17, minute: 0, label: '17:00' };
  if (/夜に/.test(text)) return { kind: 'at', hour: 19, minute: 0, label: '19:00' };
  return null;
}

/** 文から予定の頼みを読む。予定の頼みでなければ null（いつもの振り分けへ）。 */
export function parseCalendarIntent(
  text: string,
  now: Date,
  timeZone: string,
): CalendarIntent | null {
  const t = text.trim();
  if (!t || t.length > 120) return null;
  if (UNDO.test(t) && !AGENDA.test(t.replace(/予定を?元に/, ''))) return { kind: 'undo' };
  if (CHANGE_VERB.test(t)) {
    const change = changeOf(t);
    if (!change) return null;
    const hour = /(\d{1,2})\s*時(?:\s*\d{1,2}\s*分)?\s*の/.exec(t);
    const words = [...t.matchAll(/([ぁ-んァ-ヶー一-龯A-Za-z0-9]{2,12}?)(?:の予定|を|は)/g)]
      .map((m) => m[1]!)
      .filter(
        (w) =>
          !/^(予定|それ|これ|あれ|その|この|時間|午前|午後|明日|今日)$/.test(w) && !/\d/.test(w),
      );
    return {
      kind: 'move',
      target: {
        words,
        hour: hour ? Number(hour[1]) : null,
        pronoun: /(それ|その|そっち|そいつ|これ|この|あれ)/.test(t),
      },
      change,
    };
  }
  // 「今日なんかあったっけ」「今週末なんか入ってる？」「あさっての午後どうなってる？」も、その日の予定を聞いている
  const asksDay =
    DAY.test(t) &&
    /(なんか|何か|なにか)\s*(?:あ|入)|入ってる|はいってる|空いて|あいて|どうなって|予定/.test(t);
  if (
    (AGENDA.test(t) && (DAY.test(t) || /教えて|ある|は[？?]?$|確認|見せて|どう/.test(t))) ||
    asksDay
  ) {
    if (/(入れ|登録|追加|作って|消し|削除)/.test(t)) return null;
    return { kind: 'agenda', ...agendaRange(t, now, timeZone) };
  }
  return null;
}

/** 直前の一覧から、頼みの対象を選ぶ。1 つに決まれば予定、決まらなければ候補（0 か 2 つ以上）。 */
export function pickTarget(
  target: Target,
  events: readonly ListedEvent[],
  timeZone: string,
): { event: ListedEvent } | { candidates: readonly ListedEvent[] } {
  const timed = events.filter((e) => !e.allDay);
  let found = timed;
  if (target.words.length > 0) {
    const byTitle = timed.filter((e) => target.words.some((w) => e.title.includes(w)));
    if (byTitle.length > 0) found = byTitle;
  }
  if (target.hour !== null)
    found = found.filter((e) => zonedParts(new Date(e.start), timeZone).h === target.hour);
  return found.length === 1 ? { event: found[0]! } : { candidates: found };
}

/** 変えたあとの開始・終了（長さは変えない）。 */
export function applyChange(
  event: ListedEvent,
  change: Change,
  timeZone: string,
): { start: string; end: string } {
  const length = Date.parse(event.end) - Date.parse(event.start);
  if (change.kind === 'shift')
    return {
      start: shiftIso(event.start, change.minutes, timeZone),
      end: shiftIso(event.end, change.minutes, timeZone),
    };
  const day = zonedParts(new Date(event.start), timeZone);
  const start = zonedIso(day.y, day.mo, day.d, change.hour, change.minute, timeZone);
  return { start, end: shiftIso(start, length / 60_000, timeZone) };
}
