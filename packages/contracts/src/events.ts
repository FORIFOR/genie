/**
 * Realtime event contract。正本 §20、実装仕様 §3.2 / §7。
 *
 * 逸脱 D-03: 正本の封筒に `stream_kind` / `stream_id` / `tenant_id` を追加する。
 *   再接続時の再送は「どの列の何番以降か」が分からなければ実装できず、
 *   task_id の有無から列を推測する実装は meeting / conversation が増えた時点で破綻するため。
 * 逸脱 D-03b: `task.cancelled` を追加（正本 §24 が cancellation を必須にしているため）。
 */
import { z } from 'zod';
import {
  ApprovalId,
  ArtifactId,
  ConversationId,
  EventId,
  TaskId,
  TenantId,
  TurnId,
} from './ids.js';
import { Timestamp } from './primitives.js';
import { ActionRisk } from './approval.js';
import { ArtifactType } from './artifact.js';
import { TaskError } from './task.js';

export const StreamKind = z.enum(['task', 'conversation', 'meeting']);
export type StreamKind = z.infer<typeof StreamKind>;

export const EVENT_TYPES = [
  // --- Phase 0 で発火する ---
  'task.started',
  'task.progress',
  'task.waiting_approval',
  'task.completed',
  'task.failed',
  'task.cancelled',
  /*
   * 端末が落ちて止まった / 戻って動き出した。正本 §4.4。
   *
   * **失敗と別に持つ。**待てば戻るものを task.failed で伝えると、
   * 画面は「失敗しました」と出し、利用者は終わったものとして扱う。
   */
  'task.paused',
  'task.resumed',
  'tool.started',
  'tool.completed',
  'artifact.created',
  // --- Phase 1 ---
  'conversation.delta',
  'conversation.completed',
  // --- Phase 2 ---
  'research.source_found',
  'research.evidence_added',
  // --- Phase 3 ---
  'meeting.transcript.partial',
  'meeting.transcript.final',
  'meeting.translation.final',
  'meeting.ended',
] as const;

export const EventType = z.enum(EVENT_TYPES);
export type EventType = z.infer<typeof EventType>;

/** Phase 0 で実際に発火する型。受信側は全型を扱えるが、発火側はこれだけ。 */
export const PHASE0_EVENT_TYPES = [
  'task.started',
  'task.progress',
  'task.waiting_approval',
  'task.completed',
  'task.failed',
  'task.cancelled',
  'tool.started',
  'tool.completed',
  'artifact.created',
] as const satisfies readonly EventType[];

// ---------------------------------------------------------------- payloads

/** 正本 §4.3 の THINKING / RESEARCHING / ACTING に対応する内部 phase。 */
export const ProgressPhase = z.enum(['thinking', 'researching', 'acting']);
export type ProgressPhase = z.infer<typeof ProgressPhase>;

export const TaskStartedPayload = z.object({
  kind: z.string(),
  title: z.string().nullable(),
  step_count: z.number().int().nonnegative().nullable(),
});

export const TaskProgressPayload = z.object({
  phase: ProgressPhase,
  step_index: z.number().int().nonnegative().nullable(),
  /**
   * 全体の段数。UI/UX §6.2「進捗率は真の進行率を計算できる Task のみ表示」。
   * 段数が事前に決まらない処理（Research 等）は null にして、%表示させない。
   */
  step_count: z.number().int().nonnegative().nullable(),
  /** ユーザーに見せる自然文（正本 §7.2「tool progress naturalization」）。tool 名を出さない。 */
  message: z.string().max(200),
  /**
   * 進行の実感を出す補助表示。UI/UX §6.1 の「12 sources」に相当。
   * 段数が不明な処理では、これと経過時間が唯一の手掛かりになる。
   */
  detail: z.string().max(60).nullable().default(null),
  elapsed_ms: z.number().int().nonnegative().nullable().default(null),
  /** 再試行中か。UI/UX §6.2「失敗 step は赤く固定せず、retry 中なら『再試行中』に置き換える」。 */
  retrying: z.boolean().default(false),
});

export const TaskWaitingApprovalPayload = z.object({
  approval_id: ApprovalId,
  risk: ActionRisk,
  summary: z.string().max(200),
  /** 主ボタンの文言。UI/UX §14.1「Primary button は結果を書く」。 */
  primary_action_label: z.string().max(40),
  expires_at: Timestamp,
});

export const TaskCompletedPayload = z.object({
  result_artifact_id: ArtifactId.nullable(),
  duration_ms: z.number().int().nonnegative(),
});

export const TaskFailedPayload = z.object({ error: TaskError });

export const TaskCancelledPayload = z.object({
  reason: z.string().max(500),
  /** Stopping Genie does not confirm cancellation of an external order. */
  message: z.string().optional(),
  error: TaskError.optional(),
});

/** なぜ止まっているか。**今は端末の不在だけ。**増やすときはここに足す。 */
export const PauseReasonCode = z.enum(['host_offline']);
export type PauseReasonCode = z.infer<typeof PauseReasonCode>;

export const TaskPausedPayload = z.object({
  reason: PauseReasonCode,
  step_index: z.number().int().nonnegative().nullable(),
  /** 画面に出す一言。**「失敗」と読める言葉を入れない。** */
  message: z.string().max(200),
});

export const TaskResumedPayload = z.object({
  step_index: z.number().int().nonnegative().nullable(),
  /** 止まっていた時間。どれだけ待たせたかを隠さない。 */
  paused_ms: z.number().int().nonnegative().nullable().default(null),
});

export const ToolStartedPayload = z.object({
  step_index: z.number().int().nonnegative(),
  tool_id: z.string(),
  risk: ActionRisk,
  surface: z.enum(['local', 'cloud']),
});

export const ToolCompletedPayload = z.object({
  step_index: z.number().int().nonnegative(),
  tool_id: z.string(),
  ok: z.boolean(),
  receipt_id: z.uuid().nullable(),
  duration_ms: z.number().int().nonnegative(),
});

export const ArtifactCreatedPayload = z.object({
  artifact_id: ArtifactId,
  type: ArtifactType,
  title: z.string(),
  size: z.number().int().nonnegative(),
});

export const ConversationDeltaPayload = z.object({
  turn_id: TurnId,
  text_delta: z.string(),
});

export const ConversationCompletedPayload = z.object({
  turn_id: TurnId,
  finish_reason: z.enum(['stop', 'cancelled', 'error', 'barge_in']),
});

export const ResearchSourceFoundPayload = z.object({
  run_id: z.uuid(),
  url: z.url(),
  publisher: z.string().nullable(),
  quality_score: z.number().min(0).max(1),
});

export const ResearchEvidenceAddedPayload = z.object({
  run_id: z.uuid(),
  evidence_id: z.uuid(),
  claim: z.string(),
});

export const MeetingTranscriptPayload = z.object({
  segment_id: z.string(),
  speaker_tag: z.number().int().positive().nullable(),
  text: z.string(),
  start_ms: z.number().int().nonnegative(),
  end_ms: z.number().int().nonnegative(),
  language: z.string().nullable(),
});

/**
 * 会議の終わり。**この列の終端**なので、SSE はこれを送ったら閉じる。
 * 終端が無いと、終わった会議の購読が永久に開いたままになる。
 */
export const MeetingEndedPayload = z.object({
  status: z.enum(['COMPLETE', 'FAILED']),
  /** finalize を回している task。閉じたあとの続きはここで追える。 */
  finalize_task_id: z.string().nullable(),
});

export const MeetingTranslationPayload = z.object({
  segment_id: z.string(),
  target_language: z.string(),
  text: z.string(),
});

// ---------------------------------------------------------------- envelope

const envelopeBase = {
  event_id: EventId,
  timestamp: Timestamp,
  tenant_id: TenantId,
  stream_kind: StreamKind,
  stream_id: z.uuid(),
  /** stream 内で 1 始まり・欠番なし・単調増加（実装仕様 §7.2）。 */
  sequence: z.number().int().positive(),
  conversation_id: ConversationId.optional(),
  task_id: TaskId.optional(),
};

const evt = <T extends EventType, P extends z.ZodTypeAny>(type: T, payload: P) =>
  z.object({ ...envelopeBase, type: z.literal(type), payload });

export const TaskStartedEvent = evt('task.started', TaskStartedPayload);
export const TaskProgressEvent = evt('task.progress', TaskProgressPayload);
export const TaskWaitingApprovalEvent = evt('task.waiting_approval', TaskWaitingApprovalPayload);
export const TaskCompletedEvent = evt('task.completed', TaskCompletedPayload);
export const TaskFailedEvent = evt('task.failed', TaskFailedPayload);
export const TaskCancelledEvent = evt('task.cancelled', TaskCancelledPayload);
export const TaskPausedEvent = evt('task.paused', TaskPausedPayload);
export const TaskResumedEvent = evt('task.resumed', TaskResumedPayload);
export const ToolStartedEvent = evt('tool.started', ToolStartedPayload);
export const ToolCompletedEvent = evt('tool.completed', ToolCompletedPayload);
export const ArtifactCreatedEvent = evt('artifact.created', ArtifactCreatedPayload);
export const ConversationDeltaEvent = evt('conversation.delta', ConversationDeltaPayload);
export const ConversationCompletedEvent = evt(
  'conversation.completed',
  ConversationCompletedPayload,
);
export const ResearchSourceFoundEvent = evt('research.source_found', ResearchSourceFoundPayload);
export const ResearchEvidenceAddedEvent = evt(
  'research.evidence_added',
  ResearchEvidenceAddedPayload,
);
export const MeetingTranscriptPartialEvent = evt(
  'meeting.transcript.partial',
  MeetingTranscriptPayload,
);
export const MeetingTranscriptFinalEvent = evt(
  'meeting.transcript.final',
  MeetingTranscriptPayload,
);
export const MeetingTranslationFinalEvent = evt(
  'meeting.translation.final',
  MeetingTranslationPayload,
);
export const MeetingEndedEvent = evt('meeting.ended', MeetingEndedPayload);

export const EventEnvelope = z.discriminatedUnion('type', [
  TaskStartedEvent,
  TaskProgressEvent,
  TaskWaitingApprovalEvent,
  TaskCompletedEvent,
  TaskFailedEvent,
  TaskCancelledEvent,
  TaskPausedEvent,
  TaskResumedEvent,
  ToolStartedEvent,
  ToolCompletedEvent,
  ArtifactCreatedEvent,
  ConversationDeltaEvent,
  ConversationCompletedEvent,
  ResearchSourceFoundEvent,
  ResearchEvidenceAddedEvent,
  MeetingTranscriptPartialEvent,
  MeetingTranscriptFinalEvent,
  MeetingTranslationFinalEvent,
  MeetingEndedEvent,
]);
export type EventEnvelope = z.infer<typeof EventEnvelope>;

/**
 * 未知の type を持つ封筒。実装仕様 §3.8:
 * 受信側は未知イベントを**捨てない**。sequence だけ進めて無視する
 * （捨てると欠番検知が壊れるため）。
 */
export const UnknownEventEnvelope = z.object({
  ...envelopeBase,
  type: z.string(),
  payload: z.unknown(),
});
export type UnknownEventEnvelope = z.infer<typeof UnknownEventEnvelope>;

export type DecodedEvent =
  { known: true; event: EventEnvelope } | { known: false; event: UnknownEventEnvelope };

/** SSE フレームの data を封筒として解釈する。未知 type は known:false で返す。 */
export function decodeEvent(raw: unknown): DecodedEvent {
  const known = EventEnvelope.safeParse(raw);
  if (known.success) return { known: true, event: known.data };
  return { known: false, event: UnknownEventEnvelope.parse(raw) };
}

/**
 * 欠番検知。正本 §20 の sequence 契約はクライアントの取りこぼし検知に使うので緩めない。
 * `expected` は「次に来るべき番号」。戻り値が false なら再接続する。
 */
export function isContiguous(expected: number, received: number): boolean {
  return received === expected;
}

/** SSE の 1 フレームを組み立てる。id には sequence を入れる（Last-Event-ID で再開する）。 */
export function toSseFrame(event: EventEnvelope | UnknownEventEnvelope): string {
  return `id: ${event.sequence}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

export const SSE_HEARTBEAT_INTERVAL_MS = 15_000;
export const SSE_HEARTBEAT_FRAME = ': ping\n\n';
