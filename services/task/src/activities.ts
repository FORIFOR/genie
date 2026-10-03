import { boundedTaskTitle } from './task-title.js';
/**
 * activity の実装。実装仕様 §6.4。
 *
 * すべて冪等。Temporal は activity を再実行し得るので、
 * 「2 回走っても結果が変わらない」ことを DB の制約で担保する。
 */
import { ApplicationFailure } from '@temporalio/common';
import {
  canonicalSha256,
  handoffExplanation,
  isHostOfflineError,
  HostOfflineError,
  validateTransactionSubmitArgs,
  TransactionSubmitArgs,
  uuidv7,
  type ActionRisk,
  type EscalationStep,
  type EscalationTrail,
} from '@genie/contracts';
import {
  isTransactionAuthorizationApprovalActive,
  withTenant,
  type DbHandle,
  type ScopedDb,
} from '@genie/db';
import { appendAuditEvent } from '@genie/telemetry';
import { approvalTtlMs, evaluate, isApprovalUsable, type ActionContext } from '@genie/policy';
import type { PolicyDocument } from '@genie/contracts';
import type { LibraryService } from '@genie/service-library';
import { appendEvent, type EventPublisher } from './events.js';
import { formatCheckoutArtifact } from './checkout-artifact.js';
import { formatOfficeArtifact } from './office-artifact.js';
import { formatTransactionArtifact } from './transaction-artifact.js';
import { TransactionAuthorizationService } from './transaction-authorizations.js';
import { approvalSummaryFor, requiresSingleAttempt, isMeteredStep, type TaskStep } from './plan.js';
import type {
  ArtifactSpec,
  RequestedApproval,
  StartTaskMeta,
  TaskActivities,
  TaskErrorPayload,
  UnknownTransactionResult,
  FailureFinalization,
} from './activity-types.js';
import type { TaskWorkflowInput, TaskResult } from './workflows.js';

function storedInputsHash(details: unknown): unknown {
  return details && typeof details === 'object'
    ? (details as Record<string, unknown>)['inputsHash']
    : undefined;
}

/** Runs outside the deterministic workflow: bind the displayed quote, its expiry, and exact dispatch args. */
async function transactionApprovalBinding(step: TaskStep, now: Date) {
  if (step.toolId !== 'transaction.submit') return null;
  if (step.risk !== 'FINANCIAL' || step.surface !== 'local' || step.requiresConfirmation !== true) {
    throw ApplicationFailure.nonRetryable(
      '注文には金額を確認する承認が必要です。',
      'ValidationError',
    );
  }
  try {
    const args = await validateTransactionSubmitArgs(step.args, now.getTime());
    return {
      inputsHash: await canonicalSha256(step.args),
      expiresAt: Date.parse(args.quote.expiresAt),
    };
  } catch {
    throw ApplicationFailure.nonRetryable(
      '見積もりが無効、変更済み、または期限切れです。新しい見積もりを確認してください。',
      'ValidationError',
    );
  }
}

/**
 * 1 つの step を実際にやる人。
 *
 * task-service は「何をどの順でやるか」だけを持ち、中身は知らない。
 * research などの実装をここに直接書くと、task が全ドメインを抱えることになる。
 */
export interface StepExecutor {
  execute(
    input: TaskWorkflowInput,
    step: TaskStep,
  ): Promise<{
    result: unknown;
    /** 進捗に添える一言（UI/UX §6.1 の「12 sources」）。 */
    detail?: string | null;
    /** 成果物を自分で組み立てた step はここに置く。 */
    artifact?: { title: string; markdown: string };
  }>;

  /**
   * step が失敗したときの後始末。
   *
   * **自分の領域の状態を FAILED にするのはここ。**task が FAILED になっても、
   * `research_runs` や `meetings` が進行中のまま残ると、
   * その画面では永久に「処理中」に見える（D-46 と同じ話）。
   *
   * ここが投げても、元の失敗は握りつぶさない。
   */
  onFailure?(input: TaskWorkflowInput, step: TaskStep, error: unknown): Promise<void>;
}

export interface ActivityDeps {
  readonly db: DbHandle;
  readonly library: LibraryService;
  readonly publisher: EventPublisher;
  /** tool id から引く。無ければ何もしない step として扱う。 */
  readonly executors?: Readonly<Record<string, StepExecutor>>;
  /**
   * `surface: 'local'` の step を手元で実行する先（Host Bridge）。
   * **未接続なら local の step は実行しない。**クラウドで代わりに走らせない。
   */
  readonly hostExecutor?: StepExecutor;
  /**
   * 端末が居るかを答えるもの（Host Bridge）。
   * **未接続なら「居ない」と答える。**居ると仮定して進めない。
   */
  readonly hosts?: { hasOnlineHost(tenantId: string, userId: string): Promise<boolean> };
  /**
   * いまどの step を走らせているかを知らせる先。
   *
   * 言語モデルの呼び出しは step の**中**で起きるので、
   * 受け渡しに載せるには「どの task の何段目か」が要る。
   * ここで置かないと、モデルは自分がどの仕事の一部か分からない。
   */
  /** Scope model context to this async execution, including overlapping users/tasks. */
  readonly withStepContext?: <T>(
    where: { taskId: string; tenantId: string; userId: string; stepIndex: number },
    run: () => Promise<T>,
  ) => Promise<T>;
  readonly onStep?: (where: {
    taskId: string;
    tenantId: string;
    userId: string;
    stepIndex: number;
  }) => void;
  /**
   * 正本 §24 の下から 2 段。**繋いでいなければ「使えない」と言う。**
   *
   *   API connector fail → retry → alternate connector
   *   → browser structured automation → screen automation → user handoff
   *
   * 黙って user handoff まで落ちると、利用者には
   * 「なぜ手でやらされるのか」が分からない。
   * 「試したが駄目だった」と「試せる手段が無かった」は、別のこと。
   */
  readonly automation?: {
    readonly browser?: StepExecutor;
    readonly screen?: StepExecutor;
  };
  /** 監査に載せるアプリ版など、将来の付帯情報 */
  readonly now?: () => Date;
}

/**
 * step から policy の入力を作る。
 *
 * **ここを固定値にしない。**`complianceProfile: 'GENERAL'` を書き込んでいた間、
 * 規制区分の plugin も一般として評価され、正本 §22 の追加ゲート
 * （write-back の明示承認・参照の監査）が一度も効いていなかった。
 * `requires_confirmation` も同じで、manifest で検証されるだけで効いていなかった。
 */
function policyContextFor(step: TaskStep): ActionContext {
  return {
    risk: step.risk as ActionRisk,
    surface: step.surface,
    toolId: step.toolId,
    // 省略は GENERAL。組み込みの kind はこれでよい。
    complianceProfile: step.complianceProfile ?? 'GENERAL',
    ...(step.requiresConfirmation === undefined
      ? {}
      : { toolRequiresConfirmation: step.requiresConfirmation }),
    ...(step.policies ? { policies: step.policies as PolicyDocument[] } : {}),
  };
}

/** 登った跡と、たどり着いた結果。 */
interface Escalation {
  readonly outcome: Awaited<ReturnType<StepExecutor['execute']>> | null;
  readonly trail: EscalationTrail;
}

/**
 * 正本 §24 の梯子を、上から順に登る。
 *
 *   retry（Temporal が済ませている）
 *   → alternate connector
 *   → browser structured automation
 *   → screen automation
 *   → user handoff
 *
 * **段を飛ばしたことを黙らない。**使えない段は `unavailable` として
 * 理由と一緒に残す。「試したが駄目だった」と「試せる手段が無かった」を
 * 呼び出し側が区別できなければ、利用者にも説明できない。
 */
async function escalate(
  input: TaskWorkflowInput,
  step: TaskStep,
  deps: ActivityDeps,
): Promise<Escalation> {
  const steps: EscalationStep[] = [
    // ここへ来た時点で、Temporal の再試行は済んでいる
    { rung: 'retry', outcome: 'failed', reason: null },
  ];

  // ---- alternate connector（宣言された代替）
  const declared = step.fallbacks ?? [];
  const runnable = declared.filter((toolId) => deps.executors?.[toolId] !== undefined);
  if (declared.length === 0) {
    steps.push({
      rung: 'alternate_connector',
      outcome: 'unavailable',
      reason: 'この操作に代わりの経路が宣言されていません',
    });
  } else if (runnable.length === 0) {
    // **宣言はあるのに動かせない**を、宣言が無いのと同じにしない
    steps.push({
      rung: 'alternate_connector',
      outcome: 'unavailable',
      reason: '宣言された代わりの経路が、この環境で動きません',
    });
  } else {
    let succeeded = false;
    for (const toolId of runnable) {
      try {
        const result = await deps.executors![toolId]!.execute(input, { ...step, toolId });
        steps.push({ rung: 'alternate_connector', outcome: 'succeeded', reason: null });
        succeeded = true;
        return { outcome: result, trail: { steps } };
      } catch {
        // 次の代替へ
      }
    }
    if (!succeeded) {
      steps.push({ rung: 'alternate_connector', outcome: 'failed', reason: null });
    }
  }

  // ---- browser structured automation / screen automation
  const automation = [
    { rung: 'browser_automation' as const, executor: deps.automation?.browser },
    { rung: 'screen_automation' as const, executor: deps.automation?.screen },
  ];
  for (const { rung, executor } of automation) {
    if (!executor) {
      steps.push({
        rung,
        outcome: 'unavailable',
        // **持っていないものを、試して駄目だったことにしない**
        reason: 'この環境に繋がっていません',
      });
      continue;
    }
    try {
      const result = await executor.execute(input, step);
      steps.push({ rung, outcome: 'succeeded', reason: null });
      return { outcome: result, trail: { steps } };
    } catch {
      steps.push({ rung, outcome: 'failed', reason: null });
    }
  }

  // ---- user handoff
  steps.push({ rung: 'user_handoff', outcome: 'not_reached', reason: null });
  return { outcome: null, trail: { steps } };
}

/** 元の失敗の文言。包み直しても、本当の理由を残す。 */
function messageOfCause(error: unknown): string {
  return error instanceof Error && error.message ? error.message : String(error);
}

/**
 * 端末側の executor が投げる「止めたので取り下げた」の名前。
 * この service は agent-host に依存しない（executor は外から渡される）ので、名前で見分ける。
 */
const HOST_STEP_CANCELLED_TYPE = 'HostStepCancelled';

function isHostStepCancelled(error: unknown): boolean {
  return error instanceof Error && error.name === HOST_STEP_CANCELLED_TYPE;
}

const stepKey = (taskId: string, index: number, name: string): string =>
  `${taskId}:${index}:${name}`;

/** PostgreSQL の外部キー違反。 */
const FOREIGN_KEY_VIOLATION = '23503';

/**
 * 「もう存在しないタスク」への操作を、**再試行しない失敗**に変える。
 *
 * これが無いと、テナントやタスクが消えたあとも activity が永久に再試行し続け、
 * worker の枠を食い潰す。使い捨て DB で動かしたあと実際にそうなった。
 */
function taskGone(cause: unknown): never {
  throw ApplicationFailure.nonRetryable(
    `the task this activity belongs to no longer exists (${String(cause)})`,
    'TaskGone',
  );
}

function isMissingParent(error: unknown): boolean {
  return (error as { code?: string } | null)?.code === FOREIGN_KEY_VIOLATION;
}

export function createTaskActivities(deps: ActivityDeps): TaskActivities {
  const now = deps.now ?? (() => new Date());
  const authorizations = new TransactionAuthorizationService({ db: deps.db, now });

  const inTenant = async <T>(
    input: TaskWorkflowInput,
    fn: (tx: ScopedDb) => Promise<T>,
  ): Promise<T> => {
    try {
      return await withTenant(deps.db, input.tenantId, fn);
    } catch (error) {
      // 親が消えているなら、何度やっても同じ。止める。
      if (isMissingParent(error)) taskGone(error);
      throw error;
    }
  };

  return {
    async startTask(input, meta: StartTaskMeta) {
      await inTenant(input, async (tx) => {
        const updated = await tx
          .updateTable('tasks')
          .set({
            status: 'RUNNING',
            title: boundedTaskTitle(meta.title),
            run_id: meta.run_id,
            started_at: now(),
            updated_at: now(),
          })
          .where('id', '=', input.taskId)
          // 終端に達したタスクを掘り起こさない（状態遷移表。実装仕様 §3.3）
          .where('status', 'in', ['PENDING', 'RUNNING'])
          .returning('id')
          .executeTakeFirst();
        if (!updated) return;

        await appendEvent(
          tx,
          {
            tenantId: input.tenantId,
            streamKind: 'task',
            streamId: input.taskId,
            taskId: input.taskId,
            type: 'task.started',
            payload: {
              kind: meta.kind,
              title: boundedTaskTitle(meta.title),
              step_count: meta.step_count,
            },
            idempotencyKey: stepKey(input.taskId, -1, 'started'),
          },
          deps.publisher,
        );
      });
    },

    async requestApprovalIfNeeded(input, step: TaskStep): Promise<RequestedApproval | null> {
      const decision = evaluate(policyContextFor(step));
      if (!decision.requiresApproval) return null;
      const binding = await transactionApprovalBinding(step, now());

      if (binding && !decision.denied) {
        const card = approvalSummaryFor(step);
        const derived = await authorizations.deriveApproval({
          tenantId: input.tenantId,
          userId: input.userId,
          taskId: input.taskId,
          stepIndex: step.index,
          args: step.args,
          summary: card.summary,
          details: { items: card.details, impact: card.impact },
        });
        if (derived) return null;
      }

      return inTenant(input, async (tx) => {
        const existing = await tx
          .selectFrom('approvals')
          .select(['id', 'status', 'details', 'expires_at'])
          .where('task_id', '=', input.taskId)
          .where('step_index', '=', step.index)
          .executeTakeFirst();
        if (
          binding &&
          existing &&
          (storedInputsHash(existing.details) !== binding.inputsHash ||
            existing.expires_at.getTime() <= now().getTime())
        ) {
          throw ApplicationFailure.nonRetryable(
            '注文内容または期限が承認時と一致しません。新しい見積もりを確認してください。',
            'ApprovalStale',
          );
        }
        // 承認後にタスクを再開したとき、同じ step で再び確認を要求しない。
        // 以前は status を見ずに既存IDを返していたため、再開直後に
        // 「この操作には確認が必要です」で止まり、承認が実行へ進まなかった。
        if (existing?.status === 'APPROVED') return null;
        if (existing)
          return {
            approvalId: existing.id,
            ...(binding
              ? { timeoutMs: Math.max(1, existing.expires_at.getTime() - now().getTime()) }
              : {}),
          };

        const approvalId = uuidv7();
        const expiresAt = new Date(
          Math.min(
            now().getTime() + approvalTtlMs(step.risk as ActionRisk),
            binding?.expiresAt ?? Infinity,
          ),
        );
        const card = approvalSummaryFor(step);

        await tx
          .insertInto('approvals')
          .values({
            id: approvalId,
            tenant_id: input.tenantId,
            task_id: input.taskId,
            step_index: step.index,
            risk: step.risk,
            summary: card.summary,
            details: JSON.stringify({
              items: card.details,
              impact: card.impact,
              ...(binding
                ? { inputsHash: binding.inputsHash, transactionSubmitArgs: step.args }
                : {}),
            }),
            editable_fields: JSON.stringify([]),
            status: 'PENDING',
            expires_at: expiresAt,
            created_at: now(),
          })
          .execute();

        await tx
          .updateTable('tasks')
          .set({ status: 'WAITING_APPROVAL', updated_at: now() })
          .where('id', '=', input.taskId)
          .where('status', '=', 'RUNNING')
          .execute();

        await appendEvent(
          tx,
          {
            tenantId: input.tenantId,
            streamKind: 'task',
            streamId: input.taskId,
            taskId: input.taskId,
            type: 'task.waiting_approval',
            payload: {
              approval_id: approvalId,
              risk: step.risk,
              summary: card.summary,
              primary_action_label: card.impact.primary_action_label,
              expires_at: expiresAt.toISOString(),
            },
            idempotencyKey: stepKey(input.taskId, step.index, 'approval'),
          },
          deps.publisher,
        );

        await appendAuditEvent(tx, input.tenantId, {
          actorType: 'agent',
          action: 'approval.requested',
          taskId: input.taskId,
          payload: { approval_id: approvalId, risk: step.risk },
        });

        return {
          approvalId,
          ...(binding ? { timeoutMs: Math.max(1, expiresAt.getTime() - now().getTime()) } : {}),
        };
      });
    },

    async applyInstructions(input, requestIds, stepIndex) {
      if (requestIds.length === 0) return;
      await inTenant(input, (tx) =>
        tx
          .updateTable('task_instructions')
          .set({ status: 'APPLIED', applied_step_index: stepIndex, resolved_at: now() })
          .where('task_id', '=', input.taskId)
          .where('request_id', 'in', [...requestIds])
          // 合図の返事が失われて「反映できなかった」と記録した後に、実際には届いて反映した場合も直す。
          .where('status', 'in', ['RECEIVED', 'NOT_APPLIED'])
          .execute(),
      );
    },

    async acceptApproval(input, approvalId) {
      await inTenant(input, async (tx) => {
        /*
         * 古い承認で実行しない（正本 §25「stale approval」）。
         *
         * FINANCIAL の期限が 5 分なのは価格が動くから。
         * 決めた時点では正しかった承認でも、再開が遅れれば別の話になる。
         * **決まっていることと、いま有効であることは違う。**
         */
        const approval = await tx
          .selectFrom('approvals')
          .select(['status', 'expires_at'])
          .where('id', '=', approvalId)
          .executeTakeFirst();

        const usable =
          approval !== undefined &&
          isApprovalUsable({
            status: approval.status as 'PENDING' | 'APPROVED' | 'REJECTED' | 'EXPIRED',
            expiresAt: approval.expires_at.toISOString(),
          });
        if (!usable) {
          throw ApplicationFailure.nonRetryable(
            `approval ${approvalId} is no longer usable`,
            'ApprovalStale',
          );
        }

        await tx
          .updateTable('tasks')
          .set({ status: 'RUNNING', updated_at: now() })
          .where('id', '=', input.taskId)
          .where('status', '=', 'WAITING_APPROVAL')
          .execute();
        await appendAuditEvent(tx, input.tenantId, {
          actorType: 'user',
          action: 'approval.decided',
          taskId: input.taskId,
          payload: { approval_id: approvalId, decision: 'APPROVED' },
        });
      });
    },

    async rejectApproval(input, approvalId, stepIndex) {
      await inTenant(input, async (tx) => {
        await tx
          .updateTable('tasks')
          .set({ status: 'CANCELLED', completed_at: now(), updated_at: now() })
          .where('id', '=', input.taskId)
          .execute();
        await appendEvent(
          tx,
          {
            tenantId: input.tenantId,
            streamKind: 'task',
            streamId: input.taskId,
            taskId: input.taskId,
            type: 'task.cancelled',
            payload: { reason: 'approval_rejected' },
            idempotencyKey: stepKey(input.taskId, stepIndex, 'rejected'),
          },
          deps.publisher,
        );
        await appendAuditEvent(tx, input.tenantId, {
          actorType: 'user',
          action: 'approval.decided',
          taskId: input.taskId,
          payload: { approval_id: approvalId, decision: 'REJECTED' },
        });
      });
    },

    async expireApproval(input, approvalId) {
      await inTenant(input, async (tx) => {
        await tx
          .updateTable('approvals')
          .set({ status: 'EXPIRED' })
          .where('id', '=', approvalId)
          .where('status', '=', 'PENDING')
          .execute();
        await appendAuditEvent(tx, input.tenantId, {
          actorType: 'system',
          action: 'approval.expired',
          taskId: input.taskId,
          payload: { approval_id: approvalId },
        });
      });
    },

    async executeStep(input, step: TaskStep) {
      const decision = evaluate(policyContextFor(step));
      const binding = await transactionApprovalBinding(step, now());
      if (binding) {
        const task = await inTenant(input, (tx) =>
          tx.selectFrom('tasks').select('status').where('id', '=', input.taskId).executeTakeFirst(),
        );
        if (
          !task ||
          !['RUNNING', 'WAITING_APPROVAL', 'PAUSED_HOST_OFFLINE'].includes(task.status)
        ) {
          throw ApplicationFailure.nonRetryable(
            '停止済みのタスクから注文は送信しません。',
            'ApprovalStale',
          );
        }
        const instruction = await inTenant(input, (tx) =>
          tx
            .selectFrom('task_instructions')
            .select('request_id')
            .where('task_id', '=', input.taskId)
            .where('status', '=', 'RECEIVED')
            .executeTakeFirst(),
        );
        if (instruction)
          throw ApplicationFailure.nonRetryable(
            '追加指示を反映した新しい見積もりの確認が必要です。',
            'ApprovalStale',
          );
        const approved = await inTenant(input, (tx) =>
          tx
            .selectFrom('approvals')
            .select(['id', 'status', 'details', 'expires_at'])
            .where('task_id', '=', input.taskId)
            .where('step_index', '=', step.index)
            .executeTakeFirst(),
        );
        if (
          !approved ||
          approved.status !== 'APPROVED' ||
          approved.expires_at.getTime() <= now().getTime() ||
          storedInputsHash(approved.details) !== binding.inputsHash
        ) {
          throw ApplicationFailure.nonRetryable(
            'この注文内容に対する有効な承認がありません。',
            'ApprovalStale',
          );
        }
        const active = await inTenant(input, (tx) =>
          isTransactionAuthorizationApprovalActive(tx, {
            approvalId: approved.id,
            taskId: input.taskId,
            stepIndex: step.index,
            userId: input.userId,
            inputsHash: binding.inputsHash,
            now: now(),
          }),
        );
        if (!active)
          throw ApplicationFailure.nonRetryable(
            '任せていた設定が取り消されたか、期限を過ぎています。',
            'ApprovalStale',
          );
      }

      /*
       * 規則が「やらない」と言っているなら、承認を取っても実行しない（正本 §22）。
       * 規制領域では「確認すれば通る」ではなく「そもそもやらない」が要る。
       */
      if (decision.denied) {
        throw ApplicationFailure.nonRetryable(
          `${step.toolId} is not allowed here: ${decision.reasons.join(', ')}`,
          'PolicyDenied',
        );
      }
      const startedAt = Date.now();

      await inTenant(input, (tx) =>
        appendEvent(
          tx,
          {
            tenantId: input.tenantId,
            streamKind: 'task',
            streamId: input.taskId,
            taskId: input.taskId,
            type: 'tool.started',
            payload: {
              step_index: step.index,
              tool_id: step.toolId,
              risk: step.risk,
              surface: step.surface,
            },
            idempotencyKey: stepKey(input.taskId, step.index, 'tool.started'),
          },
          deps.publisher,
        ),
      );

      /*
       * local と宣言された tool を、クラウドで黙って実行しない。
       *
       * `surface` は正本 §16 の local-first の境界そのもので、
       * 「この操作は手元でしか動かない」という約束。ここを素通しすると、
       * **宣言だけの約束**になる。Host Bridge へ回す経路が繋がるまでは断る。
       */
      if (step.surface === 'local' && !deps.hostExecutor) {
        throw ApplicationFailure.nonRetryable(
          `${step.toolId} is declared local, but this worker has no host to run it on`,
          'LocalSurfaceUnavailable',
        );
      }

      /*
       * 規則が「手元でだけ」と言ったなら、cloud で動かさない。
       *
       * **宣言（surface）と規則（local_execution）は別の入口**で、
       * plugin が surface: cloud と書いていても、規則の方が厳しければ
       * 規則が勝つ。ここを見ないと、規則は書けるが効かないものになる。
       */
      if (decision.requiresLocalExecution && step.surface !== 'local') {
        throw ApplicationFailure.nonRetryable(
          `${step.toolId} must run on the device, but this step is declared cloud`,
          'LocalExecutionRequired',
        );
      }

      // step の中から呼ばれるもの（言語モデル）に、居場所を伝える
      deps.onStep?.({
        taskId: input.taskId,
        tenantId: input.tenantId,
        userId: input.userId,
        stepIndex: step.index,
      });

      const executor = step.surface === 'local' ? deps.hostExecutor : deps.executors?.[step.toolId];
      /*
       * 実装の無い tool を、**成功として通さない。**
       *
       * ここは長らく「登録が無ければ何もしない」だった。Phase 0 の echo の
       * ための逃がし口だったが、**manifest が宣言した tool にも効いていた。**
       * 実際、Sales CRM の `crm.pipeline` / `crm.next_action` は宣言だけで
       * 実装が無く、走らせると `{ echoed: null }` を返して**完了**していた。
       * 画面には「完了」と出て、成果物は無い。
       *
       * 逃がし口は `noop.*` にだけ残す。それ以外は繋がっていないと言う。
       */
      if (!executor && !step.toolId.startsWith('noop.')) {
        throw ApplicationFailure.nonRetryable(
          `${step.toolId} is declared but nothing implements it`,
          'ToolNotImplemented',
        );
      }

      let outcome;
      try {
        outcome = executor
          ? await executor.execute(input, step)
          : // Phase 0 の echo。**ここに来られるのは `noop.*` だけ。**
            { result: { echoed: step.args['message'] ?? null, step: step.index }, detail: null };
      } catch (error) {
        /*
         * 端末が居ないだけなら、**梯子を降りない**（正本 §4.4・§24）。
         *
         * ここを素通しにすると、PC を閉じただけで browser automation や
         * 運営側の経路へ落ちる。利用者が選んでいない手段で外部操作が起き、
         * しかも画面には「別の方法で続けています」としか出ない。
         * 端末が落ちたのは失敗ではないので、待てるように投げ直す。
         */
        if (isHostOfflineError(error)) {
          throw ApplicationFailure.nonRetryable(messageOfCause(error), HostOfflineError.TYPE);
        }

        // 止めた仕事の、端末がまだ取っていなかった step。何も走っていないので、
        // 代替の経路へ降りない（止めたものを別の手段で続けない）。
        if (isHostStepCancelled(error)) {
          throw ApplicationFailure.nonRetryable(messageOfCause(error), HOST_STEP_CANCELLED_TYPE);
        }

        // Retrying or escalating a generative request may charge again after
        // a lost response. Preserve host-offline recovery above (nothing ran).
        if (isMeteredStep(step)) {
          try {
            await executor?.onFailure?.(input, step, error);
          } catch {
            /* preserve original */
          }
          throw ApplicationFailure.nonRetryable(
            messageOfCause(error),
            'MeteredRequestFailed',
            '追加のAPI利用を避けるため、自動でやり直していません。',
          );
        }

        // 送信先が受け付けた後に応答だけ失われる場合がある。
        // 代替connector / browser / screenで試すことも二重実行になる。
        if (requiresSingleAttempt(step)) {
          try {
            await executor?.onFailure?.(input, step, error);
          } catch {
            // 元の操作の失敗を保持する。
          }
          const transactionResult = unknownTransactionResult(step, error);
          throw ApplicationFailure.nonRetryable(
            messageOfCause(error),
            'ExternalActionFailed',
            '自動でやり直していません。再実行する前に、実行先の履歴を確認してください。',
            ...(transactionResult ? [{ transactionResult }] : []),
          );
        }

        /*
         * 正本 §24: API connector fail → retry → alternate connector。
         * 再試行は Temporal が済ませているので、ここは**代替**を試す。
         *
         * 代替も同じ確認と同じ規則を通る（宣言が検証済みで、
         * 元より重い代替は publish で落としてある）。
         */
        const escalation = await escalate(input, step, deps);
        if (escalation.outcome) {
          await inTenant(input, (tx) =>
            appendEvent(
              tx,
              {
                tenantId: input.tenantId,
                streamKind: 'task',
                streamId: input.taskId,
                taskId: input.taskId,
                type: 'task.progress',
                payload: {
                  phase: 'acting',
                  step_index: step.index,
                  step_count: null,
                  message: step.message,
                  // どの tool でやったかは出さない（§7.2）。やり直したことだけ言う。
                  detail: '別の方法で続けています',
                  percent: null,
                },
                idempotencyKey: stepKey(input.taskId, step.index, 'fallback'),
              },
              deps.publisher,
            ),
          );
          outcome = escalation.outcome;
        } else {
          // 自分の領域の状態を片付けさせてから投げ直す。
          // 後始末が落ちても、元の失敗を握りつぶさない。
          try {
            await executor?.onFailure?.(input, step, error);
          } catch {
            /* 後始末の失敗で、本当の理由を見失わせない */
          }
          /*
           * **何を試して、何が使えなかったかを載せて投げる。**
           * 「できませんでした」だけでは、利用者は次に何をすればよいか分からない。
           * ここで捨てると、workflow から先へは二度と伝わらない（正本 §24）。
           *
           * 説明は details に分けて載せる。message には tool 側の文言が入るので、
           * 混ぜると、そのまま画面へ出したときに tool 名が漏れる（§7.2）。
           */
          throw ApplicationFailure.create({
            message: messageOfCause(error),
            type: 'StepEscalated',
            details: [handoffExplanation(escalation.trail)],
            ...(error instanceof Error ? { cause: error } : {}),
          });
        }
      }
      const result = outcome.artifact
        ? { ...(outcome.result as object), artifact: outcome.artifact }
        : outcome.result;

      const receiptId = decision.requiresReceipt ? uuidv7() : null;

      await inTenant(input, async (tx) => {
        if (receiptId) {
          // 正本 §9.4: 全 write action は receipt を残す。
          // 承認を要した step は「誰が承認したか」まで残さないと、
          // 後から「その操作は誰の判断だったか」を答えられない。
          const approver = decision.requiresApproval
            ? ((
                await tx
                  .selectFrom('approvals')
                  .select(['decided_by'])
                  .where('task_id', '=', input.taskId)
                  .where('step_index', '=', step.index)
                  .where('status', '=', 'APPROVED')
                  .executeTakeFirst()
              )?.decided_by ?? null)
            : null;

          const inputsHash = await canonicalSha256(step.args);
          await tx
            .insertInto('action_receipts')
            .values({
              id: receiptId,
              tenant_id: input.tenantId,
              task_id: input.taskId,
              tool_id: step.toolId,
              actor: 'agent',
              inputs_hash: inputsHash,
              result_ref: null,
              risk: step.risk,
              approved_by: approver,
              reversible_until: null,
              executed_at: now(),
              // どの step の結果かを残す。**残さないと「何をしたか」を人の言葉で言えない**
              // （UI/UX §22。承認文面へはこれで辿る）。
              step_index: step.index,
            })
            .onConflict((oc) => oc.columns(['task_id', 'tool_id', 'inputs_hash']).doNothing())
            .execute();
        }

        await appendEvent(
          tx,
          {
            tenantId: input.tenantId,
            streamKind: 'task',
            streamId: input.taskId,
            taskId: input.taskId,
            type: 'tool.completed',
            payload: {
              step_index: step.index,
              tool_id: step.toolId,
              ok: true,
              receipt_id: receiptId,
              duration_ms: Date.now() - startedAt,
            },
            idempotencyKey: stepKey(input.taskId, step.index, 'tool.completed'),
          },
          deps.publisher,
        );

        await appendEvent(
          tx,
          {
            tenantId: input.tenantId,
            streamKind: 'task',
            streamId: input.taskId,
            taskId: input.taskId,
            type: 'task.progress',
            payload: {
              phase: 'thinking',
              step_index: step.index,
              step_count: null,
              message: step.message,
              detail: outcome.detail ?? null,
              elapsed_ms: Date.now() - startedAt,
              retrying: false,
            },
            idempotencyKey: stepKey(input.taskId, step.index, 'progress'),
          },
          deps.publisher,
        );
      });

      return result;
    },

    async composeArtifact(input, spec: ArtifactSpec, results) {
      // 同一タスクで既に成果物があれば作り直さない（activity 再実行対策）。
      // artifacts は library の所有テーブルなので、直接引かず service に尋ねる（§5.1）。
      const existing = await deps.library.findBySourceTask(input.tenantId, input.taskId);
      if (existing) return existing.id;

      // step が自分で本文を組み立てているならそれを使う。
      // 使わずに汎用の整形をかけると、せっかくのレポートが台無しになる。
      const transaction = formatTransactionArtifact(input.kind, input.input, results);
      const composed =
        formatCheckoutArtifact(input.kind, input.input, results) ??
        formatOfficeArtifact(input.kind, results) ??
        transaction ??
        results
          .map((value) => (value as { artifact?: { title: string; markdown: string } })?.artifact)
          .filter((value): value is { title: string; markdown: string } => Boolean(value))
          .at(-1);

      const body =
        composed?.markdown ??
        [
          `# ${spec.title}`,
          '',
          ...results.map((r, i) => `- step ${i + 1}: ${JSON.stringify(r)}`),
        ].join('\n');
      const title = composed?.title ?? spec.title;
      const mimeType = transaction ? 'text/markdown' : spec.mimeType;

      const artifact = await deps.library.create({
        tenantId: input.tenantId,
        ownerId: input.userId,
        type: spec.type,
        title,
        mimeType,
        body: Buffer.from(body, 'utf8'),
        fileName: `${title}.${/json$/.test(mimeType) ? 'json' : 'md'}`,
        sourceTaskId: input.taskId,
        sourceAgentId: 'general',
        ...(spec.sourceMeetingId ? { sourceMeetingId: spec.sourceMeetingId } : {}),
      });

      await inTenant(input, (tx) =>
        appendEvent(
          tx,
          {
            tenantId: input.tenantId,
            streamKind: 'task',
            streamId: input.taskId,
            taskId: input.taskId,
            type: 'artifact.created',
            payload: {
              artifact_id: artifact.id,
              type: artifact.type,
              title: artifact.title,
              size: artifact.size,
            },
            idempotencyKey: stepKey(input.taskId, -2, 'artifact'),
          },
          deps.publisher,
        ),
      );

      return artifact.id;
    },

    async completeTask(input, artifactId) {
      return inTenant(input, async (tx) => {
        const startedAt = await tx
          .selectFrom('tasks')
          .select(['created_at'])
          .where('id', '=', input.taskId)
          .executeTakeFirst();

        const updated = await tx
          .updateTable('tasks')
          .set({
            status: 'COMPLETED',
            result_artifact_id: artifactId,
            completed_at: now(),
            updated_at: now(),
          })
          .where('id', '=', input.taskId)
          .where('status', 'in', ['RUNNING', 'PENDING'])
          .returning('id')
          .executeTakeFirst();

        if (!updated) return persistedOutcome(tx, input.taskId, true);

        await appendEvent(
          tx,
          {
            tenantId: input.tenantId,
            streamKind: 'task',
            streamId: input.taskId,
            taskId: input.taskId,
            type: 'task.completed',
            payload: {
              result_artifact_id: artifactId,
              duration_ms: startedAt
                ? Math.max(0, now().getTime() - startedAt.created_at.getTime())
                : 0,
            },
            idempotencyKey: stepKey(input.taskId, -3, 'completed'),
          },
          deps.publisher,
        );
        return { status: 'COMPLETED' as const, artifactId };
      });
    },

    async failTask(input, error: TaskErrorPayload, finalization) {
      return inTenant(input, async (tx) => {
        // Serialize with the user Stop endpoint. A delayed Temporal signal must
        // not let a host's unconfirmed outcome erase an already accepted stop.
        const current = await tx
          .selectFrom('tasks')
          .select('status')
          .where('id', '=', input.taskId)
          .forUpdate()
          .executeTakeFirst();
        if (!current) throw ApplicationFailure.nonRetryable('Task no longer exists', 'TaskGone');
        if (['COMPLETED', 'CANCELLED', 'FAILED'].includes(current.status))
          return persistedOutcome(tx, input.taskId);
        const cancelled =
          finalization?.preserveCancellation === true &&
          (current.status === 'CANCELLING' || finalization.cancellationReason !== undefined);
        const status = cancelled ? ('CANCELLED' as const) : ('FAILED' as const);
        const fallback =
          !error.transaction_result && finalization?.transactionSubmission
            ? await claimedTransactionIdentity(tx, input.taskId, finalization.transactionSubmission)
            : undefined;
        const recordedError = fallback ? { ...error, transaction_result: fallback } : error;
        await tx
          .updateTable('tasks')
          .set({
            status,
            error: JSON.stringify(recordedError),
            completed_at: now(),
            updated_at: now(),
          })
          .where('id', '=', input.taskId)
          .execute();

        const cancellation = {
          reason: finalization?.cancellationReason ?? 'user_requested',
          message: recordedError.transaction_result
            ? 'Genieの操作を停止しました。注文結果は未確認です。再注文せず、同じ注文の履歴を照会してください。'
            : 'Genieの操作を停止しました。送信済みの外部操作の取消は確認していません。',
          error: recordedError,
        };

        await appendEvent(
          tx,
          {
            tenantId: input.tenantId,
            streamKind: 'task',
            streamId: input.taskId,
            taskId: input.taskId,
            type: cancelled ? 'task.cancelled' : 'task.failed',
            payload: cancelled ? cancellation : { error: recordedError },
            idempotencyKey: cancelled
              ? stepKey(input.taskId, -5, 'cancelled')
              : stepKey(input.taskId, error.step_index ?? -4, 'failed'),
          },
          deps.publisher,
        );
        if (cancelled)
          await appendAuditEvent(tx, input.tenantId, {
            actorType: 'user',
            action: 'task.cancelled',
            taskId: input.taskId,
            payload: cancellation,
          });
        return { status, artifactId: null };
      });
    },

    /**
     * 端末が落ちたので止める。正本 §4.4。
     *
     * **FAILED にしない。**待てば戻るものを失敗として畳むと、
     * 途中までの結果も、承認済みの判断も捨てることになる。
     * 終わっている仕事は動かさない（遅れて届いた停止で完了を覆さない）。
     */
    async pauseForHost(input, stepIndex) {
      await inTenant(input, async (tx) => {
        const updated = await tx
          .updateTable('tasks')
          .set({ status: 'PAUSED_HOST_OFFLINE', updated_at: now() })
          .where('id', '=', input.taskId)
          .where('status', 'in', ['PENDING', 'RUNNING'])
          .returning('id')
          .executeTakeFirst();
        if (!updated) return;

        await appendEvent(
          tx,
          {
            tenantId: input.tenantId,
            streamKind: 'task',
            streamId: input.taskId,
            taskId: input.taskId,
            type: 'task.paused',
            payload: {
              reason: 'host_offline',
              step_index: stepIndex,
              // §21: 失敗と読める言葉を使わない。待てば進むことを言う。
              message: 'この操作は端末で行います。端末が戻るまで待っています。',
            },
            idempotencyKey: stepKey(input.taskId, stepIndex, 'paused'),
          },
          deps.publisher,
        );
      });
    },

    /** 端末が戻ったので進める。止まっていた理由が消えたときだけ呼ぶ。 */
    async resumeFromHost(input, stepIndex) {
      await inTenant(input, async (tx) => {
        const updated = await tx
          .updateTable('tasks')
          .set({ status: 'RUNNING', updated_at: now() })
          .where('id', '=', input.taskId)
          // 止まっていたものだけ動かす。取り消し済みを勝手に再開しない。
          .where('status', '=', 'PAUSED_HOST_OFFLINE')
          .returning('id')
          .executeTakeFirst();
        if (!updated) return;

        await appendEvent(
          tx,
          {
            tenantId: input.tenantId,
            streamKind: 'task',
            streamId: input.taskId,
            taskId: input.taskId,
            type: 'task.resumed',
            payload: { step_index: stepIndex, paused_ms: null },
            idempotencyKey: stepKey(input.taskId, stepIndex, 'resumed'),
          },
          deps.publisher,
        );
      });
    },

    /**
     * いま仕事を渡せる端末があるか。
     *
     * **繋いでいなければ「無い」と答える。**「たぶん居る」で進めると、
     * 置いた step を誰も取りに来ず、待ち時間だけが延びる。
     */
    async hostAvailable(input) {
      return (await deps.hosts?.hasOnlineHost(input.tenantId, input.userId)) ?? false;
    },

    async cancelTask(input, reason) {
      return inTenant(input, async (tx) => {
        const updated = await tx
          .updateTable('tasks')
          .set({ status: 'CANCELLED', completed_at: now(), updated_at: now() })
          .where('id', '=', input.taskId)
          .where('status', 'not in', ['COMPLETED', 'FAILED', 'CANCELLED'])
          .returning('id')
          .executeTakeFirst();

        if (!updated) return persistedOutcome(tx, input.taskId);

        await appendEvent(
          tx,
          {
            tenantId: input.tenantId,
            streamKind: 'task',
            streamId: input.taskId,
            taskId: input.taskId,
            type: 'task.cancelled',
            payload: { reason },
            idempotencyKey: stepKey(input.taskId, -5, 'cancelled'),
          },
          deps.publisher,
        );

        await appendAuditEvent(tx, input.tenantId, {
          actorType: 'user',
          action: 'task.cancelled',
          taskId: input.taskId,
          payload: { reason },
        });
        return { status: 'CANCELLED' as const, artifactId: null };
      });
    },
  };
}

/** Worker loss/timeouts may omit the host's result. Only a durable, approved,
 * exact-argument host claim permits a conservative lookup identity fallback.
 * Current approval expiry/revocation cannot erase a past possible submission. */
async function claimedTransactionIdentity(
  tx: ScopedDb,
  taskId: string,
  submission: NonNullable<FailureFinalization['transactionSubmission']>,
): Promise<UnknownTransactionResult | undefined> {
  const parsed = TransactionSubmitArgs.safeParse(submission.args);
  if (!parsed.success) return undefined;
  const args = parsed.data;
  if ((await canonicalSha256(args.quote)) !== args.quoteHash) return undefined;
  const inputsHash = await canonicalSha256(args);
  const approval = await tx
    .selectFrom('approvals')
    .select(['id', 'status', 'details'])
    .where('task_id', '=', taskId)
    .where('step_index', '=', submission.stepIndex)
    .executeTakeFirst();
  if (
    !approval ||
    approval.status !== 'APPROVED' ||
    storedInputsHash(approval.details) !== inputsHash
  )
    return undefined;
  const requests = await tx
    .selectFrom('host_step_requests')
    .select(['status', 'error', 'args', 'approval'])
    .where('task_id', '=', taskId)
    .where('step_index', '=', submission.stepIndex)
    .where('tool_id', '=', 'transaction.submit')
    .where('claimed_at', 'is not', null)
    .execute();
  for (const request of requests) {
    const proof = request.approval as {
      approvalId?: unknown;
      inputsHash?: unknown;
      decision?: unknown;
      operationId?: unknown;
    } | null;
    const failureCode = (request.error as { code?: unknown } | null)?.code;
    // Explicit pre-dispatch refusals (e.g. unsupported, stale approval,
    // authority unavailable, host.cancelled) do not imply an unknown order.
    if (
      request.status !== 'CLAIMED' &&
      request.status !== 'DONE' &&
      !(
        request.status === 'FAILED' &&
        ['transaction.result_unknown', 'host.failed', 'host.step_failed'].includes(
          String(failureCode),
        )
      )
    )
      continue;
    if (
      proof?.approvalId !== approval.id ||
      proof.decision !== 'APPROVED' ||
      proof.operationId !== 'transaction.submit' ||
      proof.inputsHash !== inputsHash ||
      (await canonicalSha256(request.args)) !== inputsHash
    )
      continue;
    return {
      provider: args.quote.provider,
      mode: args.quote.mode,
      account: args.quote.account,
      orderKey: args.quote.orderKey,
      quoteHash: args.quoteHash,
      status: 'unknown',
    };
  }
  return undefined;
}

/** Transport failures may retain a read-only reconciliation identity. Do not
 * propagate an unrelated host result or fabricate a provider receipt. */
function unknownTransactionResult(
  step: TaskStep,
  error: unknown,
): UnknownTransactionResult | undefined {
  if (step.toolId !== 'transaction.submit') return undefined;
  const args = TransactionSubmitArgs.safeParse(step.args);
  const result = (error as { result?: Record<string, unknown> } | null)?.result;
  if (!args.success || !result || result['status'] !== 'unknown') return undefined;
  const { quote, quoteHash } = args.data;
  if (
    result['quoteHash'] !== quoteHash ||
    result['provider'] !== quote.provider ||
    result['mode'] !== quote.mode ||
    result['account'] !== quote.account ||
    result['orderKey'] !== quote.orderKey
  )
    return undefined;
  return {
    mode: quote.mode,
    provider: quote.provider,
    account: quote.account,
    orderKey: quote.orderKey,
    quoteHash,
    status: 'unknown',
  };
}

/** A retried activity must report the original committed result, not invent a new event. */
async function persistedOutcome(tx: ScopedDb, taskId: string): Promise<TaskResult>;
async function persistedOutcome(
  tx: ScopedDb,
  taskId: string,
  allowCancelling: true,
): Promise<TaskResult | { status: 'CANCELLING'; artifactId: null }>;
async function persistedOutcome(
  tx: ScopedDb,
  taskId: string,
  allowCancelling = false,
): Promise<TaskResult | { status: 'CANCELLING'; artifactId: null }> {
  const row = await tx
    .selectFrom('tasks')
    .select(['status', 'result_artifact_id'])
    .where('id', '=', taskId)
    .executeTakeFirst();
  if (!row) throw ApplicationFailure.nonRetryable('Task no longer exists', 'TaskGone');
  if (row.status === 'COMPLETED')
    return { status: 'COMPLETED', artifactId: row.result_artifact_id };
  if (row.status === 'FAILED' || row.status === 'CANCELLED')
    return { status: row.status, artifactId: null };
  if (allowCancelling && row.status === 'CANCELLING')
    return { status: 'CANCELLING', artifactId: null };
  throw new Error(`Cannot finalize task from ${row.status}`);
}
