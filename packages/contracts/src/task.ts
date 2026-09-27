/**
 * Task。正本 §4.2 / §19 / §24、実装仕様 §3.3 / §6。
 */
import { z } from 'zod';
import { PROGRESS_REQUIRED_AFTER_MS } from './slo.js';
import { ArtifactId, ConversationId, TaskId, TenantId, UserId } from './ids.js';
import { JsonObject, Timestamp } from './primitives.js';
import { ErrorCode } from './errors.js';

export const TASK_STATUSES = [
  'PENDING',
  'RUNNING',
  'WAITING_APPROVAL',
  /**
   * 手元の実行基盤（Local Agent Host）が落ちている。正本 §4.4。
   *
   * **失敗ではない。**待てば戻る。失敗にすると、利用者は最初からやり直す。
   * ここで運営側のモデルへ乗り換えないのが肝で、乗り換えると
   * 利用者が選んだ経路と料金の外で処理が走る。
   */
  'PAUSED_HOST_OFFLINE',
  'CANCELLING',
  'COMPLETED',
  'FAILED',
  'CANCELLED',
] as const;

export const TaskStatus = z.enum(TASK_STATUSES);
export type TaskStatus = z.infer<typeof TaskStatus>;

export const TERMINAL_TASK_STATUSES = [
  'COMPLETED',
  'FAILED',
  'CANCELLED',
] as const satisfies readonly TaskStatus[];

export const isTerminal = (s: TaskStatus): boolean =>
  (TERMINAL_TASK_STATUSES as readonly string[]).includes(s);

/**
 * 許可された状態遷移。`updateTaskStatus` activity はこの表以外の遷移を拒否する
 * （実装仕様 §6.4）。同一状態への遷移は no-op として許す（activity の再実行対策）。
 */
export const TASK_TRANSITIONS: Readonly<Record<TaskStatus, readonly TaskStatus[]>> = {
  PENDING: ['RUNNING', 'PAUSED_HOST_OFFLINE', 'CANCELLING', 'FAILED', 'CANCELLED'],
  RUNNING: [
    'WAITING_APPROVAL',
    // 端末が落ちた。**失敗にしない。**待てば戻る。
    'PAUSED_HOST_OFFLINE',
    'CANCELLING',
    'COMPLETED',
    'FAILED',
  ],
  WAITING_APPROVAL: ['RUNNING', 'PAUSED_HOST_OFFLINE', 'CANCELLING', 'FAILED', 'CANCELLED'],
  /**
   * 戻ったら続きへ。人が諦めれば中止。
   * **勝手に FAILED へ落とさない**（途中までの結果ごと失うため）。
   */
  PAUSED_HOST_OFFLINE: ['RUNNING', 'WAITING_APPROVAL', 'CANCELLING', 'CANCELLED'],
  CANCELLING: ['CANCELLED', 'FAILED'],
  COMPLETED: [],
  FAILED: [],
  CANCELLED: [],
};

export function canTransition(from: TaskStatus, to: TaskStatus): boolean {
  if (from === to) return true;
  return TASK_TRANSITIONS[from].includes(to);
}

/**
 * 次に取れる行動。UI/UX §21「エラーは仕事への影響と next action を説明する」の機械可読な半分。
 * 表示文言はクライアントが `code` と合わせて組み立てる（サーバに i18n を持たせない）。
 */
export const RecoveryHint = z.enum([
  'retry', // 再試行で直り得る
  'reconnect', // 接続が切れている
  'grant_permission', // 権限が足りない
  'reauthenticate', // 認証し直しが要る
  'handoff', // 人が引き取るしかない
  'none',
]);
export type RecoveryHint = z.infer<typeof RecoveryHint>;

export const TaskError = z.object({
  code: ErrorCode,
  message: z.string(),
  /** どの step で落ちたか。正本 §24「勝手に成功扱いしない」の説明責任のため。 */
  step_index: z.number().int().nonnegative().nullable(),
  retryable: z.boolean(),
  recovery: RecoveryHint.default('none'),
  /**
   * 何を試して、何が使えなかったか。正本 §24 の梯子の跡。
   *
   * `message` とは別に持つ。message には tool 側の文言が入り得るので、
   * **そのまま画面に出すと tool 名が漏れる**（§7.2）。
   * こちらは利用者に見せてよい言葉だけで組んである。
   */
  handoff_explanation: z.string().nullable().default(null),
});
export type TaskError = z.infer<typeof TaskError>;

export const Task = z.object({
  id: TaskId,
  tenant_id: TenantId,
  created_by: UserId,
  conversation_id: ConversationId.nullable(),
  kind: z.string().min(1).max(64),
  title: z.string().max(200).nullable(),
  status: TaskStatus,
  input: JsonObject,
  result_artifact_id: ArtifactId.nullable(),
  error: TaskError.nullable(),
  created_at: Timestamp,
  started_at: Timestamp.nullable(),
  completed_at: Timestamp.nullable(),
  updated_at: Timestamp,
});
export type Task = z.infer<typeof Task>;

/**
 * 一覧の行。UI/UX §9.1「● A社 商談準備  最新競合情報を調査中 · 12 sources  Started 14:02」。
 * 行ごとに stream を引かなくて済むよう、いま進めている段だけを添える。
 * 無い（まだ始まっていない / 終わった）なら null。作文しない。
 */
export const TaskCurrentStep = z.object({
  message: z.string().max(200),
  detail: z.string().max(60).nullable().default(null),
  retrying: z.boolean().default(false),
});
export type TaskCurrentStep = z.infer<typeof TaskCurrentStep>;

export const TaskListItem = Task.extend({
  current_step: TaskCurrentStep.nullable().default(null),
});
export type TaskListItem = z.infer<typeof TaskListItem>;

/**
 * 動いている仕事への追加指示。受け取ったこと（RECEIVED）と、実際に反映したこと（APPLIED・どの段で）を分ける。
 * 反映する前に仕事が終わったら NOT_APPLIED。終わった仕事には足せない（続きの仕事を作るかを本人に聞く）。
 */
export const TASK_INSTRUCTION_STATUSES = ['RECEIVED', 'APPLIED', 'NOT_APPLIED'] as const;
export const TaskInstructionStatus = z.enum(TASK_INSTRUCTION_STATUSES);
export type TaskInstructionStatus = z.infer<typeof TaskInstructionStatus>;

export const TaskInstruction = z.object({
  task_id: TaskId,
  request_id: z.string().uuid(),
  text: z.string().min(1).max(2000),
  status: TaskInstructionStatus,
  applied_step_index: z.number().int().nonnegative().nullable(),
  created_at: z.string().datetime(),
  resolved_at: z.string().datetime().nullable(),
});
export type TaskInstruction = z.infer<typeof TaskInstruction>;

export const AddTaskInstructionRequest = z
  .object({
    /** 同じ指示を二度足さない（通信が切れて送り直しても 1 件）。 */
    request_id: z.string().uuid(),
    text: z.string().trim().min(1).max(2000),
  })
  .strict();
export type AddTaskInstructionRequest = z.infer<typeof AddTaskInstructionRequest>;

export const CreateTaskRequest = z.object({
  kind: z.string().min(1).max(64),
  title: z.string().max(200).optional(),
  input: JsonObject.default({}),
  conversation_id: ConversationId.optional(),
});
export type CreateTaskRequest = z.infer<typeof CreateTaskRequest>;

export const CancelTaskRequest = z.object({
  reason: z.string().max(500).default('user_requested'),
});
export type CancelTaskRequest = z.infer<typeof CancelTaskRequest>;

/**
 * Task Dock の UI ステート。**UI/UX 仕様 §3 が正**（正本 §4.2 をより細かくしたもの）。
 *
 * サーバの TaskStatus と 1:1 にしない。
 * HIDDEN / READY / LISTENING / TYPING / UNDERSTANDING / MINIMIZED は
 * クライアント固有で、サーバ状態を持たない。
 *
 * 正本 §4.2 との差分（逸脱 D-17）:
 *   - THINKING / RESEARCHING / ACTING を `WORKING` 1 つに畳む。
 *     どの工程かは Work Surface の semantic step が示すので、Dock 側で分ける必要がない
 *     （UI/UX §1.2「Show Work, Not Agents」/ §6.1）。
 *   - `TYPING` を追加（UI/UX §3・§4.1 で Ready と別の geometry を持つ）。
 *   - `ERROR` を `FAILED_RECOVERABLE` / `FAILED_BLOCKED` に分ける。
 *     再試行で直るものと、人間の操作（権限・接続・入力）が要るものとで
 *     見せる次の行動が違う（UI/UX §3・§21）。
 */
export const TaskDockState = z.enum([
  'HIDDEN',
  'READY',
  'LISTENING',
  'TYPING',
  'UNDERSTANDING',
  'WORKING',
  'WAITING_APPROVAL',
  'RESULT',
  'FAILED_RECOVERABLE',
  'FAILED_BLOCKED',
  'MINIMIZED',
]);
export type TaskDockState = z.infer<typeof TaskDockState>;

/**
 * 人間の操作なしには先へ進めないエラー。UI/UX §3 FAILED_BLOCKED / §21。
 * これ以外は再試行や代替経路で回復し得るものとして FAILED_RECOVERABLE に倒す。
 */
const BLOCKING_ERROR_CODES: readonly string[] = [
  'auth.forbidden',
  'auth.expired_token',
  'auth.invalid_token',
  'plugin.permission_denied',
  'plugin.incompatible',
  'host.capability_denied',
  'host.not_connected',
  'approval.expired',
  'approval.rejected',
  'task.approval_timeout',
];

/** サーバ状態から Task Dock の既定表示状態を導く。 */
export function dockStateFor(
  status: TaskStatus,
  // 見るのは code だけ。全体を要求すると、呼ぶ側が要らない項目まで組まされる。
  error?: Pick<TaskError, 'code'> | null,
): TaskDockState {
  switch (status) {
    case 'PENDING':
    case 'RUNNING':
    case 'CANCELLING':
    /*
     * 止まっているが、進行中として見せる。§4.4。
     * 失敗の面へ落とすと、利用者は「やり直さないといけない」と読む。
     * 実際には待てば戻るので、進行中のまま理由を添える。
     */
    case 'PAUSED_HOST_OFFLINE':
      return 'WORKING';
    case 'WAITING_APPROVAL':
      return 'WAITING_APPROVAL';
    case 'COMPLETED':
      return 'RESULT';
    case 'FAILED':
      return error && BLOCKING_ERROR_CODES.includes(error.code)
        ? 'FAILED_BLOCKED'
        : 'FAILED_RECOVERABLE';
    case 'CANCELLED':
      return 'READY';
  }
}

/** 正本 §4.3「2秒を超える処理は progress event を出す」。受け入れテスト AC-6 の閾値。 */
/**
 * 2 秒を超える処理には進捗を出す（正本 §4.3・§23）。
 * 数字は §23 の表（`slo.ts`）から引く。ここで別に持たない。
 */
export const PROGRESS_HEARTBEAT_MAX_MS = PROGRESS_REQUIRED_AFTER_MS;
