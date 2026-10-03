/**
 * Conversation Engine。正本 §7。
 *
 * 設計の要:
 *   - **Lane は利用者に見せない**（§7.4）。モードを選ばせないのが §2 の前提
 *   - **解決できない指示語を埋めない**（D-49）。埋めると別のものに対して動く
 *   - 打ち切っても、出した文字は消さない（D-50）
 */
import { z } from 'zod';
import { ArtifactId, ConversationId, MeetingId, TaskId, TenantId, UserId } from './ids.js';
import { Timestamp } from './primitives.js';

/** 正本 §7.4 の内部 Lane。**画面には出さない。** */
export const LANES = [
  'chat',
  'dictate',
  'edit',
  'research',
  'action',
  'meeting',
  'specialist-agent',
] as const;
export const Lane = z.enum(LANES);
export type Lane = z.infer<typeof Lane>;

export const Modality = z.enum(['text', 'voice', 'mixed']);
export type Modality = z.infer<typeof Modality>;

/**
 * 「それ」「2番」の解決先。
 *
 * 何を指し得るかは限られているので、型で閉じておく。
 * 開いておくと、解決に失敗したときに何でも入れられてしまう。
 */
export const Referent = z.object({
  /** 会話に出てきた順。新しいほど小さい（0 が直近）。 */
  index: z.number().int().nonnegative(),
  label: z.string().min(1).max(200),
  target: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('task'), task_id: TaskId }),
    z.object({ kind: z.literal('artifact'), artifact_id: ArtifactId }),
    z.object({ kind: z.literal('meeting'), meeting_id: MeetingId }),
    z.object({ kind: z.literal('entity'), entity_id: z.uuid() }),
  ]),
});
export type Referent = z.infer<typeof Referent>;

/** 正本 §7.3 の ConversationState。 */
export const ConversationState = z.object({
  id: ConversationId,
  tenant_id: TenantId,
  active_topic: z.string().max(200).nullable(),
  active_project: z.string().max(200).nullable(),
  active_person: z.string().max(200).nullable(),
  active_artifact: ArtifactId.nullable(),
  active_task: TaskId.nullable(),
  active_meeting: MeetingId.nullable(),
  /** 直近で触れたもの。0 が最新。 */
  referents: z.array(Referent).max(20),
  pending_approvals: z.array(z.uuid()),
  response_mode: Modality,
  updated_at: Timestamp,
});
export type ConversationState = z.infer<typeof ConversationState>;

export const Turn = z.object({
  id: z.uuid(),
  conversation_id: ConversationId,
  role: z.enum(['user', 'assistant', 'system']),
  modality: Modality,
  text: z.string(),
  /** 打ち切られた応答。**出した分は消さない**（D-50）。 */
  interrupted: z.boolean().default(false),
  created_at: Timestamp,
});
export type Turn = z.infer<typeof Turn>;

/**
 * 発話に添えた、端末にある画像（スクショ / クリップボード画像）。
 *
 * **画素はここを通らない。**cloud が持つのは id とラベルだけで、
 * 実体は端末の受け渡し場所（`visual-context/<id>.png`）にあり、
 * 端末で走るモデル呼び出しがそこから読む（鍵も画像も端末から出さない）。
 * 撮っただけでは送られない。利用者が「これ何？」と尋ねた turn にだけ付く。
 */
export const TurnAttachment = z
  .object({
    /** 端末側の受け渡しファイル名になる。パス区切りを含めない。 */
    id: z.string().regex(/^[A-Za-z0-9-]{1,64}$/),
    kind: z.enum(['screenshot', 'clipboard_image']),
    /** 「スクリーンショット（たった今）」など。指示語の解決と提示に使う。 */
    label: z.string().min(1).max(200),
  })
  // **画素を受け取らない。**data / bytes / url など、この 3 つ以外の項目が来たら 400（黙って捨てない）。
  .strict();
export type TurnAttachment = z.infer<typeof TurnAttachment>;

export const SendTurnRequest = z.object({
  /** Persist before submitting. Receipt lookup never resubmits the request. */
  request_id: z.uuid().optional(),
  text: z.string().min(1).max(8_000),
  modality: Modality.default('text'),
  /** 直前の応答を打ち切るか。voice の barge-in はこれ（§7.2）。 */
  interrupt: z.boolean().default(true),
  /** この turn に添えた端末内の画像。新しい順。 */
  attachments: z.array(TurnAttachment).max(3).default([]),
  /**
   * いま見ているもの。正本 §6「ユーザーに説明し直させない」。
   *
   * 「この会社」は会話に出ていなくても、画面に出ていれば解ける。
   * **文脈からの指示先も、会話からのそれと同じに扱う。**
   * ここが無いと、初回の一言目で必ず聞き返すことになる。
   */
  context_referents: z
    .array(z.object({ label: z.string().min(1).max(200), kind: z.string().max(40) }))
    .max(10)
    .default([]),
  /**
   * 「これ返して」の候補。端末が決めた順（開いているメール → 選択 → 前面の窓）。
   * 形は `@genie/contracts` の `ReplyCandidate`。cloud はこの順で解決し、曖昧なら選ばない。
   */
  reply_candidates: z
    .array(
      z.object({
        kind: z.enum(['mail', 'selection', 'screenshot', 'frontmost']),
        label: z.string().min(1).max(300),
        app: z.string().max(100).nullable().default(null),
      }),
    )
    .max(6)
    .default([]),
});
export type SendTurnRequest = z.infer<typeof SendTurnRequest>;

// -------------------------------------------------------------- resolution

/**
 * 指示語の解決結果。
 *
 * **解決できなかったことを、解決できたことと混ぜない**（AC7-5）。
 * `resolved: null` は「何も指していない」ではなく「まだ分からない」。
 */
export const ReferenceResolution = z.object({
  /** 入力に出てきた指示語。 */
  phrase: z.string(),
  resolved: Referent.nullable(),
  /** 解決できなかった理由。聞き返す文面の材料になる。 */
  reason: z.string().nullable(),
});
export type ReferenceResolution = z.infer<typeof ReferenceResolution>;

/** 直近 N turn 以外は要約に畳む（§7.2）。 */
export const RECENT_TURN_WINDOW = 12;

/** 要約に畳む単位。小さすぎると要約だらけになる。 */
export const COMPACTION_BATCH = 8;

export const ConversationSummary = z.object({
  conversation_id: ConversationId,
  /** 畳んだ turn の範囲。**捨てたのではなく畳んだ**ことが分かるように残す。 */
  covers_from: z.uuid(),
  covers_to: z.uuid(),
  turn_count: z.number().int().positive(),
  summary: z.string().min(1),
  created_at: Timestamp,
});
export type ConversationSummary = z.infer<typeof ConversationSummary>;

export const StartConversationRequest = z.object({
  title: z.string().max(200).optional(),
  response_mode: Modality.default('text'),
});
export type StartConversationRequest = z.infer<typeof StartConversationRequest>;

export const ConversationView = z.object({
  id: ConversationId,
  title: z.string().nullable(),
  created_by: UserId,
  state: ConversationState,
  turns: z.array(Turn),
  summaries: z.array(ConversationSummary),
});
export type ConversationView = z.infer<typeof ConversationView>;
