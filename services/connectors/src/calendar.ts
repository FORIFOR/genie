/**
 * Google Calendar。正本 §2.4・§15。
 *
 * 読むのは自由、書くのは承認つき。予定を作るのは外へ出る操作で、
 * 招待メールが同席者に飛ぶ（取り消しても「取り消し通知」が飛ぶ）。
 */
import { createHash } from 'node:crypto';
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
  invite: {
    id: 'calendar.invite',
    scope: 'calendar.write',
    // 作った会議に人を足す。招待のメールが相手へ届く（取り消しても届いた事実は消えない）。
    risk: 'EXTERNAL_COMMIT',
    requiresApproval: true,
  },
  move: {
    id: 'calendar.move',
    scope: 'calendar.write',
    // 予定の時間を変える。同席者の予定にも影響する（通知は送らないが、相手のカレンダーの表示は変わる）。
    risk: 'EXTERNAL_COMMIT',
    requiresApproval: true,
  },
} as const satisfies Record<string, OperationDecl>;

/**
 * Genie が作った会議に人を足す。会議は Meet の頼みの印（作るときに予定へ残す目印）で探し、
 * 目印の無い会議（目印を残す前に作ったもの）は、開始・終了・題名がぴったり合う予定で探す。
 */
export interface InviteInput {
  readonly calendarId?: string;
  readonly meetRequestId?: string;
  readonly title: string;
  /** 時差つきの ISO の日時 */
  readonly start: string;
  readonly end: string;
  readonly emails: readonly string[];
}

/** 予定に残す Genie の目印（extendedProperties.private の名前） */
export const MEET_REQUEST_PROPERTY = 'genieMeetRequest';

/** 予定の時間を変える。終日予定は日付、時刻つきは日時。**形を混ぜない**（終日を時刻つきにしない）。 */
export interface MoveEventInput {
  readonly calendarId?: string;
  readonly eventId: string;
  readonly start: { dateTime: string; timeZone?: string } | { date: string };
  readonly end: { dateTime: string; timeZone?: string } | { date: string };
}

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
  /** Google Meet の会議を付ける（`conferenceData.createRequest`）。承認カードに出したときだけ true にする */
  readonly meet?: boolean;
  /** Meet を作る頼みの一意な印（同じ承認の再試行で会議を 2 つ作らない）。無ければ予定の中身から作る */
  readonly meetRequestId?: string;
  /** 招待のメールを送る（`sendUpdates=all`）。承認カードに招待する人を出したときだけ true にする */
  readonly sendInvites?: boolean;
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
  extendedProperties?: { private?: Record<string, string> };
  status?: string;
  htmlLink?: string;
  conferenceData?: { entryPoints?: { uri?: string; entryPointType?: string }[] };
  hangoutLink?: string;
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
      raw.conferenceData?.entryPoints?.find((e) => e.entryPointType === 'video')?.uri ??
      raw.hangoutLink ??
      null,
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

/** 予定の中身から決まる Meet の頼みの印（Google は同じ印の頼みを 1 つの会議として扱う） */
export function meetRequestId(input: Pick<CreateEventInput, 'title' | 'start' | 'end'>): string {
  const key = JSON.stringify([input.title, input.start, input.end]);
  return `genie-${createHash('sha256').update(key).digest('hex').slice(0, 32)}`;
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

  /**
   * 予定を作る。**人の承認が要る。**
   *
   * 招待は既定で送らない（`sendUpdates=none`）。送るかどうかは
   * 承認カードで見せた内容と一致させたいので、ここで勝手に決めない（`sendInvites` が来たときだけ送る）。
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
    // Meet を付けるときは conferenceDataVersion=1 が要る（無いと createRequest は黙って捨てられる）
    // 招待を送るのは、承認カードに招待する人を出したとき（sendInvites）だけ
    const updates = input.sendInvites && input.attendeeEmails?.length ? 'all' : 'none';
    const path = `${BASE}/calendars/${encodeURIComponent(input.calendarId ?? 'primary')}/events?sendUpdates=${updates}${input.meet ? '&conferenceDataVersion=1' : ''}`;
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
          ...(input.meet
            ? {
                conferenceData: {
                  createRequest: {
                    requestId: input.meetRequestId ?? meetRequestId(input),
                    conferenceSolutionKey: { type: 'hangoutsMeet' },
                  },
                },
                // あとで「この人も招待して」と言われたときに、この会議を探せるように目印を残す
                extendedProperties: {
                  private: { [MEET_REQUEST_PROPERTY]: input.meetRequestId ?? meetRequestId(input) },
                },
              }
            : {}),
        },
      },
      this.#deps,
      signal,
    );
    // Meet が付かなかったときも予定はもうある。ここで失敗にすると再試行で予定が 2 つになるので、
    // conferenceUri が null のまま返し、答えの文で「Meet は付きませんでした」と伝える
    return toEvent(raw);
  }

  /**
   * 予定の時間を変える。**人の承認が要る。**変える前の予定も返す（「元に戻して」に使う）。
   *
   * 通知は送らない（`sendUpdates=none`）。作るときと同じく、送るかどうかは承認で見せた内容と一致させる。
   */
  async move(
    input: MoveEventInput,
    proof: ApprovalProof | undefined,
    signal?: AbortSignal,
  ): Promise<{ before: CalendarEvent; after: CalendarEvent }> {
    requireScope(CALENDAR_OPERATIONS.move, this.#deps.grantedScopes);
    requireApproval(CALENDAR_OPERATIONS.move, proof, (this.#deps.now ?? (() => new Date()))());
    const allDay = 'date' in input.start;
    if (allDay !== 'date' in input.end) {
      throw new ConnectorError(
        'provider_error',
        'start and end must both be dates or both be times',
      );
    }
    const before = await this.get(
      { ...(input.calendarId ? { calendarId: input.calendarId } : {}), eventId: input.eventId },
      signal,
    );
    if (before.status === 'cancelled') {
      throw new ConnectorError('provider_error', 'the event has been cancelled');
    }
    const path = `${BASE}/calendars/${encodeURIComponent(input.calendarId ?? 'primary')}/events/${encodeURIComponent(input.eventId)}?sendUpdates=none`;
    const raw = await callJson<RawEvent>(
      path,
      // 終日と時刻つきを入れ替えるときに、古い側の欄が残らないよう null で消す
      {
        method: 'PATCH',
        body: {
          start: allDay ? { ...input.start, dateTime: null } : { ...input.start, date: null },
          end: allDay ? { ...input.end, dateTime: null } : { ...input.end, date: null },
        },
      },
      this.#deps,
      signal,
    );
    return { before, after: toEvent(raw) };
  }

  /**
   * Genie が作った会議に人を足す。**人の承認が要る。**足した人にだけ招待のメールが届く（`sendUpdates=all`）。
   * もう入っている人は足さない（足す人がいなければ何も変えない）。会議が見つからなければ失敗にする。
   */
  async invite(
    input: InviteInput,
    proof: ApprovalProof | undefined,
    signal?: AbortSignal,
  ): Promise<{ event: CalendarEvent; added: string[] }> {
    requireScope(CALENDAR_OPERATIONS.invite, this.#deps.grantedScopes);
    requireApproval(CALENDAR_OPERATIONS.invite, proof, (this.#deps.now ?? (() => new Date()))());
    const calendar = encodeURIComponent(input.calendarId ?? 'primary');
    const raw = await this.#findMeeting(calendar, input, signal);
    const have = new Set((raw.attendees ?? []).map((a) => (a.email ?? '').toLowerCase()));
    const added = [...new Set(input.emails.map((e) => e.trim().toLowerCase()))].filter(
      (e) => e && !have.has(e),
    );
    if (added.length === 0) return { event: toEvent(raw), added };
    // attendees は丸ごと置き換わるので、今の顔ぶれ（返事の状態も）をそのまま残して足す
    const path = `${BASE}/calendars/${calendar}/events/${encodeURIComponent(raw.id ?? '')}?sendUpdates=all`;
    const patched = await callJson<RawEvent>(
      path,
      {
        method: 'PATCH',
        body: { attendees: [...(raw.attendees ?? []), ...added.map((email) => ({ email }))] },
      },
      this.#deps,
      signal,
    );
    return { event: toEvent(patched), added };
  }

  async #findMeeting(
    calendar: string,
    input: InviteInput,
    signal?: AbortSignal,
  ): Promise<RawEvent> {
    const live = (items: RawEvent[] | undefined) =>
      (items ?? []).filter((e) => e.id && e.status !== 'cancelled');
    if (input.meetRequestId) {
      const params = new URLSearchParams({
        privateExtendedProperty: `${MEET_REQUEST_PROPERTY}=${input.meetRequestId}`,
        singleEvents: 'true',
        maxResults: '5',
      });
      const marked = live(
        (
          await callJson<{ items?: RawEvent[] }>(
            `${BASE}/calendars/${calendar}/events?${params.toString()}`,
            { method: 'GET' },
            this.#deps,
            signal,
          )
        ).items,
      );
      if (marked[0]) return marked[0];
    }
    // 目印の無い会議: 開始・終了・題名がぴったり合うもの。1 つに決まらなければ足さない（違う予定に招待しない）
    const params = new URLSearchParams({
      timeMin: input.start,
      timeMax: input.end,
      singleEvents: 'true',
      maxResults: '50',
    });
    const same = (a: string | undefined, b: string) =>
      a !== undefined && Date.parse(a) === Date.parse(b);
    const matches = live(
      (
        await callJson<{ items?: RawEvent[] }>(
          `${BASE}/calendars/${calendar}/events?${params.toString()}`,
          { method: 'GET' },
          this.#deps,
          signal,
        )
      ).items,
    ).filter(
      (e) =>
        (e.summary ?? '') === input.title &&
        same(e.start?.dateTime, input.start) &&
        same(e.end?.dateTime, input.end),
    );
    if (matches.length === 1) return matches[0]!;
    throw new ConnectorError(
      'provider_error',
      matches.length === 0
        ? 'the meeting was not found on the calendar'
        : 'several events match the meeting; not inviting to avoid the wrong one',
    );
  }
}
