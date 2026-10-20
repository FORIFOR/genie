/**
 * 今日のまとめの予定に、つないである Google カレンダーの予定を足す（読み取りだけ）。
 *
 * まとめの予定は Mac のカレンダー（EventKit）だけを見ていた。Google カレンダーを Genie につないでいても
 * 「今日の予定は？」に「予定はありません」と答えていた（askprobe 2026-10-19）。
 * 読めないとき（未接続・許可なし・期限切れ・通信の失敗）は null。まとめは Mac の予定だけで続ける。
 */
import type { BriefEvent } from '@genie/contracts';
import type { CalendarEvent } from '@genie/service-connectors';
import type { ConnectorRuntime } from '../connector-steps.js';

const READ_BUDGET_MS = 8_000;

export interface CloudCalendar {
  readonly events: BriefEvent[];
  readonly source: string;
}

/** `timeZone` での時差（"+09:00"）。終日予定の開始を、その日の 0 時として書くため。 */
export function offsetOf(at: Date, timeZone: string): string {
  const name =
    new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'longOffset' })
      .formatToParts(at)
      .find((p) => p.type === 'timeZoneName')?.value ?? 'GMT';
  const m = /GMT([+-]\d{2}):?(\d{2})?/.exec(name);
  return m ? `${m[1]}:${m[2] ?? '00'}` : '+00:00';
}

/** Google の予定を、まとめの予定の形へ。取り消された予定・時刻の無い予定は入れない。 */
export function briefEventFrom(event: CalendarEvent, offset: string): BriefEvent | null {
  if (event.status === 'cancelled' || !event.title.trim()) return null;
  const location = event.location?.trim().slice(0, 200);
  const base = { title: event.title.trim().slice(0, 200), ...(location ? { location } : {}) };
  if (event.start.dateTime && event.end.dateTime)
    return { ...base, start: event.start.dateTime, end: event.end.dateTime };
  if (event.start.date)
    return {
      ...base,
      start: `${event.start.date}T00:00:00${offset}`,
      end: `${event.end.date ?? event.start.date}T00:00:00${offset}`,
      allDay: true,
    };
  return null;
}

export async function readBriefGoogleCalendar(
  connectors: ConnectorRuntime | undefined,
  window: { readonly timeMin: string; readonly timeMax: string },
  offset: string,
  note: (outcome: { read: boolean; events?: number; reason?: string }) => void = () => {},
  signal: AbortSignal = AbortSignal.timeout(READ_BUDGET_MS),
): Promise<CloudCalendar | null> {
  if (!connectors) return null;
  try {
    if (!(await connectors.connected('google-calendar'))) return null;
    if (!connectors.granted('google-calendar').includes('calendar.read')) {
      note({ read: false, reason: 'not_granted' });
      return null;
    }
    const events = await connectors.googleCalendar().list({ ...window, maxResults: 40 }, signal);
    note({ read: true, events: events.length });
    return {
      events: events
        .map((e) => briefEventFrom(e, offset))
        .filter((e): e is BriefEvent => e !== null),
      source: 'Google カレンダー',
    };
  } catch (error) {
    // 理由の種類だけ（予定の中身は残さない）
    note({
      read: false,
      reason:
        (error as { reason?: string }).reason ?? (error instanceof Error ? error.name : 'unknown'),
    });
    return null;
  }
}
