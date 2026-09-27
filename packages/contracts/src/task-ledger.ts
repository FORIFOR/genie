/**
 * Task Ledger。自律的PC操作における永続タスク台帳。
 *
 * 画面のスクリーンショットやチャット履歴に依存せず、
 * 「大目標・制約・サブタスク進捗・獲得した根拠・決定論的完了検証基準」を永続管理する。
 */
import { z } from 'zod';
import { TaskId } from './ids.js';
import { JsonObject, Timestamp } from './primitives.js';

/**
 * 5段階のハイブリッド実行経路（優先順位ラダー）。
 *
 * 上位ほど高速・低コスト・確実・画面非占有。下位はフォールバック。
 */
export const EXECUTION_ROUTES = [
  'tier1_api_mcp', // API, MCP, App Intents (直接構造化通信)
  'tier2_web_dom', // Playwright, WebMCP, DOM操作 (ブラウザ内直結)
  'tier3_cli_fs', // Shell, Filesystem, AppleScript (OSスクリプト/FS操作)
  'tier4_macos_ax', // Background AX (macOSアクセシビリティAPI、非前面操作)
  'tier5_vision', // Vision Model + Native Input (スクリーンショット+座標入力、最終手段)
] as const;

export const ExecutionRoute = z.enum(EXECUTION_ROUTES);
export type ExecutionRoute = z.infer<typeof ExecutionRoute>;

export const SUBTASK_STATUSES = [
  'pending',
  'running',
  'completed',
  'failed',
  'skipped',
] as const;

export const SubtaskStatus = z.enum(SUBTASK_STATUSES);
export type SubtaskStatus = z.infer<typeof SubtaskStatus>;

export const VERIFICATION_TYPES = [
  'file_exists',
  'file_content',
  'ax_element_state',
  'process_exit',
  'api_response',
  'dom_element',
] as const;

export const VerificationType = z.enum(VERIFICATION_TYPES);
export type VerificationType = z.infer<typeof VerificationType>;

export const LedgerConstraint = z.object({
  key: z.string().min(1).max(100),
  value: z.string().min(1).max(500),
  required: z.boolean().default(true),
});
export type LedgerConstraint = z.infer<typeof LedgerConstraint>;

export const EVIDENCE_TYPES = [
  'file',
  'url',
  'message_id',
  'element_id',
  'api_record',
  'text',
] as const;

export const EvidenceType = z.enum(EVIDENCE_TYPES);
export type EvidenceType = z.infer<typeof EvidenceType>;

export const LedgerEvidence = z.object({
  id: z.string().min(1),
  type: EvidenceType,
  uri: z.string().min(1),
  description: z.string().max(500),
  captured_at: Timestamp,
});
export type LedgerEvidence = z.infer<typeof LedgerEvidence>;

export const LedgerSubtask = z.object({
  id: z.string().min(1).max(64),
  title: z.string().min(1).max(300),
  status: SubtaskStatus.default('pending'),
  route: ExecutionRoute.default('tier4_macos_ax'),
  evidence_refs: z.array(z.string()).default([]),
  started_at: Timestamp.nullable().default(null),
  completed_at: Timestamp.nullable().default(null),
  error_message: z.string().nullable().default(null),
});
export type LedgerSubtask = z.infer<typeof LedgerSubtask>;

export const VerificationCriteria = z.object({
  id: z.string().min(1).max(64),
  type: VerificationType,
  target: JsonObject,
  satisfied: z.boolean().default(false),
  evidence_ref: z.string().nullable().default(null),
});
export type VerificationCriteria = z.infer<typeof VerificationCriteria>;

export const TaskLedger = z.object({
  task_id: TaskId,
  goal: z.string().min(1).max(2000),
  current_state: z.string().max(1000).default(''),
  constraints: z.array(LedgerConstraint).default([]),
  subtasks: z.array(LedgerSubtask).default([]),
  evidence: z.array(LedgerEvidence).default([]),
  criteria: z.array(VerificationCriteria).default([]),
  is_verified: z.boolean().default(false),
  updated_at: Timestamp,
});
export type TaskLedger = z.infer<typeof TaskLedger>;
