/**
 * Google Calendar。正本 §2.4・§15。
 *
 * 読むのは自由、書くのは承認つき。予定を作るのは外へ出る操作で、
 * 招待メールが同席者に飛ぶ（取り消しても「取り消し通知」が飛ぶ）。
 */
import { callJson, ConnectorError, type CallConfig } from './http.js';
import {
  requireApproval,
  requireScope,
  type ApprovalProof,
  type OperationDecl,
} from './approval.js';

const BASE = 'https://www.googleapis.com/calendar/v3';

export const CALENDAR_OPERATIONS = {
  list: { id: 'calendar.list', scope: 'calendar.read', risk: 'READ', requiresApproval: false },
  get: { id: 'calendar.get', scope: 'calendar.read', risk: 'READ', requiresApproval: false },
  create: {
    id: 'calendar.create',
    scope: 'calendar.write',
    // 招待が相手へ届く。取り消しても届いた事実は消えない。
    risk: 'EXTERNAL_COMMIT',
    requiresApproval: true,
  },
} as const satisfies Record<string, OperationDecl>;

export interface CalendarAttendee {
  readonly email: string;
  readonly responseStatus: 'accepted' | 'declined' | 'tentative' | 'needsAction';
  readonly organizer: boolean;
}

export interface CalendarEvent {
  readonly id: string;
  readonly title: string;
  readonly description: string | null;
  readonly location: string | null;
  /** 開始 / 終了。**終日予定は日付だけ。**時刻を勝手に足さない。 */
  readonly start: { dateTime: string | null; date: string | null; timeZone: string | null };
  readonly end: { dateTime: string | null; date: string | null; timeZone: string | null };
  readonly attendees: readonly CalendarAttendee[];
  readonly organizerEmail: string | null;
  readonly status: 'confirmed' | 'tentative' | 'cancelled';
  readonly htmlLink: string | null;
  readonly conferenceUri: string | null;
}

export interface CreateEventInput {
  readonly calendarId?: string;
  readonly title: string;
  readonly start: { dateTime: string; timeZone?: string } | { date: string };
  readonly end: { dateTime: string; timeZone?: string } | { date: string };
  readonly description?: string;
  readonly location?: string;
  readonly attendeeEmails?: readonly string[];
}

interface RawEvent {
  id?: string;
  summary?: string;
  description?: string;
  location?: string;
  start?: { dateTime?: string; date?: string; timeZone?: string };
  end?: { dateTime?: string; date?: string; timeZone?: string };
  attendees?: { email?: string; responseStatus?: string; organizer?: boolean }[];
  organizer?: { email?: string };
  status?: string;
  htmlLink?: string;
  conferenceData?: { entryPoints?: { uri?: string; entryPointType?: string }[] };
}

function toEvent(raw: RawEvent): CalendarEvent {
  return {
    id: raw.id ?? '',
    // summary が無い予定はある（「タイトルなし」）。空文字にして、偽の題名を作らない。
    title: raw.summary ?? '',
    description: raw.description ?? null,
    location: raw.location ?? null,
    start: {
      dateTime: raw.start?.dateTime ?? null,
      date: raw.start?.date ?? null,
      timeZone: raw.start?.timeZone ?? null,
    },
    end: {
      dateTime: raw.end?.dateTime ?? null,
      date: raw.end?.date ?? null,
      timeZone: raw.end?.timeZone ?? null,
    },
    attendees: (raw.attendees ?? []).map((a) => ({
      email: a.email ?? '',
      responseStatus: normalizeResponse(a.responseStatus),
      organizer: a.organizer === true,
    })),
    organizerEmail: raw.organizer?.email ?? null,
    status: raw.status === 'cancelled' || raw.status === 'tentative' ? raw.status : 'confirmed',
    htmlLink: raw.htmlLink ?? null,
    conferenceUri:
      raw.conferenceData?.entryPoints?.find((e) => e.entryPointType === 'video')?.uri ?? null,
  };
}

function normalizeResponse(value: string | undefined): CalendarAttendee['responseStatus'] {
  return value === 'accepted' || value === 'declined' || value === 'tentative'
    ? value
    : 'needsAction';
}

export interface CalendarDeps extends CallConfig {
  /** 実際に許された scope。要求した scope ではない。 */
  readonly grantedScopes: readonly string[];
  readonly now?: () => Date;
}

export class GoogleCalendarConnector {
  readonly #deps: CalendarDeps;

  constructor(deps: CalendarDeps) {
    this.#deps = deps;
  }

  /** 期間内の予定。**繰り返しは展開して返す**（`singleEvents`）。 */
  async list(
    input: {
      calendarId?: string;
      timeMin: string;
      timeMax: string;
      maxResults?: number;
      query?: string;
    },
    signal?: AbortSignal,
  ): Promise<CalendarEvent[]> {
    requireScope(CALENDAR_OPERATIONS.list, this.#deps.grantedScopes);
    const params = new URLSearchParams({
      timeMin: input.timeMin,
      timeMax: input.timeMax,
      // 展開しないと「毎週の定例」が 1 件に見え、今週の予定が消える
      singleEvents: 'true',
      orderBy: 'startTime',
      maxResults: String(Math.min(input.maxResults ?? 50, 250)),
    });
    if (input.query) params.set('q', input.query);

    const path = `${BASE}/calendars/${encodeURIComponent(input.calendarId ?? 'primary')}/events?${params.toString()}`;
    const body = await callJson<{ items?: RawEvent[] }>(
      path,
      { method: 'GET' },
      this.#deps,
      signal,
    );
    return (body.items ?? []).map(toEvent);
  }

  async get(
    input: { calendarId?: string; eventId: string },
    signal?: AbortSignal,
  ): Promise<CalendarEvent> {
    requireScope(CALENDAR_OPERATIONS.get, this.#deps.grantedScopes);
    const path = `${BASE}/calendars/${encodeURIComponent(input.calendarId ?? 'primary')}/events/${encodeURIComponent(input.eventId)}`;
    return toEvent(await callJson<RawEvent>(path, { method: 'GET' }, this.#deps, signal));
  }

  /** Check the write account with a minimal read; write scopes also allow event readback. */
  async probeWriteAccount(signal?: AbortSignal): Promise<void> {
    requireScope(CALENDAR_OPERATIONS.create, this.#deps.grantedScopes);
    await callJson(
      `${BASE}/calendars/primary/events?maxResults=1&fields=items(id)`,
      { method: 'GET' },
      this.#deps,
      signal,
    );
  }

  async getCreatedEvent(eventId: string, signal?: AbortSignal): Promise<CalendarEvent> {
    requireScope(CALENDAR_OPERATIONS.create, this.#deps.grantedScopes);
    if (!eventId) throw new ConnectorError('not_found', 'Missing event ID');
    return toEvent(
      await callJson<RawEvent>(
        `${BASE}/calendars/primary/events/${encodeURIComponent(eventId)}`,
        { method: 'GET' },
        this.#deps,
        signal,
      ),
    );
  }

  /**
   * 予定を作る。**人の承認が要る。**
   *
   * 招待は既定で送らない（`sendUpdates=none`）。送るかどうかは
   * 承認カードで見せた内容と一致させたいので、ここで勝手に決めない。
   */
  async create(
    input: CreateEventInput,
    proof: ApprovalProof | undefined,
    signal?: AbortSignal,
  ): Promise<CalendarEvent> {
    requireScope(CALENDAR_OPERATIONS.create, this.#deps.grantedScopes);
    requireApproval(CALENDAR_OPERATIONS.create, proof, (this.#deps.now ?? (() => new Date()))());

    if (!input.title.trim()) {
      throw new ConnectorError('provider_error', 'an event needs a title');
    }
    const path = `${BASE}/calendars/${encodeURIComponent(input.calendarId ?? 'primary')}/events?sendUpdates=none`;
    const raw = await callJson<RawEvent>(
      path,
      {
        method: 'POST',
        body: {
          summary: input.title,
          start: input.start,
          end: input.end,
          ...(input.description ? { description: input.description } : {}),
          ...(input.location ? { location: input.location } : {}),
          ...(input.attendeeEmails?.length
            ? { attendees: input.attendeeEmails.map((email) => ({ email })) }
            : {}),
        },
      },
      this.#deps,
      signal,
    );
    return toEvent(raw);
  }
}
