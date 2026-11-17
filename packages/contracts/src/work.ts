/**
 * Work Context / Personalization Layer。正本 §6（Context Engine）・§10（World Model）・Phase 6。
 *
 * 「何を質問されたかだけ知っている AI」ではなく、「その人が今何の仕事を抱え、誰を待ち、何を返さなければならず、
 * 今日どこに時間を使うべきかを**出所つきで**理解している AI」のための契約。
 *
 * 流れ: 各サービス → 正規化（WorkArtifact）→ Work Graph → 利用者に見せる → 確定した文脈だけを LLM に渡す。
 *
 * 守ること:
 *   - connector 層は判断しない（生データの取得だけ）
 *   - メール全文を cloud にも LLM にも渡さない。持つのは抜粋（<= 500 字）だけ
 *   - すべての推論に出所（Provenance）が付く。付かないものは出さない
 *   - 推測を事実として固定しない（observed / inferred / confirmed の 3 段）
 */
import { z } from 'zod';
import { Timestamp } from './primitives.js';

// ------------------------------------------------------------------ source

/** どのサービスから来たか。Google / Microsoft の差はここで消す。 */
export const WORK_SOURCES = [
  'gmail',
  'google_calendar',
  'google_tasks',
  'outlook_mail',
  'outlook_calendar',
  'microsoft_todo',
  'planner',
  'meeting',
  'screenshot',
  'file',
  'astra_task',
  'browser',
] as const;
export const WorkSource = z.enum(WORK_SOURCES);
export type WorkSource = z.infer<typeof WorkSource>;

export const WORK_ARTIFACT_KINDS = [
  'email',
  'calendar_event',
  'task',
  'meeting',
  'file',
  'message',
  'commitment',
  'decision',
  'action_item',
] as const;
export const WorkArtifactKind = z.enum(WORK_ARTIFACT_KINDS);
export type WorkArtifactKind = z.infer<typeof WorkArtifactKind>;

/** 出所。**すべての推論が最低 1 つ持つ**（D-43）。excerpt は抜粋であって全文ではない。 */
export const Provenance = z.object({
  source: WorkSource,
  /** 元サービスの id（Gmail の message id、Graph の id、meeting id …）。 */
  external_id: z.string().min(1).max(500),
  /** 人が読める見出し（「MTI からの返信」「MOPITA 定例」）。 */
  label: z.string().min(1).max(200),
  observed_at: Timestamp,
  url: z.string().url().nullable().default(null),
  excerpt: z.string().max(200).nullable().default(null),
});
export type Provenance = z.infer<typeof Provenance>;

export const PersonRef = z.object({
  name: z.string().min(1).max(200),
  email: z.string().max(320).nullable().default(null),
  role: z
    .enum(['from', 'to', 'cc', 'attendee', 'organizer', 'assignee', 'mentioned'])
    .default('mentioned'),
});
export type PersonRef = z.infer<typeof PersonRef>;

// ---------------------------------------------------------------- semantic

/** LLM（端末）または規則が付けた意味。**出所つき**、確度つき。 */
export const WORK_SEMANTIC_CATEGORIES = [
  'info',
  'question',
  'request_to_me',
  'request_to_other',
  'approval_pending',
  'scheduling',
  'other',
] as const;
export const WorkSemanticCategory = z.enum(WORK_SEMANTIC_CATEGORIES);
export type WorkSemanticCategory = z.infer<typeof WorkSemanticCategory>;

export const WorkSemantic = z.object({
  category: WorkSemanticCategory,
  project: z.string().max(200).nullable().default(null),
  /** 何を求められている / 求めているか（1 文）。 */
  request: z.string().max(300).nullable().default(null),
  owner: z.string().max(200).nullable().default(null),
  waiting_on: z.string().max(200).nullable().default(null),
  due: Timestamp.nullable().default(null),
  confidence: z.number().min(0).max(1),
  extracted_by: z.enum(['llm', 'rule']),
});
export type WorkSemantic = z.infer<typeof WorkSemantic>;

/**
 * 会議から Work Graph へ流す artifact の一次情報。MEETING_WORK_LOOP。
 *
 * どの会議の、どの発言（segment）から、誰が、いつ言ったか。文字起こし・音源の artifact へ辿れる。
 * `status` は 3 段: observed（記録から数えた）/ inferred（要約が取り出した）/ confirmed（本人が Live Notes で認めた）。
 */
export const MeetingOrigin = z.object({
  meeting_id: z.string().min(1),
  segment_id: z.string().min(1),
  speaker: z.string().max(100).nullable().default(null),
  start_ms: z.number().int().nonnegative(),
  transcript_artifact_id: z.string().nullable().default(null),
  audio_artifact_id: z.string().nullable().default(null),
  status: z.enum(['observed', 'inferred', 'confirmed']).default('inferred'),
});
export type MeetingOrigin = z.infer<typeof MeetingOrigin>;

// ---------------------------------------------------------------- artifact

/** 正規化した 1 件。Google / Microsoft / 端末の差はここで消えている。 */
export const WorkArtifact = z.object({
  id: z.string().min(1).max(200),
  source: WorkSource,
  kind: WorkArtifactKind,
  title: z.string().max(500),
  /** 抜粋。全文は持たない（<= 500 字）。 */
  body_excerpt: z.string().max(500).nullable().default(null),
  people: z.array(PersonRef).max(50).default([]),
  /** 自分から見た向き。inbound = 自分宛、outbound = 自分が出した。 */
  direction: z.enum(['inbound', 'outbound', 'self']).default('inbound'),
  occurred_at: Timestamp,
  ends_at: Timestamp.nullable().default(null),
  due_at: Timestamp.nullable().default(null),
  thread_id: z.string().max(500).nullable().default(null),
  project_hint: z.string().max(200).nullable().default(null),
  /** 自分が返したか。分からなければ null（埋めない）。 */
  responded: z.boolean().nullable().default(null),
  /** 完了しているか（task / commitment）。 */
  completed: z.boolean().nullable().default(null),
  provenance: Provenance,
  semantic: WorkSemantic.nullable().default(null),
  /** 会議から来たものの一次情報（話者・時刻・文字起こし・音源）。無ければ null。 */
  origin: MeetingOrigin.nullable().default(null),
});
export type WorkArtifact = z.infer<typeof WorkArtifact>;

/**
 * 端末から cloud へ渡す 1 回分。
 *
 * `cursor` は **この batch で読み終えた範囲の続き**。null なら「まだ途中」で、cloud は前の cursor を
 * 動かさない（500 件ずつ分けて送るとき、最後の 1 回にだけ付ける）。artifact の upsert と同じ
 * transaction でだけ進む — 先に cursor を書かない。
 */
export const WorkArtifactBatch = z.object({
  source: WorkSource,
  cursor: z.string().max(500).nullable().default(null),
  /** 取り込んだ artifact の occurred_at の最大（どこまで見えているかの事実）。 */
  watermark: Timestamp.nullable().default(null),
  artifacts: z.array(WorkArtifact).max(500),
});
export type WorkArtifactBatch = z.infer<typeof WorkArtifactBatch>;

/** 同期の試み（失敗も残す）。成功は batch の取り込みそのものが記録する。 */
export const WorkSyncAttempt = z.object({
  ok: z.boolean(),
  error: z.string().max(500).nullable().default(null),
});
export type WorkSyncAttempt = z.infer<typeof WorkSyncAttempt>;

/** source ごとの同期位置。端末はここから続きを読む（再起動しても 14 日分を読み直さない）。 */
export const WorkSyncState = z.object({
  source: WorkSource,
  cursor: z.string().nullable(),
  watermark: Timestamp.nullable(),
  last_synced_at: Timestamp.nullable(),
  last_attempt_at: Timestamp.nullable(),
  last_error: z.string().nullable(),
  artifact_count: z.number().int().nonnegative(),
  schema_version: z.number().int().positive(),
});
export type WorkSyncState = z.infer<typeof WorkSyncState>;

/** 正規化の版。上げると cloud の cursor が捨てられ、端末は読み直す。 */
export const WORK_SYNC_SCHEMA_VERSION = 1;

// ---------------------------------------------------------------- pressure

/** Work Pressure の要因。**式は決定的**で、LLM は関わらない。 */
export const WORK_PRESSURE_FACTORS = [
  'deadline',
  'unanswered',
  'calendar',
  'dependency',
  'recency',
  'repetition',
  'explicit',
] as const;
export const WorkPressureFactorName = z.enum(WORK_PRESSURE_FACTORS);
export type WorkPressureFactorName = z.infer<typeof WorkPressureFactorName>;

export const WorkPressureFactor = z.object({
  name: WorkPressureFactorName,
  /** 0..1 に正規化した値。 */
  value: z.number().min(0).max(1),
  weight: z.number().min(0).max(1),
  contribution: z.number().min(0).max(1),
  /** 人が読める理由（「明日が予定日」「48 時間未返信」）。 */
  reason: z.string().max(200),
});
export type WorkPressureFactor = z.infer<typeof WorkPressureFactor>;

export const WorkPriority = z.object({
  id: z.string(),
  /** 案件名（cluster の名前）。 */
  project: z.string().min(1).max(200),
  title: z.string().min(1).max(300),
  score: z.number().min(0).max(1),
  due_at: Timestamp.nullable(),
  waiting_on: z.string().max(200).nullable(),
  /** 短い状況（「MTI からの返信待ち」「今日 15:00 会議」）。 */
  lines: z.array(z.string().max(200)).max(4),
  /** 関連件数（Gmail 4 件 · 会議 2 件 · Task 1 件）。 */
  counts: z.record(z.string(), z.number().int().nonnegative()),
  factors: z.array(WorkPressureFactor),
  /** 出所。**空にしない。** */
  sources: z.array(Provenance).min(1),
  /** 本人が「自分の TODO」と確認した（`confirm`）。false はメール等からの推測（候補）。 */
  confirmed: z.boolean().default(false),
});
export type WorkPriority = z.infer<typeof WorkPriority>;

export const WaitingItem = z.object({
  id: z.string(),
  who: z.string().min(1).max(200),
  what: z.string().min(1).max(300),
  since_days: z.number().nonnegative(),
  project: z.string().max(200).nullable(),
  sources: z.array(Provenance).min(1),
});
export type WaitingItem = z.infer<typeof WaitingItem>;

export const OwedItem = z.object({
  id: z.string(),
  to: z.string().min(1).max(200),
  what: z.string().min(1).max(300),
  due_at: Timestamp.nullable(),
  project: z.string().max(200).nullable(),
  sources: z.array(Provenance).min(1),
  /** 本人が「自分の TODO」と確認した（`confirm`）。false はメール等からの推測（候補）。 */
  confirmed: z.boolean().default(false),
});
export type OwedItem = z.infer<typeof OwedItem>;

export const WeekLoad = z.object({
  meeting_hours: z.number().nonnegative(),
  deadlines: z.number().int().nonnegative(),
  unanswered: z.number().int().nonnegative(),
  waiting: z.number().int().nonnegative(),
});
export type WeekLoad = z.infer<typeof WeekLoad>;

/** Home に出す全体。UI/UX §8.1: 気にすることは最大 3 件、残りは「すべて見る」。 */
export const MAX_WORK_PRIORITIES = 3;

export const WorkContext = z.object({
  generated_at: Timestamp,
  /** 推測を使っているか。false なら priorities / waiting / owed は空で、注入も止まる。 */
  inference_enabled: z.boolean(),
  priorities: z.array(WorkPriority),
  waiting_on: z.array(WaitingItem),
  owed: z.array(OwedItem),
  week: WeekLoad,
  /** 取り込んだ元の件数（出所の全体像）。 */
  sources: z.record(WorkSource, z.number().int().nonnegative()),
});
export type WorkContext = z.infer<typeof WorkContext>;

// -------------------------------------------------------------- correction

/**
 * 利用者の訂正。**1 操作**で反映し、以後の推論に効く。
 * `confirm` だけは項目を消さず、本人が確認した TODO（登録済み）にする。
 * 「自分の担当ではない」は `dismiss`（note に理由）。
 */
export const WORK_CORRECTION_ACTIONS = [
  'dismiss',
  'not_priority',
  'done',
  'wrong_project',
  'confirm',
] as const;
export const WorkCorrection = z.object({
  item_id: z.string().min(1).max(300),
  action: z.enum(WORK_CORRECTION_ACTIONS),
  note: z.string().max(300).nullable().default(null),
});
export type WorkCorrection = z.infer<typeof WorkCorrection>;

// ---------------------------------------------------------- personalization

/** 推測を事実として固定しない: 観測 → 推測 → 本人が確認、の 3 段。 */
export const TRAIT_STATUSES = ['observed', 'inferred', 'confirmed'] as const;
export const TraitStatus = z.enum(TRAIT_STATUSES);
export type TraitStatus = z.infer<typeof TraitStatus>;

export const PersonalizationTrait = z.object({
  key: z.string().min(1).max(100),
  /** 人が読める 1 行（「短く要点から」「火・木は会議が多い」）。 */
  label: z.string().min(1).max(200),
  value: z.union([z.number(), z.string(), z.array(z.string())]),
  status: TraitStatus,
  /** 本人が「この推測を使わない」と言ったら false。 */
  enabled: z.boolean().default(true),
  sources: z.array(Provenance).default([]),
});
export type PersonalizationTrait = z.infer<typeof PersonalizationTrait>;

export const PersonalizationProfile = z.object({
  working_style: z.array(PersonalizationTrait),
  work_patterns: z.array(PersonalizationTrait),
  frequent_entities: z.array(PersonalizationTrait),
  /** すべての推測を止める（<= 1 操作）。 */
  inference_enabled: z.boolean(),
  updated_at: Timestamp,
});
export type PersonalizationProfile = z.infer<typeof PersonalizationProfile>;

/** 本人による更新。confirm / disable / enable、または全体の停止。 */
export const PersonalizationUpdate = z.object({
  inference_enabled: z.boolean().optional(),
  traits: z
    .array(
      z.object({
        key: z.string().min(1).max(100),
        status: TraitStatus.optional(),
        enabled: z.boolean().optional(),
        value: z.union([z.number(), z.string(), z.array(z.string())]).optional(),
      }),
    )
    .max(50)
    .default([]),
});
export type PersonalizationUpdate = z.infer<typeof PersonalizationUpdate>;

// --------------------------------------------------------------- injection

/** LLM に渡す分。**全データは渡さない。**関連する上位だけ、上限つき。 */
export const MAX_INJECTED_PRIORITIES = 3;
export const MAX_INJECTED_CHARS = 1_200;

/**
 * 問いの意図（CONTEXT_MINIMIZATION_GATE）。
 *
 *   none          仕事の文脈が要らない問い（「この Swift コード直して」）→ 0 件
 *   project       案件を名指しした問い → その案件だけ
 *   priorities    今日 / 今週の優先を聞いている → 上位 <= 3
 *   waiting       誰を待っているか → 待ちの一覧（<= 3）
 *   owed          自分が返すもの → 返すものの一覧（<= 3）
 *   email_reply   返信を書こうとしている → 名指しの相手・案件の分だけ（無ければ 0）
 *   meeting_prep  会議の準備 → その会議の案件 + 相手 + 開いている件
 */
export const CONTEXT_INTENTS = [
  'none',
  'project',
  'priorities',
  'waiting',
  'owed',
  'email_reply',
  'meeting_prep',
] as const;
export const ContextIntent = z.enum(CONTEXT_INTENTS);
export type ContextIntent = z.infer<typeof ContextIntent>;

/** 1 turn ごとに残す、注入の事実。**「何を知っているか」ではなく「何を渡したか」。** */
export const InjectionStats = z.object({
  intent: ContextIntent,
  /** 渡した件数（案件・待ち・返すもの）。 */
  selected_artifacts: z.number().int().nonnegative(),
  /** 渡せた候補の総数。 */
  available_artifacts: z.number().int().nonnegative(),
  chars: z.number().int().nonnegative(),
});
export type InjectionStats = z.infer<typeof InjectionStats>;

/** `<work_context>` の 1 行。 */
export const InjectedPriority = z.object({
  project: z.string(),
  score: z.number(),
  lines: z.array(z.string()).max(3),
});
export type InjectedPriority = z.infer<typeof InjectedPriority>;

/** `<work_context>` を文字列にする。空なら空文字（何も注入しない）。 */
export function renderWorkContext(items: readonly InjectedPriority[]): string {
  if (items.length === 0) return '';
  const rows = items
    .slice(0, MAX_INJECTED_PRIORITIES)
    .map(
      (p) =>
        `  <priority project="${escapeXml(p.project)}" score="${p.score.toFixed(2)}">\n` +
        p.lines.map((l) => `    ${escapeXml(l)}`).join('\n') +
        '\n  </priority>',
    );
  const text = `<work_context>\n${rows.join('\n')}\n</work_context>`;
  return text.length > MAX_INJECTED_CHARS ? text.slice(0, MAX_INJECTED_CHARS) : text;
}

function escapeXml(s: string): string {
  return s.replace(
    /[<>&"]/g,
    (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c] ?? c,
  );
}

// ---------------------------------------------------------------- reply

/**
 * 「これ返して」。端末が集めた**候補**を、決めた順で cloud に渡す（REPLY_IN_CONTEXT_GATE）。
 *
 *   1. mail       いま開いているメール（Mail.app / ブラウザの Gmail の題名）
 *   2. selection  選択中の文字
 *   3. screenshot 直前のスクショ（添付として別に来る）
 *   4. frontmost  前面アプリの窓の題名
 *   5. named      発話の中の人・案件（cloud が発話から取る。端末は送らない）
 *   6. none
 * 曖昧なら似たメールを勝手に選ばない。
 */
export const REPLY_CANDIDATE_KINDS = ['mail', 'selection', 'screenshot', 'frontmost'] as const;
export const ReplyCandidate = z.object({
  kind: z.enum(REPLY_CANDIDATE_KINDS),
  /** 題名・選択文字・窓の題名。全文ではない。 */
  label: z.string().min(1).max(300),
  app: z.string().max(100).nullable().default(null),
});
export type ReplyCandidate = z.infer<typeof ReplyCandidate>;

/** 解決したメール。artifact そのもの（抜粋）へ辿れる。 */
export const ReplyTarget = z.object({
  artifact_id: z.string(),
  source: WorkSource,
  thread_id: z.string().nullable(),
  /** provider のメッセージ id（返信の in_reply_to）。 */
  external_id: z.string(),
  subject: z.string(),
  /** 相手（差出人）。 */
  to: PersonRef.nullable(),
  project: z.string().nullable(),
  /** どの候補で決まったか。 */
  matched_by: z.enum([...REPLY_CANDIDATE_KINDS, 'named']),
  confidence: z.number().min(0).max(1),
});
export type ReplyTarget = z.infer<typeof ReplyTarget>;

export const ReplyResolution = z.discriminatedUnion('status', [
  z.object({ status: z.literal('resolved'), target: ReplyTarget }),
  z.object({ status: z.literal('ambiguous'), candidates: z.array(z.string()).max(5) }),
  z.object({ status: z.literal('none') }),
]);
export type ReplyResolution = z.infer<typeof ReplyResolution>;

/** 返信案に添える最小の文脈。**別案件のメールや今日の全予定は入れない。** */
export const ReplyPack = z.object({
  target: ReplyTarget,
  /** そのスレッドの直近（抜粋）。 */
  thread: z.array(Provenance).max(5),
  project: z.string().nullable(),
  /** その案件の直近の会議（無ければ null）。 */
  meeting: Provenance.nullable(),
  /** その案件で開いている件（自分が返す / 相手待ち）。 */
  open_items: z.array(z.string().max(300)).max(5),
  /** 本人が確認した働き方（confirmed だけ）。 */
  personalization: z.array(z.string().max(200)).max(5),
  /** 添えたものすべての出所。 */
  sources: z.array(Provenance).min(1),
});
export type ReplyPack = z.infer<typeof ReplyPack>;

/** turn の返事に添える、返信案の要点（本文は task の成果物）。 */
export const ReplyDraftMeta = z.object({
  target: ReplyTarget,
  sources: z.array(Provenance).min(1),
  /** 返信案を作るのに使った文脈の短い説明（「昨日の会議と、このスレッドを踏まえて」）。 */
  basis: z.string().max(200),
});
export type ReplyDraftMeta = z.infer<typeof ReplyDraftMeta>;

/** 送る（`POST /v1/work/reply/send`）。**本人が確認カードで押したあとにだけ**来る。 */
export const SendReplyRequest = z.object({
  source: WorkSource,
  to: z.array(z.string().min(3).max(320)).min(1).max(20),
  subject: z.string().min(1).max(500),
  body: z.string().min(1).max(20_000),
  in_reply_to: z.string().max(500).nullable().default(null),
  thread_id: z.string().max(500).nullable().default(null),
});
export type SendReplyRequest = z.infer<typeof SendReplyRequest>;

// ---------------------------------------------------------- meeting brief

/** 事実 1 つ。**出所の無い事実は無い。** */
export const BriefFact = z.object({
  text: z.string().min(1).max(300),
  sources: z.array(Provenance).min(1),
});
export type BriefFact = z.infer<typeof BriefFact>;

/** 会議で確かめたいこと。質問だけでなく、なぜ聞くかと出所を持つ（それっぽい質問を作らない）。 */
export const SuggestedQuestion = z.object({
  question: z.string().min(1).max(200),
  reason: z.string().min(1).max(300),
  sources: z.array(Provenance).min(1),
  extracted_by: z.enum(['llm', 'rule']),
});
export type SuggestedQuestion = z.infer<typeof SuggestedQuestion>;

/**
 * 会議前の brief（MEETING_BRIEF_GATE）。
 *
 *   次の予定 → 案件 → 前回の会議 → その後のメール → 開いている件 → 決定的な事実 → 言葉
 */
export const MeetingBrief = z.object({
  event_id: z.string(),
  title: z.string(),
  starts_at: Timestamp,
  project: z.string().nullable(),
  previous: z.array(BriefFact).max(6),
  since_last_meeting: z.array(BriefFact).max(6),
  open_items: z.array(BriefFact).max(6),
  suggested_questions: z.array(SuggestedQuestion).max(3),
  provenance: z.array(Provenance).min(1),
  generated_at: Timestamp,
});
export type MeetingBrief = z.infer<typeof MeetingBrief>;

// One-time registration profile. Progress is reported by the reading worker,
// and the confirmed snapshot is immutable except for explicit user edits.
export const InitialProfileSource = z.enum([
  'gmail',
  'google_calendar',
  'outlook_mail',
  'outlook_calendar',
]);
export const InitialProfileOutcome = z.object({
  source: InitialProfileSource,
  status: z.enum(['reading', 'synced', 'not_connected', 'not_granted', 'failed']),
  artifacts: z.number().int().min(0).max(5000),
});
export const InitialProfileSections = z.object({
  focus: z.array(z.string().trim().min(1).max(200)).max(5),
  people: z.array(z.string().trim().min(1).max(200)).max(12),
  priorities: z.array(z.string().trim().min(1).max(200)).max(5),
  work_pattern: z.array(z.string().trim().min(1).max(200)).max(3),
  open_items: z.number().int().min(0).max(5000),
});
/** Initial body analysis stays local. Only bounded findings and source IDs leave the worker. */
export const INITIAL_PROFILE_MAIL_LIMIT = 100;
export const InitialProfileClaim = z
  .object({
    text: z.string().trim().min(1).max(200),
    source_ids: z.array(z.string().min(1).max(200)).min(1).max(INITIAL_PROFILE_MAIL_LIMIT),
  })
  .strict();
export const InitialProfileAnalysis = z
  .object({
    version: z.literal(2),
    status: z.enum(['complete', 'partial', 'unavailable']),
    selected_count: z.number().int().min(0).max(INITIAL_PROFILE_MAIL_LIMIT),
    analyzed_count: z.number().int().min(0).max(INITIAL_PROFILE_MAIL_LIMIT),
    analyzed_ids: z.array(z.string().min(1).max(200)).max(INITIAL_PROFILE_MAIL_LIMIT),
    excluded_ids: z.array(z.string().min(1).max(200)).max(INITIAL_PROFILE_MAIL_LIMIT),
    focus: z.array(InitialProfileClaim).max(5),
    priorities: z.array(InitialProfileClaim).max(5),
    open_items: z.array(InitialProfileClaim).max(30),
  })
  .strict();
export type InitialProfileClaim = z.infer<typeof InitialProfileClaim>;
export type InitialProfileAnalysis = z.infer<typeof InitialProfileAnalysis>;
export const InitialProfile = z.object({
  id: z.uuid(),
  provider: z.enum(['google', 'microsoft']),
  status: z.enum(['queued', 'analysing', 'ready', 'confirmed', 'failed']),
  started_at: Timestamp,
  updated_at: Timestamp,
  outcomes: z.array(InitialProfileOutcome).max(4),
  sections: InitialProfileSections.nullable(),
  profile: PersonalizationProfile.nullable(),
  analysis: InitialProfileAnalysis.nullable().default(null),
});
export type InitialProfile = z.infer<typeof InitialProfile>;
export type InitialProfileOutcome = z.infer<typeof InitialProfileOutcome>;
export type InitialProfileSections = z.infer<typeof InitialProfileSections>;
