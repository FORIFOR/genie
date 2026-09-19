import { withPreparedExecution } from './execution-plan.js';
/**
 * TaskWorkflow。正本 §16.3、実装仕様 §6.3。
 *
 * このファイルは Temporal のサンドボックスで動く。**決定的**でなければならないので、
 * 乱数・時刻・I/O・Node の API を直接触らない。すべて activity 経由。
 */
import {
  ApplicationFailure,
  condition,
  defineQuery,
  defineSignal,
  proxyActivities,
  patched,
  setHandler,
  workflowInfo,
} from '@temporalio/workflow';
import {
  planTask,
  requiresSingleAttempt,
  isMeteredStep,
  withMeetingSummary,
  type TaskPlan,
} from './plan.js';

/**
 * 端末が落ちたときの失敗種別。
 *
 * **文字列で持つ。**このファイルは Temporal のサンドボックスで動くので、
 * `@genie/contracts` を import できない（決定性の制約）。
 * 値そのものは `HostOfflineError.TYPE` と一致していなければならず、
 * ずれていないことは試験で見張る。
 */
const HOST_OFFLINE_TYPE = 'HostOffline';
import type { TaskActivities } from './activity-types.js';

const persistence = proxyActivities<TaskActivities>({
  startToCloseTimeout: '30 seconds',
  // DB は粘る。ただし親が消えているなら粘っても無駄なので止める。
  retry: { maximumAttempts: 10, nonRetryableErrorTypes: ['TaskGone'] },
});

const tools = proxyActivities<TaskActivities>({
  startToCloseTimeout: '5 minutes',
  heartbeatTimeout: '30 seconds',
  retry: {
    initialInterval: '1s',
    backoffCoefficient: 2,
    maximumInterval: '30s',
    maximumAttempts: 5,
    // 何度やっても同じ結果になるものは再試行しない（実装仕様 §6.5）
    nonRetryableErrorTypes: [
      'ValidationError',
      'PermissionDenied',
      'ApprovalRejected',
      'UnknownTaskKind',
      'TenantMismatch',
      // タスクやテナントが消えたあとに再試行し続けない
      'TaskGone',
      // 手元でしか動かせない step。待っても状況は変わらない
      'LocalSurfaceUnavailable',
      // 端末が落ちている。**再試行では戻らない。**workflow 側で待つ
      HOST_OFFLINE_TYPE,
      // 規則が禁じている。承認を取っても変わらない
      'PolicyDenied',
      // 承認が古い。待っても新しくならない
      'ApprovalStale',
      // 実装が無い。**再試行しても現れない**
      'ToolNotImplemented',
    ],
  },
});

// Activity timeout / worker kill は executeStep の catch を通らない。
// この層でも再試行を止め、受付済みの送信を再実行しない。
const singleAttemptTools = proxyActivities<TaskActivities>({
  startToCloseTimeout: '5 minutes',
  heartbeatTimeout: '30 seconds',
  retry: { maximumAttempts: 1 },
});

// Google long-audio operations can exceed the ordinary five-minute tool budget.
// Avoid automatic retranscription after a timeout; the recording remains recoverable.
const meetingTranscription = proxyActivities<TaskActivities>({
  startToCloseTimeout: '30 minutes',
  retry: { maximumAttempts: 1 },
});

export interface TaskWorkflowInput {
  readonly taskId: string;
  readonly tenantId: string;
  readonly userId: string;
  readonly kind: string;
  readonly input: Record<string, unknown>;
  /**
   * 作成時に確定した計画（D-40）。
   *
   * **workflow に計画を作らせない。**install した plugin の agent は
   * 固定リストに入らないので DB を読む必要があるが、workflow のコードは
   * 決定的でなければならない。だから作る側で確定させて持ち込む。
   */
  readonly plan?: TaskPlan;
}

export interface TaskResult {
  readonly artifactId: string | null;
  readonly status: 'COMPLETED' | 'FAILED' | 'CANCELLED';
}

export interface ApprovalDecisionSignal {
  readonly approvalId: string;
  readonly decision: 'APPROVED' | 'REJECTED';
}

export const approveSignal = defineSignal<[ApprovalDecisionSignal]>('approve');
export const cancelSignal = defineSignal<[{ reason: string }]>('cancel');

export interface TaskStateSnapshot {
  readonly status: string;
  readonly stepIndex: number;
  readonly stepCount: number;
  readonly awaitingApprovalId: string | null;
}

export const getStateQuery = defineQuery<TaskStateSnapshot>('getState');

/**
 * 承認待ちの上限。`approvals.expires_at` と揃える（実装仕様 §6.5）。
 *
 * **ミリ秒で書く。**文字列（`'24 hours'`）で書いていた間、
 * `condition` の待ち時間が効かず、**承認待ちが永久に切れなかった。**
 * 期限切れの処理は書いてあるのに、そこへ辿り着けない状態だった。
 */
const APPROVAL_TIMEOUT_MS = 24 * 60 * 60 * 1000;

/**
 * 端末の復帰を待つ間隔。正本 §4.4。
 *
 * **短く始めて、伸ばす。**
 *
 * 一定の 1 分にしていた間、蓋を閉じて開けただけの不在でも
 * まるまる 1 分止まっていた。逆に一定の 5 秒にすると、
 * 出社まで閉じたままの PC を一晩じゅう問い合わせ続ける。
 *
 * ミリ秒で書く。文字列（`'1 minute'`）は読みやすいが、
 * どこで解釈されるかが増える分だけ間違いが入りやすい。
 */
const HOST_POLL_START_MS = 5_000;
const HOST_POLL_MAX_MS = 60_000;
/** 1 回の停止で見に行く回数。上の伸び方と合わせて、およそ 1 時間。 */
const HOST_WAIT_ROUND_CHECKS = 60;
/**
 * 停止と再開を繰り返してよい回数。
 *
 * **無限に待たない。**永久に PAUSED のまま残るなら、
 * それは結局、誰も気づかない失敗と同じことになる。
 */
const MAX_HOST_WAIT_ROUNDS = 24;

/** 端末が落ちているだけか。**失敗と混ぜない。** */
function isHostOffline(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 8 && current !== null && current !== undefined; depth += 1) {
    if ((current as { type?: string }).type === HOST_OFFLINE_TYPE) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

export async function TaskWorkflow(input: TaskWorkflowInput): Promise<TaskResult> {
  const decisions = new Map<string, 'APPROVED' | 'REJECTED'>();
  let cancelRequested: string | null = null;
  let stepIndex = 0;
  let awaitingApprovalId: string | null = null;
  let status = 'RUNNING';

  setHandler(approveSignal, (signal) => {
    decisions.set(signal.approvalId, signal.decision);
  });
  setHandler(cancelSignal, (signal) => {
    cancelRequested = signal.reason;
  });

  let plan: TaskPlan;
  try {
    // 持ち込まれた計画を優先する。無ければ組み込みの種別として計画する。
    plan = input.plan ?? planTask(input.kind, input.input);
  } catch {
    // 未知の種別は再試行しても変わらない。即座に失敗させる。
    await persistence.failTask(input, {
      code: 'task.unknown_kind',
      message: `unknown task kind: ${input.kind}`,
      step_index: null,
      retryable: false,
    });
    throw ApplicationFailure.nonRetryable(`unknown task kind: ${input.kind}`, 'UnknownTaskKind');
  }

  setHandler(getStateQuery, () => ({
    status,
    stepIndex,
    stepCount: plan.steps.length,
    awaitingApprovalId,
  }));

  await persistence.startTask(input, {
    kind: input.kind,
    title: plan.artifact.title,
    step_count: plan.steps.length,
    run_id: workflowInfo().runId,
  });

  const results: unknown[] = [];

  for (const step of plan.steps) {
    stepIndex = step.index;

    if (cancelRequested !== null) {
      return finishCancelled(input, cancelRequested);
    }

    let approvedStep = step;
    try {
      // Only the new task kind uses the new binding; old workflow histories are unchanged.
      if (input.kind === 'execution.run') approvedStep = withPreparedExecution(step, results);
    } catch (error) {
      await failWith(step.index, error);
      throw error;
    }
    const approval = await persistence.requestApprovalIfNeeded(input, approvedStep);
    if (approval) {
      awaitingApprovalId = approval.approvalId;
      status = 'WAITING_APPROVAL';

      const decided = await condition(
        () => decisions.has(approval.approvalId) || cancelRequested !== null,
        APPROVAL_TIMEOUT_MS,
      );

      if (cancelRequested !== null) return finishCancelled(input, cancelRequested);

      if (!decided) {
        await persistence.expireApproval(input, approval.approvalId);
        await persistence.failTask(input, {
          code: 'task.approval_timeout',
          message: 'approval was not granted in time',
          step_index: step.index,
          retryable: false,
        });
        status = 'FAILED';
        return { artifactId: null, status: 'FAILED' };
      }

      if (decisions.get(approval.approvalId) === 'REJECTED') {
        await persistence.rejectApproval(input, approval.approvalId, step.index);
        status = 'CANCELLED';
        return { artifactId: null, status: 'CANCELLED' };
      }

      await persistence.acceptApproval(input, approval.approvalId);
      awaitingApprovalId = null;
      status = 'RUNNING';
    }

    /*
     * step の失敗を**必ず記録してから**投げ直す。
     *
     * ここを素通しにしていた間、tool が失敗するとワークフローだけが落ち、
     * `tasks` の行は RUNNING のまま残っていた。Work タブでは永久に
     * 「進行中」に見える。**気づけない失敗**が一番まずい。
     */
    try {
      const effective = patched('reuse-meeting-summary-v1')
        ? withMeetingSummary(approvedStep, plan.steps, results)
        : approvedStep;
      results.push(await runStepWaitingForHost(effective));
    } catch (error) {
      if (input.kind === 'execution.run' && cancelRequested !== null)
        return finishCancelled(input, cancelRequested);
      await failWith(step.index, error);
      throw error;
    }

    if (cancelRequested !== null) return finishCancelled(input, cancelRequested);
  }

  if (cancelRequested !== null) return finishCancelled(input, cancelRequested);

  try {
    const artifactId = await tools.composeArtifact(input, plan.artifact, results);
    await persistence.completeTask(input, artifactId);
    status = 'COMPLETED';
    return { artifactId, status: 'COMPLETED' };
  } catch (error) {
    // 成果物の組み立てで落ちても同じ。宙ぶらりんにしない。
    await failWith(null, error);
    throw error;
  }

  /**
   * step を走らせる。端末が落ちていたら、**失敗にせず待つ**（正本 §4.4）。
   *
   * 待ち方に 3 つの決まりがある:
   *
   *   - 待っている間の状態は `PAUSED_HOST_OFFLINE`。RUNNING のままにすると
   *     画面では動いているように見え、いつまでも終わらない仕事になる
   *   - **運営側の経路へ乗り換えない。**乗り換えは利用者の選択の外
   *   - 待ちには終わりを置く。永久に PAUSED のまま残すと、
   *     結局それは気づかれない失敗になる
   */
  async function runStepWaitingForHost(step: TaskPlan['steps'][number]): Promise<unknown> {
    for (let round = 0; ; round += 1) {
      try {
        const executor =
          step.toolId === 'meeting.transcribe' && patched('long-meeting-stt-v1')
            ? meetingTranscription
            : requiresSingleAttempt(step) ||
                (patched('metered-single-attempt-v1') &&
                  isMeteredStep(step) &&
                  // Preserve the original activity policy when replaying video
                  // histories created before rendering joined metered work.
                  (step.toolId !== 'video.render' || patched('video-render-single-attempt-v1')) &&
                  // General's cloud step delegates to a metered device model too.
                  (!['general.answer', 'general.compose'].includes(step.toolId) ||
                    patched('general-generation-single-attempt-v1')))
              ? singleAttemptTools
              : tools;
        return await executor.executeStep(input, step);
      } catch (error) {
        if (!isHostOffline(error) || round >= MAX_HOST_WAIT_ROUNDS) throw error;

        status = 'PAUSED_HOST_OFFLINE';
        await persistence.pauseForHost(input, step.index);

        const back = await waitForHost();
        if (cancelRequested !== null) throw error;
        if (!back) throw error;

        await persistence.resumeFromHost(input, step.index);
        status = 'RUNNING';
      }
    }
  }

  /** 端末が戻るのを待つ。戻らないまま上限に達したら false。 */
  async function waitForHost(): Promise<boolean> {
    let interval = HOST_POLL_START_MS;

    for (let waited = 0; waited < HOST_WAIT_ROUND_CHECKS; waited += 1) {
      /*
       * **先に見る。**待ってから見ていた間、端末が既に戻っていても
       * 次の周期まで止まったままだった。
       */
      if (await persistence.hostAvailable(input)) return true;
      if (cancelRequested !== null) return false;

      // 取り消しは待たせない。止めたい人を待たせるのは、止められないのと同じ。
      await condition(() => cancelRequested !== null, interval);
      if (cancelRequested !== null) return false;

      interval = Math.min(interval * 2, HOST_POLL_MAX_MS);
    }
    return false;
  }

  /** 失敗を記録する。記録そのものが落ちても、元の失敗を握りつぶさない。 */
  async function failWith(stepIdx: number | null, error: unknown): Promise<void> {
    status = 'FAILED';
    try {
      await persistence.failTask(input, {
        code: 'task.step_failed',
        message: messageOf(error),
        step_index: stepIdx,
        retryable: false,
        // 何をすれば直るかを言う。**言わないと、利用者は何もできない**（正本 §24）
        recovery: recoveryFor(error),
        // 何を試して、何が使えなかったか。無ければ null（作らない）。
        handoff_explanation: explanationOf(error),
      });
    } catch {
      // 記録に失敗しても、元の失敗を投げ直すのは呼び出し側の責任
    }
  }

  /**
   * 失敗の理由を取り出す。
   *
   * Temporal は activity の失敗を "Activity task failed" で包む。
   * そのまま記録すると、**何も言っていないエラー**が残る。
   * 原因の連なりを辿って、実際の理由まで降りる。
   */
  /**
   * 何をすれば直るか。正本 §24 の最後は「user handoff」。
   *
   * **分からないときに `retry` と言わない。**直らない再試行を勧めると、
   * 利用者は同じことを繰り返すだけになる。
   */
  function recoveryFor(error: unknown): 'retry' | 'reconnect' | 'grant_permission' | 'handoff' {
    const message = messageOf(error);
    if (/not connected|expired|reconnect/i.test(message)) return 'reconnect';
    if (/permission|denied|not allowed|scope/i.test(message)) return 'grant_permission';
    if (/declared local|no host/i.test(message)) return 'handoff';
    // 実装が無い。利用者にできることは無い。
    if (/nothing implements it/i.test(message)) return 'handoff';
    // 代替まで試した上で落ちている。もう一度やっても同じ。
    return 'handoff';
  }

  /**
   * 梯子の跡の説明を取り出す。正本 §24。
   *
   * activity は `details` に分けて載せている。message に混ぜると、
   * そのまま画面へ出したときに tool 名が漏れる（§7.2）。
   * **無ければ作らない。**「試しました」と嘘をつくより、黙るほうがよい。
   */
  function explanationOf(error: unknown): string | null {
    let current: unknown = error;
    for (let depth = 0; depth < 8 && current !== null && current !== undefined; depth += 1) {
      const details = (current as { details?: unknown }).details;
      if (Array.isArray(details)) {
        const text = details.find((d): d is string => typeof d === 'string' && d.length > 0);
        if (text) return text;
      }
      current = (current as { cause?: unknown }).cause;
    }
    return null;
  }

  function messageOf(error: unknown): string {
    let current: unknown = error;
    let deepest = '';
    // 循環しても止まるよう、辿る深さに上限を置く
    for (let depth = 0; depth < 8 && current instanceof Error; depth += 1) {
      if (current.message) deepest = current.message;
      current = (current as { cause?: unknown }).cause;
    }
    return deepest || String(error);
  }

  async function finishCancelled(wf: TaskWorkflowInput, reason: string): Promise<TaskResult> {
    // 実行中の外部書き込みは中断しない。中途半端な副作用を作らない（正本 §24）
    await persistence.cancelTask(wf, reason);
    status = 'CANCELLED';
    return { artifactId: null, status: 'CANCELLED' };
  }
}
