/** activity の型。ワークフロー側から見える契約なので、実装から分離しておく。 */
import type { TaskStep } from './plan.js';
import type { TaskWorkflowInput, TaskResult } from './workflows.js';

export interface TaskErrorPayload {
  readonly code: string;
  readonly message: string;
  readonly step_index: number | null;
  readonly retryable: boolean;
  /**
   * 何をすれば直るか（正本 §24）。
   * **言わないと、利用者は何もできない。**
   */
  readonly recovery?:
    'retry' | 'reconnect' | 'grant_permission' | 'reauthenticate' | 'handoff' | 'none';
  /**
   * 何を試して、何が使えなかったか（正本 §24 の梯子の跡）。
   *
   * `message` と分けて持つ。message には tool 側の文言が入り得るので、
   * **そのまま画面へ出すと tool 名が漏れる**（§7.2）。
   */
  readonly handoff_explanation?: string | null;
}

export interface StartTaskMeta {
  readonly kind: string;
  readonly title: string;
  readonly step_count: number;
  readonly run_id: string;
}

export interface ArtifactSpec {
  readonly type: 'REPORT' | 'DOCUMENT' | 'MEETING_BUNDLE' | 'OTHER';
  readonly title: string;
  readonly mimeType: string;
  /** 会議から生まれた成果物は、会議へ辿れるようにする（AC3-10）。 */
  readonly sourceMeetingId?: string;
}

export interface RequestedApproval {
  readonly approvalId: string;
}

export interface TaskActivities {
  startTask(input: TaskWorkflowInput, meta: StartTaskMeta): Promise<void>;
  requestApprovalIfNeeded(
    input: TaskWorkflowInput,
    step: TaskStep,
  ): Promise<RequestedApproval | null>;
  acceptApproval(input: TaskWorkflowInput, approvalId: string): Promise<void>;
  /** 追加指示を「反映した（どの段で）」と記録する。受け取ったままのものだけを動かす。 */
  applyInstructions(input: TaskWorkflowInput, requestIds: readonly string[], stepIndex: number): Promise<void>;
  rejectApproval(input: TaskWorkflowInput, approvalId: string, stepIndex: number): Promise<void>;
  expireApproval(input: TaskWorkflowInput, approvalId: string): Promise<void>;
  executeStep(input: TaskWorkflowInput, step: TaskStep): Promise<unknown>;
  /**
   * 端末が落ちた仕事を止める。正本 §4.4。
   *
   * **FAILED にしない。**待てば戻るものを失敗として畳むと、
   * 途中までの結果も、承認済みの判断も捨てることになる。
   */
  pauseForHost(input: TaskWorkflowInput, stepIndex: number): Promise<void>;
  /** 端末が戻ったので進める。止まっていた理由が消えたときだけ呼ぶ。 */
  resumeFromHost(input: TaskWorkflowInput, stepIndex: number): Promise<void>;
  /** いま仕事を渡せる端末があるか。**無ければ待つ。** */
  hostAvailable(input: TaskWorkflowInput): Promise<boolean>;
  composeArtifact(
    input: TaskWorkflowInput,
    spec: ArtifactSpec,
    results: readonly unknown[],
  ): Promise<string>;
  /** Returns the committed outcome; CANCELLING must be finalized, never shown as completed. */
  completeTask(
    input: TaskWorkflowInput,
    artifactId: string,
  ): Promise<TaskResult | { status: 'CANCELLING'; artifactId: null }>;
  failTask(input: TaskWorkflowInput, error: TaskErrorPayload): Promise<void>;
  cancelTask(input: TaskWorkflowInput, reason: string): Promise<TaskResult>;
}
