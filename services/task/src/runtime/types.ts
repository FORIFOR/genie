/**
 * タスク実行基盤の抽象。実装仕様 §6.2。
 *
 * サービス層が Temporal の API に直接触らないようにする。
 * テストは軽量な代替実装を差し込み、ワークフロー本体の検証は
 * Temporal の test environment で別途行う。
 */
import type { TaskStateSnapshot, TaskWorkflowInput } from '../workflows.js';

export interface StartedWorkflow {
  readonly workflowId: string;
  readonly runId: string;
  /** 同じ workflow id が既に走っていた（= 二重起動を防いだ）。 */
  readonly alreadyRunning: boolean;
}

export interface TaskRuntime {
  start(input: TaskWorkflowInput, workflowId: string): Promise<StartedWorkflow>;
  approve(workflowId: string, approvalId: string, decision: 'APPROVED' | 'REJECTED'): Promise<void>;
  cancel(workflowId: string, reason: string): Promise<void>;
  /** 動いている仕事へ追加指示を渡す。反映するかどうかは workflow が次の段の前で決める。 */
  instruct(workflowId: string, instruction: { requestId: string; text: string }): Promise<void>;
  describe(workflowId: string): Promise<TaskStateSnapshot | null>;
  close(): Promise<void>;
}

/** workflow id は決め打ちで導出する。二重起動の防波堤になる（実装仕様 §6.2）。 */
export function workflowIdFor(tenantId: string, taskId: string): string {
  return `task/${tenantId}/${taskId}`;
}

export const TASK_QUEUE = 'astra.task.v1';

/**
 * 仕事の種類ごとの queue。正本 §26 が worker を分けているのは、
 * **一つの重い仕事が別の仕事を止めない**ようにするため。
 *
 * 長い動画の書き出しと、数秒で終わる調べ物が同じ列に並ぶと、
 * 後者がいつまでも順番待ちになる。
 *
 * 分けるのは配備の判断なので、**同じ queue を全部の worker が
 * 見る構成でも動く**（既定はそうなっている）。
 */
export const TASK_QUEUES = {
  general: TASK_QUEUE,
  research: 'astra.task.research.v1',
  document: 'astra.task.document.v1',
  media: 'astra.task.media.v1',
  domain: 'astra.task.domain.v1',
} as const;

export type TaskQueueName = keyof typeof TASK_QUEUES;

/**
 * その kind をどの列に流すか。
 *
 * **決まらないものは general。**推測で振り分けると、
 * 動かない worker の列に積まれて誰も気づかない。
 */
export function queueForKind(kind: string): string {
  if (kind === 'research') return TASK_QUEUES.research;
  if (kind === 'meeting.finalize') return TASK_QUEUES.media;
  if (kind.startsWith('plugin:')) return TASK_QUEUES.domain;
  return TASK_QUEUES.general;
}
