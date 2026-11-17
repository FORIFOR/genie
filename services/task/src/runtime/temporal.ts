/** Temporal 実装。実装仕様 §6.2・§6.5。 */
import {
  Client,
  Connection,
  WorkflowExecutionAlreadyStartedError,
  WorkflowNotFoundError,
  type WorkflowHandle,
} from '@temporalio/client';
import { GenieError } from '@genie/contracts';
import {
  approveSignal,
  instructSignal,
  cancelSignal,
  getStateQuery,
  type TaskStateSnapshot,
  type TaskWorkflowInput,
} from '../workflows.js';
import { TASK_QUEUE, queueForKind, type StartedWorkflow, type TaskRuntime } from './types.js';

export interface TemporalConfig {
  readonly address: string;
  readonly namespace: string;
  readonly taskQueue?: string;
  /**
   * 種類ごとに列を分けるか。既定は分けない。
   *
   * 分けるのは配備の判断であって、**分けなくても動く**。
   * 分けたのに worker を用意し忘れると、仕事が誰にも拾われない。
   */
  readonly routeByKind?: boolean;
}

export class TemporalTaskRuntime implements TaskRuntime {
  readonly #client: Client;
  readonly #taskQueue: string;
  readonly #ownsConnection: boolean;

  readonly #routeByKind: boolean;

  constructor(client: Client, taskQueue = TASK_QUEUE, ownsConnection = false, routeByKind = false) {
    this.#client = client;
    this.#taskQueue = taskQueue;
    this.#ownsConnection = ownsConnection;
    this.#routeByKind = routeByKind;
  }

  static async connect(config: TemporalConfig): Promise<TemporalTaskRuntime> {
    const connection = await Connection.connect({ address: config.address });
    const client = new Client({ connection, namespace: config.namespace });
    return new TemporalTaskRuntime(
      client,
      config.taskQueue ?? TASK_QUEUE,
      true,
      config.routeByKind ?? false,
    );
  }

  async start(input: TaskWorkflowInput, workflowId: string): Promise<StartedWorkflow> {
    try {
      const handle = await this.#client.workflow.start('TaskWorkflow', {
        taskQueue: this.#routeByKind ? queueForKind(input.kind) : this.#taskQueue,
        workflowId,
        args: [input],
        // 実装仕様 §6.2: 同じ workflow id の二重起動を実行層でも弾く
        workflowIdReusePolicy: 'REJECT_DUPLICATE',
        // 承認待ちを許容する（実装仕様 §6.5）
        workflowExecutionTimeout: '7 days',
      });
      return { workflowId, runId: handle.firstExecutionRunId, alreadyRunning: false };
    } catch (error) {
      if (error instanceof WorkflowExecutionAlreadyStartedError) {
        // 冪等な再送。既存の実行をそのまま使う。
        const handle = this.#client.workflow.getHandle(workflowId);
        const description = await handle.describe();
        return { workflowId, runId: description.runId, alreadyRunning: true };
      }
      throw error;
    }
  }

  async approve(
    workflowId: string,
    approvalId: string,
    decision: 'APPROVED' | 'REJECTED',
  ): Promise<void> {
    await this.#signal(workflowId, (handle) =>
      handle.signal(approveSignal, { approvalId, decision }),
    );
  }

  async instruct(workflowId: string, instruction: { requestId: string; text: string }): Promise<void> {
    await this.#signal(workflowId, (handle) => handle.signal(instructSignal, instruction));
  }

  async cancel(workflowId: string, reason: string): Promise<void> {
    await this.#signal(workflowId, (handle) => handle.signal(cancelSignal, { reason }));
  }

  async describe(workflowId: string): Promise<TaskStateSnapshot | null> {
    try {
      return await this.#client.workflow.getHandle(workflowId).query(getStateQuery);
    } catch (error) {
      if (error instanceof WorkflowNotFoundError) return null;
      return null;
    }
  }

  async #signal(
    workflowId: string,
    send: (handle: WorkflowHandle) => Promise<void>,
  ): Promise<void> {
    try {
      await send(this.#client.workflow.getHandle(workflowId));
    } catch (error) {
      if (error instanceof WorkflowNotFoundError) {
        // 既に終わっているタスクへの操作。状態不整合として返す。
        throw new GenieError('task.invalid_state', 'task is no longer running');
      }
      throw error;
    }
  }

  async close(): Promise<void> {
    if (this.#ownsConnection) await this.#client.connection.close();
  }
}
