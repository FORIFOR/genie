/**
 * Microsoft Graph（Outlook Mail / Outlook Calendar / To Do）。正本 §2.4・§21、Work Context 仕様。
 *
 * **読むだけ。**Work Context は読めれば成り立つ。送る・動かす・作るは
 * 別の許可（`email.send` / `calendar.write`）で、ここには入れない。
 * 入れないので、承認の跡が無いまま外へ出る経路がそもそも無い。
 *
 * connector 層は判断しない。Graph が返したものを Genie の形に写すだけで、
 * 「これは依頼か」「急ぎか」は上の層（normalize / Work Graph / 端末の LLM）が決める。
 */
import { callJson, ConnectorError, type CallConfig } from './http.js';
import {
  requireApproval,
  requireScope,
  type ApprovalProof,
  type OperationDecl,
} from './approval.js';

const BASE = 'https://graph.microsoft.com/v1.0';

export const MICROSOFT_OPERATIONS = {
  mailList: {
    id: 'outlook.mail.list',
    scope: 'email.read',
    risk: 'READ',
    requiresApproval: false,
  },
  mailGet: { id: 'outlook.mail.get', scope: 'email.read', risk: 'READ', requiresApproval: false },
  calendarList: {
    id: 'outlook.calendar.list',
    scope: 'calendar.read',
    risk: 'READ',
    requiresApproval: false,
  },
  todoList: { id: 'todo.list', scope: 'tasks.read', risk: 'READ', requiresApproval: false },
  /**
   * 既存のメッセージへの返信（`POST /me/messages/{id}/reply`）。delegated の `Mail.Send` だけで足りる
   * （`createReply` は `Mail.ReadWrite` が要るので使わない）。外へ出るので人の承認が要る。
   */
  mailReply: {
    id: 'outlook.mail.reply',
    scope: 'email.send',
    risk: 'EXTERNAL_COMMIT',
    requiresApproval: true,
  },
} as const satisfies Record<string, OperationDecl>;

// ------------------------------------------------------------------ mail

export interface OutlookRecipient {
  readonly name: string;
  readonly address: string;
}

export interface OutlookMailSummary {
  readonly id: string;
  readonly conversationId: string;
  readonly from: OutlookRecipient | null;
  readonly to: readonly OutlookRecipient[];
  readonly cc: readonly OutlookRecipient[];
  readonly subject: string;
  /** Graph の bodyPreview。**本文ではない**（先頭 255 字まで）。 */
  readonly preview: string;
  readonly receivedAt: string | null;
  readonly sentAt: string | null;
  readonly unread: boolean;
  readonly hasAttachments: boolean;
  readonly webLink: string | null;
  /** 自分が出したものか（`sentitems` から来たか）。 */
  readonly folder: 'inbox' | 'sentitems' | 'other';
  readonly importance?: string | null;
  readonly isDraft?: boolean;
  readonly listUnsubscribe?: boolean;
  readonly autoSubmitted?: string | null;
  readonly precedence?: string | null;
  readonly inReplyTo?: string | null;
}

interface RawRecipient {
  emailAddress?: { name?: string; address?: string };
}

interface RawMessage {
  id?: string;
  conversationId?: string;
  from?: RawRecipient;
  toRecipients?: RawRecipient[];
  ccRecipients?: RawRecipient[];
  subject?: string;
  bodyPreview?: string;
  receivedDateTime?: string;
  sentDateTime?: string;
  isRead?: boolean;
  hasAttachments?: boolean;
  webLink?: string;
  body?: { contentType?: string; content?: string };
  importance?: string;
  isDraft?: boolean;
  internetMessageHeaders?: { name?: string; value?: string }[];
}

function recipient(raw: RawRecipient | undefined): OutlookRecipient | null {
  const address = raw?.emailAddress?.address ?? '';
  const name = raw?.emailAddress?.name ?? '';
  if (!address && !name) return null;
  return { name: name || address, address };
}

function recipients(raw: RawRecipient[] | undefined): OutlookRecipient[] {
  return (raw ?? []).map(recipient).filter((r): r is OutlookRecipient => r !== null);
}

function toMailSummary(raw: RawMessage, folder: OutlookMailSummary['folder']): OutlookMailSummary {
  const header = (name: string) =>
    raw.internetMessageHeaders?.find((item) => item.name?.toLowerCase() === name)?.value;
  return {
    id: raw.id ?? '',
    conversationId: raw.conversationId ?? '',
    from: recipient(raw.from),
    to: recipients(raw.toRecipients),
    cc: recipients(raw.ccRecipients),
    subject: raw.subject ?? '',
    preview: raw.bodyPreview ?? '',
    receivedAt: raw.receivedDateTime ?? null,
    sentAt: raw.sentDateTime ?? null,
    unread: raw.isRead === false,
    hasAttachments: raw.hasAttachments === true,
    webLink: raw.webLink ?? null,
    folder,
    importance: raw.importance ?? null,
    isDraft: raw.isDraft === true,
    listUnsubscribe: Boolean(header('list-unsubscribe') || header('list-id')),
    autoSubmitted: header('auto-submitted') ?? null,
    precedence: header('precedence') ?? null,
    inReplyTo: header('in-reply-to') ?? null,
  };
}

export interface OutlookMailMessage extends OutlookMailSummary {
  readonly body: string;
  readonly bodyIsHtml: boolean;
}

/** 一覧で取る欄。**本文は取らない。**`bodyPreview` で足りる。 */
const MAIL_SELECT =
  'id,conversationId,from,toRecipients,ccRecipients,subject,bodyPreview,receivedDateTime,sentDateTime,isRead,hasAttachments,webLink';

export interface MicrosoftDeps extends CallConfig {
  /** 実際に許された scope。要求した scope ではない。 */
  readonly grantedScopes: readonly string[];
  readonly now?: () => Date;
}

export class OutlookMailConnector {
  readonly #deps: MicrosoftDeps;

  constructor(deps: MicrosoftDeps) {
    this.#deps = deps;
  }

  /**
   * 受信箱か送信済みの一覧。**本文は落とさない**（`$select` で bodyPreview まで）。
   * `since` があれば、それ以降に届いた（出した）ものだけ。
   */
  async list(
    input: {
      folder?: 'inbox' | 'sentitems';
      /** Request selection metadata only when the caller needs it. */
      selectionMetadata?: boolean;
      since?: string;
      maxResults?: number;
      query?: string;
    } = {},
    signal?: AbortSignal,
  ): Promise<OutlookMailSummary[]> {
    requireScope(MICROSOFT_OPERATIONS.mailList, this.#deps.grantedScopes);
    const folder = input.folder ?? 'inbox';
    const limit = Math.max(1, Math.min(Math.floor(input.maxResults ?? 25), 100));
    const params = new URLSearchParams({
      $select: input.selectionMetadata
        ? `${MAIL_SELECT},importance,isDraft,internetMessageHeaders`
        : MAIL_SELECT,
      $top: String(limit),
      $orderby: folder === 'sentitems' ? 'sentDateTime desc' : 'receivedDateTime desc',
    });
    if (input.since) {
      const field = folder === 'sentitems' ? 'sentDateTime' : 'receivedDateTime';
      params.set('$filter', `${field} ge ${input.since}`);
    }
    if (input.query) {
      // $search と $orderby は同時に使えない（Graph の制約）。探すときは並びを諦める。
      params.delete('$orderby');
      params.delete('$filter');
      params.set('$search', JSON.stringify(input.query));
    }
    const body = await callJson<{ value?: RawMessage[] }>(
      `${BASE}/me/mailFolders/${folder}/messages?${params.toString()}`,
      { method: 'GET' },
      this.#deps,
      signal,
    );
    return (body.value ?? []).slice(0, limit).map((raw) => toMailSummary(raw, folder));
  }

  /**
   * 返信を送る。**人の承認の跡が無ければ送らない。**本文は本人が確認カードで見た（直した）もの。
   * Graph は 202 を返し、Sent Items にも残る。
   */
  async reply(
    messageId: string,
    comment: string,
    proof: ApprovalProof | undefined,
    signal?: AbortSignal,
  ): Promise<{ accepted: true }> {
    requireScope(MICROSOFT_OPERATIONS.mailReply, this.#deps.grantedScopes);
    requireApproval(
      MICROSOFT_OPERATIONS.mailReply,
      proof,
      (this.#deps.now ?? (() => new Date()))(),
    );
    if (comment.trim().length === 0)
      throw new ConnectorError('provider_error', 'the reply is empty');
    await callJson<unknown>(
      `${BASE}/me/messages/${encodeURIComponent(messageId)}/reply`,
      { method: 'POST', body: { comment } },
      this.#deps,
      signal,
    );
    return { accepted: true };
  }

  async get(messageId: string, signal?: AbortSignal): Promise<OutlookMailMessage> {
    requireScope(MICROSOFT_OPERATIONS.mailGet, this.#deps.grantedScopes);
    const raw = await callJson<RawMessage>(
      `${BASE}/me/messages/${encodeURIComponent(messageId)}?$select=${MAIL_SELECT},body`,
      { method: 'GET' },
      this.#deps,
      signal,
    );
    return {
      ...toMailSummary(raw, 'other'),
      body: raw.body?.content ?? '',
      bodyIsHtml: raw.body?.contentType?.toLowerCase() === 'html',
    };
  }
}

// -------------------------------------------------------------- calendar

export interface OutlookAttendee {
  readonly name: string;
  readonly address: string;
  readonly responseStatus: 'accepted' | 'declined' | 'tentative' | 'needsAction';
  readonly type: 'required' | 'optional' | 'resource';
}

export interface OutlookEvent {
  readonly id: string;
  readonly title: string;
  /** Graph の bodyPreview。全文ではない。 */
  readonly preview: string;
  readonly location: string | null;
  /** ISO。**終日予定は日付だけ。** */
  readonly start: { dateTime: string | null; date: string | null; timeZone: string | null };
  readonly end: { dateTime: string | null; date: string | null; timeZone: string | null };
  readonly attendees: readonly OutlookAttendee[];
  readonly organizer: OutlookRecipient | null;
  readonly isOrganizer: boolean;
  readonly isCancelled: boolean;
  readonly webLink: string | null;
  readonly onlineMeetingUrl: string | null;
}

interface RawEvent {
  id?: string;
  subject?: string;
  bodyPreview?: string;
  location?: { displayName?: string };
  start?: { dateTime?: string; timeZone?: string };
  end?: { dateTime?: string; timeZone?: string };
  isAllDay?: boolean;
  isCancelled?: boolean;
  isOrganizer?: boolean;
  attendees?: {
    emailAddress?: { name?: string; address?: string };
    status?: { response?: string };
    type?: string;
  }[];
  organizer?: RawRecipient;
  webLink?: string;
  onlineMeeting?: { joinUrl?: string };
}

function normalizeResponse(value: string | undefined): OutlookAttendee['responseStatus'] {
  if (value === 'accepted' || value === 'organizer') return 'accepted';
  if (value === 'declined') return 'declined';
  if (value === 'tentativelyAccepted') return 'tentative';
  return 'needsAction';
}

/**
 * Graph の時刻は `2026-09-08T10:00:00.0000000` のように**時差が付かない**
 * （`Prefer: outlook.timezone` を出さない限り UTC）。ISO として読めるように `Z` を足す。
 */
function graphTime(raw: { dateTime?: string; timeZone?: string } | undefined): string | null {
  const value = raw?.dateTime;
  if (!value) return null;
  const trimmed = value.replace(/(\.\d{3})\d+$/, '$1');
  if (/[zZ]$|[+-]\d{2}:\d{2}$/.test(trimmed)) return trimmed;
  return (raw?.timeZone ?? 'UTC') === 'UTC' ? `${trimmed}Z` : trimmed;
}

function toOutlookEvent(raw: RawEvent): OutlookEvent {
  const allDay = raw.isAllDay === true;
  const when = (
    part: { dateTime?: string; timeZone?: string } | undefined,
  ): OutlookEvent['start'] => ({
    dateTime: allDay ? null : graphTime(part),
    date: allDay ? (part?.dateTime?.slice(0, 10) ?? null) : null,
    timeZone: part?.timeZone ?? null,
  });
  return {
    id: raw.id ?? '',
    title: raw.subject ?? '',
    preview: raw.bodyPreview ?? '',
    location: raw.location?.displayName || null,
    start: when(raw.start),
    end: when(raw.end),
    attendees: (raw.attendees ?? []).map((a) => ({
      name: a.emailAddress?.name ?? a.emailAddress?.address ?? '',
      address: a.emailAddress?.address ?? '',
      responseStatus: normalizeResponse(a.status?.response),
      type: a.type === 'optional' || a.type === 'resource' ? a.type : 'required',
    })),
    organizer: recipient(raw.organizer),
    isOrganizer: raw.isOrganizer === true,
    isCancelled: raw.isCancelled === true,
    webLink: raw.webLink ?? null,
    onlineMeetingUrl: raw.onlineMeeting?.joinUrl ?? null,
  };
}

const EVENT_SELECT =
  'id,subject,bodyPreview,location,start,end,isAllDay,isCancelled,isOrganizer,attendees,organizer,webLink,onlineMeeting';

export class OutlookCalendarConnector {
  readonly #deps: MicrosoftDeps;

  constructor(deps: MicrosoftDeps) {
    this.#deps = deps;
  }

  /** 期間内の予定。`calendarView` は繰り返しを展開して返す。 */
  async list(
    input: { timeMin: string; timeMax: string; maxResults?: number },
    signal?: AbortSignal,
  ): Promise<OutlookEvent[]> {
    requireScope(MICROSOFT_OPERATIONS.calendarList, this.#deps.grantedScopes);
    const params = new URLSearchParams({
      startDateTime: input.timeMin,
      endDateTime: input.timeMax,
      $select: EVENT_SELECT,
      $orderby: 'start/dateTime',
      $top: String(Math.min(input.maxResults ?? 50, 250)),
    });
    const body = await callJson<{ value?: RawEvent[] }>(
      `${BASE}/me/calendarView?${params.toString()}`,
      { method: 'GET' },
      this.#deps,
      signal,
    );
    return (body.value ?? []).map(toOutlookEvent);
  }
}

// ------------------------------------------------------------------ todo

export interface TodoTask {
  readonly id: string;
  readonly listId: string;
  readonly listName: string;
  readonly title: string;
  readonly preview: string;
  readonly status: 'notStarted' | 'inProgress' | 'completed' | 'waitingOnOthers' | 'deferred';
  readonly importance: 'low' | 'normal' | 'high';
  readonly dueAt: string | null;
  readonly createdAt: string | null;
  readonly lastModifiedAt: string | null;
  readonly completedAt: string | null;
}

interface RawTodoList {
  id?: string;
  displayName?: string;
}

interface RawTodoTask {
  id?: string;
  title?: string;
  body?: { content?: string };
  status?: string;
  importance?: string;
  dueDateTime?: { dateTime?: string; timeZone?: string };
  completedDateTime?: { dateTime?: string; timeZone?: string };
  createdDateTime?: string;
  lastModifiedDateTime?: string;
}

function todoStatus(value: string | undefined): TodoTask['status'] {
  switch (value) {
    case 'inProgress':
    case 'completed':
    case 'waitingOnOthers':
    case 'deferred':
      return value;
    default:
      return 'notStarted';
  }
}

export class MicrosoftTodoConnector {
  readonly #deps: MicrosoftDeps;

  constructor(deps: MicrosoftDeps) {
    this.#deps = deps;
  }

  /**
   * すべての一覧のタスク。**未完了だけ**を既定にする — 完了したものは
   * Work Context に要らないし、取れば取るほど手元に貯まる。
   */
  async list(
    input: { includeCompleted?: boolean; maxPerList?: number } = {},
    signal?: AbortSignal,
  ): Promise<TodoTask[]> {
    requireScope(MICROSOFT_OPERATIONS.todoList, this.#deps.grantedScopes);
    const lists = await callJson<{ value?: RawTodoList[] }>(
      `${BASE}/me/todo/lists`,
      { method: 'GET' },
      this.#deps,
      signal,
    );
    const out: TodoTask[] = [];
    for (const list of lists.value ?? []) {
      if (!list.id) continue;
      const params = new URLSearchParams({
        $top: String(Math.min(input.maxPerList ?? 50, 200)),
      });
      if (!input.includeCompleted) params.set('$filter', "status ne 'completed'");
      const tasks = await callJson<{ value?: RawTodoTask[] }>(
        `${BASE}/me/todo/lists/${encodeURIComponent(list.id)}/tasks?${params.toString()}`,
        { method: 'GET' },
        this.#deps,
        signal,
      );
      for (const raw of tasks.value ?? []) {
        out.push({
          id: raw.id ?? '',
          listId: list.id,
          listName: list.displayName ?? '',
          title: raw.title ?? '',
          preview: (raw.body?.content ?? '').slice(0, 500),
          status: todoStatus(raw.status),
          importance:
            raw.importance === 'high' || raw.importance === 'low' ? raw.importance : 'normal',
          dueAt: graphTime(raw.dueDateTime),
          createdAt: raw.createdDateTime ?? null,
          lastModifiedAt: raw.lastModifiedDateTime ?? null,
          completedAt: graphTime(raw.completedDateTime),
        });
      }
    }
    return out;
  }
}
