import { boundedTaskTitle } from './task-title.js';
/**
 * Task サービス。実装仕様 §11・§6。
 *
 * HTTP を知らない。Fastify 型はここへ持ち込まない（ADR 0004）。
 */
import {
  ActionReceiptView,
  GenieError,
  Task,
  TaskInstruction,
  isTerminal,
  uuidv7,
  type AddTaskInstructionRequest,
  type CreateTaskRequest,
  type TaskStatus,
} from '@genie/contracts';
import { sql } from 'kysely';
import { withTenant, type DbHandle, type ScopedDb } from '@genie/db';
import { TaskProgressPayload, type TaskCurrentStep, type TaskListItem } from '@genie/contracts';
import { appendAuditEvent } from '@genie/telemetry';
import { ensureStream, readEventsAfter } from './events.js';
import { isKnownTaskKind, type TaskPlan } from './plan.js';
import {
  AgentNotRunnableError,
  parseAgentKind,
  planInstalledAgent,
  type InstalledAgent,
} from './agent-plan.js';
import { workflowIdFor, type TaskRuntime } from './runtime/index.js';

export interface CreateTaskParams {
  readonly tenantId: string;
  readonly userId: string;
  readonly request: CreateTaskRequest;
  readonly idempotencyKey: string;
}

export interface CreateTaskResult {
  readonly task: Task;
  /** 既存の冪等キーに当たったか。true なら新しい実行は起きていない。 */
  readonly deduplicated: boolean;
}

/**
 * install した plugin の agent を引く先。
 *
 * task が plugin-registry を直接持つと循環するので、口だけを切ってある。
 * 誰が実装を渡すかは組み立て側（gateway / worker）の判断（ADR 0001）。
 */
export interface AgentResolver {
  resolve(tenantId: string, kind: string): Promise<InstalledAgent | null>;
}

export class TaskService {
  readonly #db: DbHandle;
  readonly #runtime: TaskRuntime;
  readonly #agents: AgentResolver | undefined;

  constructor(db: DbHandle, runtime: TaskRuntime, agents?: AgentResolver) {
    this.#db = db;
    this.#runtime = runtime;
    this.#agents = agents;
  }

  /**
   * タスクを受理する。
   *
   * 二重防御（実装仕様 §6.2）:
   *   1. `tasks_idempotency` の一意制約で API 層が弾く
   *   2. Temporal の workflow id 一意性で実行層が弾く
   *
   * DB のコミット後にワークフローを起動する。逆順にすると、行が見える前に
   * activity が走って「知らないタスク」を更新しに行く。
   */
  async create(params: CreateTaskParams): Promise<CreateTaskResult> {
    // 計画は**ここで**確定させる（D-40）。workflow は決定的でなければならず、
    // install した agent は DB を読まないと分からないため。
    const plan = await this.#planFor(params);

    const taskId = uuidv7();
    const workflowId = workflowIdFor(params.tenantId, taskId);

    const stored = await withTenant(this.#db, params.tenantId, async (tx) => {
      const inserted = await tx
        .insertInto('tasks')
        .values({
          id: taskId,
          tenant_id: params.tenantId,
          created_by: params.userId,
          conversation_id: params.request.conversation_id ?? null,
          kind: params.request.kind,
          // 名前の無い仕事を作らない。頼んだ言葉から付ける（workflow が後で上書きしてよい）
          title: params.request.title ?? titleFrom(params.request.input),
          status: 'PENDING',
          input: JSON.stringify(params.request.input),
          plan: plan === null ? null : JSON.stringify(plan),
          idempotency_key: params.idempotencyKey,
          workflow_id: workflowId,
        })
        .onConflict((oc) => oc.columns(['tenant_id', 'created_by', 'idempotency_key']).doNothing())
        .returning(['id'])
        .executeTakeFirst();

      if (!inserted) {
        // 同じ冪等キーの再送。既存のタスクをそのまま返す。
        const existing = await tx
          .selectFrom('tasks')
          .selectAll()
          .where('created_by', '=', params.userId)
          .where('idempotency_key', '=', params.idempotencyKey)
          .executeTakeFirstOrThrow();
        return { row: existing, created: false };
      }

      await ensureStream(tx, params.tenantId, 'task', taskId);
      await appendAuditEvent(tx, params.tenantId, {
        actorType: 'user',
        actorId: params.userId,
        action: 'task.created',
        taskId,
        payload: { kind: params.request.kind },
      });

      const row = await tx
        .selectFrom('tasks')
        .selectAll()
        .where('id', '=', taskId)
        .executeTakeFirstOrThrow();
      return { row, created: true };
    });

    // 起動はコミット後。冪等キーの再送でも、まだ起動していなければ起動を試みる
    // （Temporal 側が二重起動を弾くので、ここで再試行しても安全）。
    if (stored.row.status === 'PENDING') {
      await this.#runtime.start(
        {
          taskId: stored.row.id,
          tenantId: params.tenantId,
          userId: params.userId,
          kind: stored.row.kind,
          input: (stored.row.input ?? {}) as Record<string, unknown>,
          // 再送では既存行の計画を使う。作り直すと、install 内容が変わった
          // あとの再送で別の計画が走ってしまう。
          ...(stored.row.plan ? { plan: stored.row.plan as unknown as TaskPlan } : {}),
        },
        stored.row.workflow_id,
      );
    }

    return { task: toTask(stored.row), deduplicated: !stored.created };
  }

  /**
   * 計画を確定させる。
   *
   * 組み込みの種別は `plan.ts` が決める（純粋関数）。
   * `plugin:<id>:<agent>` は install 済みの宣言から組み立てる。
   * どちらでもない種別は、ここで断る。**走らせてから気づかない。**
   */
  async #planFor(params: CreateTaskParams): Promise<TaskPlan | null> {
    const kind = params.request.kind;
    if (isKnownTaskKind(kind)) {
      // 組み込みは workflow 側で同じ計画が導ける。保存しない。
      return null;
    }

    const parsed = parseAgentKind(kind);
    if (!parsed || !this.#agents) {
      throw new GenieError('task.unknown_kind', `unknown task kind: ${kind}`);
    }

    const agent = await this.#agents.resolve(params.tenantId, kind);
    if (!agent) {
      // uninstall 済み / 未 install。「無い」として断る（AC5-6）。
      throw new GenieError('task.unknown_kind', `unknown task kind: ${kind}`);
    }

    try {
      return planInstalledAgent(agent, params.request.input);
    } catch (error) {
      if (error instanceof AgentNotRunnableError) {
        throw new GenieError('plugin.permission_denied', error.message, {
          details: { missing_scopes: error.missing },
        });
      }
      throw error;
    }
  }

  /** Read-only acceptance reconciliation. Never dispatches a pending workflow. */
  async findByConversationTurn(
    tenantId: string,
    userId: string,
    conversationId: string,
    turnId: string,
  ): Promise<string | null> {
    return withTenant(this.#db, tenantId, async (tx) => {
      const task = await tx
        .selectFrom('tasks')
        .select('id')
        .where('tenant_id', '=', tenantId)
        .where('created_by', '=', userId)
        .where('conversation_id', '=', conversationId)
        .where('idempotency_key', '=', `turn:${turnId}`)
        .executeTakeFirst();
      return task?.id ?? null;
    });
  }

  async get(tenantId: string, taskId: string): Promise<Task> {
    return withTenant(this.#db, tenantId, async (tx) => toTask(await loadTask(tx, taskId)));
  }

  /** いま答えを待っている承認。端末が確認カードから答えるために読む。 */
  async pendingApprovals(
    tenantId: string,
    taskId: string,
  ): Promise<
    { id: string; summary: string; risk: string; expires_at: string; details: unknown }[]
  > {
    return withTenant(this.#db, tenantId, async (tx) => {
      await loadTask(tx, taskId);
      const rows = await tx
        .selectFrom('approvals')
        .select(['id', 'summary', 'risk', 'expires_at', 'details'])
        .where('task_id', '=', taskId)
        .where('status', '=', 'PENDING')
        .orderBy('step_index')
        .execute();
      return rows.map((r) => ({
        id: r.id,
        summary: r.summary,
        risk: r.risk,
        expires_at: r.expires_at.toISOString(),
        details: r.details,
      }));
    });
  }

  async list(
    tenantId: string,
    limit: number,
    cursor?: string,
  ): Promise<{ items: TaskListItem[]; nextCursor: string | null }> {
    return withTenant(this.#db, tenantId, async (tx) => {
      let statement = tx
        .selectFrom('tasks')
        .selectAll()
        .orderBy('id', 'desc')
        .limit(limit + 1);
      if (cursor) statement = statement.where('id', '<', cursor);

      const rows = await statement.execute();
      const page = rows.slice(0, limit);
      const steps = await currentSteps(
        tx,
        page.map((row) => row.id),
      );
      return {
        items: page.map((row) => ({ ...toTask(row), current_step: steps.get(row.id) ?? null })),
        nextCursor: rows.length > limit ? (page.at(-1)?.id ?? null) : null,
      };
    });
  }

  /**
   * この仕事の受け取りの控え。UI/UX §22・§14.1。
   *
   * **人が読める文面は、承認したときに読んだものが正。**
   * approvals.summary へ step_index で辿る。承認が要らなかった write は
   * 文面が無いので null のまま返す。ここで作文しない。
   */
  async receipts(tenantId: string, taskId: string): Promise<ActionReceiptView[]> {
    return withTenant(this.#db, tenantId, async (tx) => {
      // 存在しない / 他テナントなら 404。receipt の有無で存在を漏らさない。
      await loadTask(tx, taskId);

      const rows = await tx
        .selectFrom('action_receipts as r')
        .leftJoin('approvals as a', (join) =>
          join
            .onRef('a.task_id', '=', 'r.task_id')
            .onRef('a.step_index', '=', 'r.step_index')
            .on('a.status', '=', 'APPROVED'),
        )
        .leftJoin('users as u', 'u.id', 'r.approved_by')
        .select([
          'r.id',
          'r.task_id',
          'r.tool_id',
          'r.actor',
          'r.risk',
          'r.result_ref',
          'r.reversible_until',
          'r.executed_at',
          'a.summary',
          'u.display_name',
        ])
        .where('r.task_id', '=', taskId)
        .orderBy('r.executed_at', 'desc')
        .execute();

      return rows.map((row) =>
        ActionReceiptView.parse({
          id: row.id,
          task_id: row.task_id,
          summary: row.summary,
          risk: row.risk,
          actor: row.actor,
          approved_by_name: row.display_name,
          executed_at: row.executed_at.toISOString(),
          reversible_until: row.reversible_until?.toISOString() ?? null,
          result_ref: row.result_ref,
          tool_id: row.tool_id,
        }),
      );
    });
  }

  /**
   * 動いている仕事へ追加指示を渡す（「あと、テストも追加して」）。
   *
   * 返すのは**受け取った**という事実（RECEIVED）。反映したかどうかは workflow が次の段の前で決め、
   * `listInstructions` で APPLIED（どの段で）か NOT_APPLIED として分かる。
   * 終わった・止めている途中の仕事には足さない（続きの仕事として頼んでもらう）。
   * 同じ request_id の送り直しは、最初の 1 件をそのまま返す（本文が違えば断る）。
   */
  async addInstruction(
    tenantId: string,
    taskId: string,
    userId: string,
    request: AddTaskInstructionRequest,
  ): Promise<TaskInstruction> {
    const text = request.text.trim();
    const { row, fresh, workflowId } = await withTenant(this.#db, tenantId, async (tx) => {
      const task = await loadTask(tx, taskId, true);
      const existing = await tx
        .selectFrom('task_instructions')
        .selectAll()
        .where('task_id', '=', taskId)
        .where('request_id', '=', request.request_id)
        .executeTakeFirst();
      if (existing) {
        if (existing.text !== text)
          throw new GenieError('task.idempotency_conflict', 'この request_id は別の指示に使われています');
        return { row: existing as InstructionRow, fresh: false, workflowId: task.workflow_id };
      }
      if (isTerminal(task.status as TaskStatus) || task.status === 'CANCELLING') {
        throw new GenieError(
          'task.invalid_state',
          'この仕事はもう終わっています。続きは新しい仕事として頼んでください。',
        );
      }
      const inserted = await tx
        .insertInto('task_instructions')
        .values({
          tenant_id: tenantId,
          task_id: taskId,
          request_id: request.request_id,
          created_by: userId,
          text,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      return { row: inserted as InstructionRow, fresh: true, workflowId: task.workflow_id };
    });

    if (fresh) {
      try {
        await this.#runtime.instruct(workflowId, { requestId: request.request_id, text });
      } catch {
        // 渡せなかった（workflow が既に終わっていた等）。受け取ったままにせず、反映できなかったと残す。
        await withTenant(this.#db, tenantId, (tx) =>
          tx
            .updateTable('task_instructions')
            .set({ status: 'NOT_APPLIED', resolved_at: new Date() })
            .where('task_id', '=', taskId)
            .where('request_id', '=', request.request_id)
            .where('status', '=', 'RECEIVED')
            .execute(),
        );
        return (await this.listInstructions(tenantId, taskId)).find(
          (i) => i.request_id === request.request_id,
        )!;
      }
    }
    return toInstruction(row, false);
  }

  /** 追加指示の一覧。仕事が終わっても受け取ったままのものは、反映できなかったとして返す。 */
  async listInstructions(tenantId: string, taskId: string): Promise<TaskInstruction[]> {
    return withTenant(this.#db, tenantId, async (tx) => {
      const task = await loadTask(tx, taskId);
      const rows = await tx
        .selectFrom('task_instructions')
        .selectAll()
        .where('task_id', '=', taskId)
        .orderBy('created_at', 'asc')
        .execute();
      const finished = isTerminal(task.status as TaskStatus);
      return rows.map((row) => toInstruction(row as InstructionRow, finished));
    });
  }

  /** 取消要求。実際の終了はワークフローが決めるので、ここでは CANCELLING までしか進めない。 */
  async cancel(tenantId: string, taskId: string, reason: string): Promise<Task> {
    const row = await withTenant(this.#db, tenantId, async (tx) => {
      const task = await loadTask(tx, taskId, true);
      if (isTerminal(task.status as TaskStatus)) {
        throw new GenieError('task.invalid_state', `task is already ${task.status}`);
      }
      await tx
        .updateTable('tasks')
        .set({ status: 'CANCELLING', updated_at: new Date() })
        .where('id', '=', taskId)
        .execute();
      return task;
    });

    await this.#runtime.cancel(row.workflow_id, reason);
    return this.get(tenantId, taskId);
  }

  /** 承認の決定を反映する。実装仕様 §3.4。 */
  async decideApproval(
    tenantId: string,
    taskId: string,
    userId: string,
    approvalId: string,
    decision: 'APPROVED' | 'REJECTED',
  ): Promise<void> {
    const workflowId = await withTenant(this.#db, tenantId, async (tx) => {
      const task = await loadTask(tx, taskId);
      const approval = await tx
        .selectFrom('approvals')
        .select(['id', 'status', 'expires_at'])
        .where('id', '=', approvalId)
        .where('task_id', '=', taskId)
        .executeTakeFirst();

      if (!approval) throw new GenieError('approval.not_found', 'no such approval');
      if (approval.status !== 'PENDING') {
        throw new GenieError('approval.already_decided', `approval is ${approval.status}`);
      }
      if (approval.expires_at.getTime() <= Date.now()) {
        await tx
          .updateTable('approvals')
          .set({ status: 'EXPIRED' })
          .where('id', '=', approvalId)
          .execute();
        throw new GenieError('approval.expired', 'approval expired');
      }

      await tx
        .updateTable('approvals')
        .set({ status: decision, decided_by: userId, decided_at: new Date() })
        .where('id', '=', approvalId)
        .execute();

      return task.workflow_id;
    });

    await this.#runtime.approve(workflowId, approvalId, decision);
  }

  /** SSE のリプレイ用（実装仕様 §7.3）。 */
  async eventsAfter(tenantId: string, taskId: string, after: number) {
    return withTenant(this.#db, tenantId, async (tx) => {
      await loadTask(tx, taskId);
      return readEventsAfter(tx, 'task', taskId, after);
    });
  }
}

type TaskRow = {
  id: string;
  tenant_id: string;
  created_by: string;
  conversation_id: string | null;
  kind: string;
  title: string | null;
  status: string;
  input: unknown;
  result_artifact_id: string | null;
  error: unknown;
  workflow_id: string;
  created_at: Date;
  started_at: Date | null;
  completed_at: Date | null;
  updated_at: Date;
};

type InstructionRow = {
  task_id: string;
  request_id: string;
  text: string;
  status: string;
  applied_step_index: number | null;
  created_at: Date;
  resolved_at: Date | null;
};

function toInstruction(row: InstructionRow, taskFinished: boolean): TaskInstruction {
  // 仕事が終わったのに受け取ったまま = 反映する段が残っていなかった。
  const status = row.status === 'RECEIVED' && taskFinished ? 'NOT_APPLIED' : row.status;
  return TaskInstruction.parse({
    task_id: row.task_id,
    request_id: row.request_id,
    text: row.text,
    status,
    applied_step_index: row.applied_step_index,
    created_at: row.created_at.toISOString(),
    resolved_at: row.resolved_at?.toISOString() ?? null,
  });
}

async function loadTask(tx: ScopedDb, taskId: string, lock = false): Promise<TaskRow> {
  const query = tx.selectFrom('tasks').selectAll().where('id', '=', taskId);
  // Serialize cancel's read/check/write with terminal activity updates.
  const row = await (lock ? query.forUpdate() : query).executeTakeFirst();
  // RLS で他テナントの行は見えない。ここに来る「無い」は 404 で正しい（逸脱 D-11）
  if (!row) throw new GenieError('task.not_found', `no task ${taskId}`);
  return row as TaskRow;
}

function toTask(row: TaskRow): Task {
  return Task.parse({
    id: row.id,
    tenant_id: row.tenant_id,
    created_by: row.created_by,
    conversation_id: row.conversation_id,
    kind: row.kind,
    title: boundedTaskTitle(row.title),
    status: row.status,
    input: row.input ?? {},
    result_artifact_id: row.result_artifact_id,
    error: row.error ?? null,
    created_at: row.created_at.toISOString(),
    started_at: row.started_at?.toISOString() ?? null,
    completed_at: row.completed_at?.toISOString() ?? null,
    updated_at: row.updated_at.toISOString(),
  });
}

/**
 * 頼んだ言葉から題名を作る。UI/UX §8・§9。
 *
 * title 無しで作った仕事は、workflow が始まるまで `null` のままで、
 * Home に「名前のない仕事」と出ていた。**最初から名前を持たせる。**
 * 何も無ければ null のまま（作り話の題名を付けない）。
 */
export function titleFrom(input: Record<string, unknown>): string | null {
  for (const key of ['title', 'question', 'message', 'instruction']) {
    const value = input[key];
    if (typeof value === 'string' && value.trim().length > 0) {
      const line = value.trim().split('\n')[0]!.trim();
      return line.length <= 40 ? line : `${line.slice(0, 39)}…`;
    }
  }
  return null;
}

/**
 * 一覧の各行に添える「いま進めている段」。UI/UX §9.1。
 *
 * 行ごとに stream を読むと N+1 になるので、進行中の仕事の
 * **最新の task.progress だけ**を 1 回で引く。終わった仕事には付けない
 * （終わったのに「調査中」と出るのが、いちばん信用を失う）。
 */
export async function currentSteps(
  tx: ScopedDb,
  taskIds: readonly string[],
): Promise<Map<string, TaskCurrentStep>> {
  const out = new Map<string, TaskCurrentStep>();
  if (taskIds.length === 0) return out;
  const rows = await sql<{ stream_id: string; payload: unknown; status: string }>`
    select distinct on (e.stream_id) e.stream_id, e.payload, t.status
      from task_events e
      join tasks t on t.id = e.stream_id
     where e.stream_kind = 'task'
       and e.type = 'task.progress'
       and e.stream_id in (${sql.join(taskIds)})
     order by e.stream_id, e.sequence desc
  `.execute(tx);
  for (const row of rows.rows) {
    if (row.status !== 'RUNNING' && row.status !== 'PAUSED_HOST_OFFLINE') continue;
    const parsed = TaskProgressPayload.safeParse(row.payload);
    if (!parsed.success) continue;
    out.set(row.stream_id, {
      message: parsed.data.message,
      detail: parsed.data.detail,
      retrying: parsed.data.retrying,
    });
  }
  return out;
}
