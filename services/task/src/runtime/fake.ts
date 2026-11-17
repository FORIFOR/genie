/**
 * 実行しない TaskRuntime。テストと、Temporal を立てずに HTTP 層だけ確かめたい場面用。
 *
 * ワークフロー本体の検証は Temporal の test environment で行う。
 * ここでは「service が runtime に何を頼んだか」だけを記録する。
 */
import { GenieError } from '@genie/contracts';
import type { TaskStateSnapshot, TaskWorkflowInput } from '../workflows.js';
import type { StartedWorkflow, TaskRuntime } from './types.js';

export interface RecordedSignal {
  readonly workflowId: string;
  readonly kind: 'approve' | 'cancel' | 'instruct';
  readonly approvalId?: string;
  readonly decision?: 'APPROVED' | 'REJECTED';
  readonly reason?: string;
  readonly requestId?: string;
  readonly text?: string;
}

export class InMemoryTaskRuntime implements TaskRuntime {
  readonly started = new Map<string, TaskWorkflowInput>();
  readonly signals: RecordedSignal[] = [];
  /** true にすると、存在しない workflow への signal を実機と同じように拒否する。 */
  strictSignals = false;

  async start(input: TaskWorkflowInput, workflowId: string): Promise<StartedWorkflow> {
    const alreadyRunning = this.started.has(workflowId);
    if (!alreadyRunning) this.started.set(workflowId, input);
    return { workflowId, runId: `run-${this.started.size}`, alreadyRunning };
  }

  async approve(
    workflowId: string,
    approvalId: string,
    decision: 'APPROVED' | 'REJECTED',
  ): Promise<void> {
    this.#assertRunning(workflowId);
    this.signals.push({ workflowId, kind: 'approve', approvalId, decision });
  }

  async instruct(workflowId: string, instruction: { requestId: string; text: string }): Promise<void> {
    this.#assertRunning(workflowId);
    this.signals.push({ workflowId, kind: 'instruct', ...instruction });
  }

  async cancel(workflowId: string, reason: string): Promise<void> {
    this.#assertRunning(workflowId);
    this.signals.push({ workflowId, kind: 'cancel', reason });
  }

  async describe(workflowId: string): Promise<TaskStateSnapshot | null> {
    return this.started.has(workflowId)
      ? { status: 'RUNNING', stepIndex: 0, stepCount: 0, awaitingApprovalId: null }
      : null;
  }

  async close(): Promise<void> {
    this.started.clear();
    this.signals.length = 0;
  }

  #assertRunning(workflowId: string): void {
    if (this.strictSignals && !this.started.has(workflowId)) {
      throw new GenieError('task.invalid_state', 'task is no longer running');
    }
  }
}
