/**
 * 予定を読む（calendar.agenda）・予定の時間を変える（calendar.move）。仕様 v1.0 §11。
 *
 *   「明日の予定教えて」→ calendar.agenda（READ・端末の Google カレンダー）→ 予定の一覧（JSON。読み上げる文つき）
 *   「午後にずらして」  → calendar.move（EXTERNAL_COMMIT・承認つき）→ 変更前と変更後
 *   「元に戻して」      → calendar.move（前後を入れ替えたもの。これも承認つき）
 *   グループの「@Genie 明日15時から30分 打ち合わせ Meetで」
 *                       → calendar.meeting（EXTERNAL_COMMIT・持ち主の 1:1 で承認）→ Meet 付きの予定。
 *                         Meet のリンクはグループへ返す（services/channels）
 *
 * 答えの文は端末が返した事実から作る。モデルに「変更しました」と言わせない（仕様 v1.0 §5⑤）。
 * 一覧の JSON は、次の「それ」「打ち合わせ」を解くのに使う（conversation の calendar-intent）。
 */
import { UnknownTaskKindError, type TaskPlan } from './plan.js';

export const AGENDA_MIME = 'application/vnd.genie.agenda+json';
export const AGENDA_SCHEMA = 'genie.agenda/v1';

/** 一覧に残す予定（次の頼みで指せるだけの最小限）。 */
export interface AgendaEvent {
  readonly id: string;
  readonly title: string;
  /** 時刻つきは ISO の日時、終日は YYYY-MM-DD。 */
  readonly start: string;
  readonly end: string;
  readonly allDay: boolean;
}

export interface AgendaCard {
  readonly schema: typeof AGENDA_SCHEMA;
  /** 読み上げ・チャットに出す文。 */
  readonly text: string;
  readonly label: string;
  readonly events: readonly AgendaEvent[];
}

const str = (input: Record<string, unknown>, key: string): string => {
  const value = input[key];
  if (typeof value !== 'string' || !value.trim())
    throw new UnknownTaskKindError(`calendar needs ${key}`);
  return value;
};

export function planCalendarAgenda(input: Record<string, unknown>): TaskPlan {
  const label = typeof input['label'] === 'string' ? input['label'] : 'この期間';
  return {
    steps: [
      {
        index: 0,
        toolId: 'calendar.list_events',
        risk: 'READ',
        surface: 'local',
        message: `${label}の予定を確認しています`,
        args: { time_min: str(input, 'time_min'), time_max: str(input, 'time_max') },
      },
    ],
    artifact: { type: 'OTHER', title: `${label}の予定`, mimeType: AGENDA_MIME },
  };
}

export function planCalendarMove(input: Record<string, unknown>): TaskPlan {
  const title =
    typeof input['title'] === 'string' && input['title'] ? input['title'] : '（題名なし）';
  const before = str(input, 'before_label');
  const after = str(input, 'after_label');
  return {
    steps: [
      {
        index: 0,
        toolId: 'calendar.move_event',
        risk: 'EXTERNAL_COMMIT',
        surface: 'local',
        requiresConfirmation: true,
        // 承認カードの見出し。何がどう変わるかを、ここだけで分かるように書く
        message: `予定「${title}」を ${before} → ${after} に変更します`,
        args: {
          event_id: str(input, 'event_id'),
          start: str(input, 'after_start'),
          end: str(input, 'after_end'),
          ...(typeof input['time_zone'] === 'string' ? { time_zone: input['time_zone'] } : {}),
          変更前: before,
          変更後: after,
        },
      },
    ],
    artifact: { type: 'DOCUMENT', title: `予定の変更: ${title}`, mimeType: 'text/markdown' },
  };
}

/**
 * グループで頼まれた会議を、持ち主のカレンダーに Meet 付きで入れる。承認カードには
 * 頼まれたグループ・題名・日時を出す（持ち主が知らないうちに予定を入れない）。
 */
export function planCalendarMeeting(input: Record<string, unknown>): TaskPlan {
  const title = str(input, 'title');
  const when = str(input, 'when_label');
  const from =
    typeof input['group_name'] === 'string' && input['group_name']
      ? `グループ「${input['group_name']}」`
      : 'グループ';
  const asker =
    typeof input['requested_by'] === 'string' && input['requested_by']
      ? `${input['requested_by']}さん`
      : null;
  return {
    steps: [
      {
        index: 0,
        toolId: 'calendar.create_event',
        risk: 'EXTERNAL_COMMIT',
        surface: 'local',
        requiresConfirmation: true,
        message: `${from}${asker ? `の${asker}` : ''}から: 予定「${title}」（${when}）を Google Meet 付きでカレンダーに入れます`,
        args: {
          title,
          start: str(input, 'start'),
          end: str(input, 'end'),
          meet: true,
          ...(typeof input['meet_request_id'] === 'string'
            ? { meet_request_id: input['meet_request_id'] }
            : {}),
          日時: when,
          頼まれた場所: from,
          ...(asker ? { 頼んだ人: asker } : {}),
        },
      },
    ],
    artifact: { type: 'DOCUMENT', title: `会議: ${title}`, mimeType: 'text/markdown' },
  };
}

interface RawEvent {
  readonly id?: unknown;
  readonly title?: unknown;
  readonly status?: unknown;
  readonly start?: { dateTime?: unknown; date?: unknown };
  readonly end?: { dateTime?: unknown; date?: unknown };
}

const toAgendaEvent = (raw: RawEvent): AgendaEvent | null => {
  if (typeof raw.id !== 'string' || raw.status === 'cancelled') return null;
  const allDay = typeof raw.start?.date === 'string' && raw.start?.dateTime == null;
  const start = allDay ? raw.start?.date : raw.start?.dateTime;
  const end = allDay ? raw.end?.date : raw.end?.dateTime;
  if (typeof start !== 'string' || typeof end !== 'string') return null;
  return { id: raw.id, title: typeof raw.title === 'string' ? raw.title : '', start, end, allDay };
};

/** 時刻の見せ方（本人の時間帯）。 */
export function clock(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat('ja-JP', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(iso));
}

export function agendaText(
  label: string,
  events: readonly AgendaEvent[],
  timeZone: string,
): string {
  if (events.length === 0) return `${label}の予定はありません。`;
  const lines = events.map((e) =>
    e.allDay
      ? `・終日 ${e.title || '（題名なし）'}`
      : `・${clock(e.start, timeZone)}〜${clock(e.end, timeZone)} ${e.title || '（題名なし）'}`,
  );
  return [`${label}の予定は ${String(events.length)} 件です。`, ...lines].join('\n');
}

/** 端末が返した事実から、成果物の本文を作る。予定のことでなければ null。 */
export function formatCalendarArtifact(
  kind: string,
  input: Record<string, unknown>,
  results: readonly unknown[],
): { title: string; markdown: string } | null {
  const timeZone = typeof input['time_zone'] === 'string' ? input['time_zone'] : 'Asia/Tokyo';
  if (kind === 'calendar.agenda') {
    const label = typeof input['label'] === 'string' ? input['label'] : 'この期間';
    const raw = Array.isArray(results[0]) ? (results[0] as RawEvent[]) : [];
    const events = raw.map(toAgendaEvent).filter((e): e is AgendaEvent => e !== null);
    const card: AgendaCard = {
      schema: AGENDA_SCHEMA,
      text: agendaText(label, events, timeZone),
      label,
      events,
    };
    return { title: `${label}の予定`, markdown: JSON.stringify(card) };
  }
  if (kind === 'calendar.move') {
    const moved = results[0] as { before?: RawEvent; after?: RawEvent } | undefined;
    const after = moved?.after ? toAgendaEvent(moved.after) : null;
    if (!after) throw new Error('予定を変えた結果が端末から返っていません');
    const title = after.title || '（題名なし）';
    const when = after.allDay
      ? after.start
      : `${clock(after.start, timeZone)}〜${clock(after.end, timeZone)}`;
    return {
      title: `予定の変更: ${title}`,
      markdown: `予定「${title}」を ${when} に変更しました。元に戻すときは「元に戻して」と送ってください。`,
    };
  }
  if (kind === 'calendar.meeting') {
    const made = results[0] as { title?: unknown; conferenceUri?: unknown } | undefined;
    const title = typeof input['title'] === 'string' ? input['title'] : '（題名なし）';
    const when = typeof input['when_label'] === 'string' ? input['when_label'] : '';
    if (!made || typeof made !== 'object')
      throw new Error('予定を作った結果が端末から返っていません');
    const meet = typeof made.conferenceUri === 'string' ? made.conferenceUri : null;
    return {
      title: `会議: ${title}`,
      markdown: meet
        ? `予定「${title}」（${when}）をカレンダーに入れました。\nGoogle Meet: ${meet}`
        : `予定「${title}」（${when}）をカレンダーに入れましたが、Google Meet のリンクは付きませんでした。`,
    };
  }
  return null;
}
