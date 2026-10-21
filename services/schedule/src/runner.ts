/**
 * 予約の見回り。時間になった予約を 1 回ずつ動かす。
 *
 *   tick（15 秒ごと。寝ていた Mac が起きたら最初の tick で気づく）
 *     → 止まった回を閉じる（やり直さない） → 期限の来た予約を取り出す（1 テナント 5 件まで）
 *     → お知らせを残す / handleTurn で頼む → 届け先へ → 次の時刻へ
 *
 * 守ること（openclaw の cron と同じ考え。1 人用に小さくしたもの）:
 *   - 寝ていた間に過ぎた回は**1 回だけ**追いつく（全部はやり直さない）。遅れは文に添える
 *   - 1 つの予約で同時に走るのは 1 回（DB の一意索引）。同じ予定時刻は二度走らない
 *   - 途中で落ちた回はやり直さない（仕事が二つになる）。「途中で止まった」と知らせる
 *   - 失敗は間をあけて（30 秒 → 1 分 → 5 分 → 15 分 → 60 分）。続けて 10 回（1 回だけのものは 3 回）で止め、知らせる
 *   - 実行の結果と、届けた結果は分けて記録する
 */
import type { ScheduleStore, ClaimedRun, DeliveryStatus, ScheduledJob } from './store.js';
import { formatWhen, isRecurring, nextRunAfter } from './time.js';

/** 失敗のあと、次に試すまで。 */
export const ERROR_BACKOFF_MS = [30_000, 60_000, 300_000, 900_000, 3_600_000] as const;
/** 続けて失敗したら止める回数。 */
export const MAX_CONSECUTIVE_ERRORS = 10;
export const MAX_ONESHOT_ATTEMPTS = 3;
/** これより遅れたら「遅れました」と添える。 */
export const LATE_NOTE_MS = 2 * 60 * 1000;

/** handleTurn を予約の持ち主として呼んだ結果。 */
export type ScheduledTurnOutcome =
  | { readonly kind: 'started'; readonly taskId: string | null; readonly notice: string | null; readonly title: string | null }
  | { readonly kind: 'answered'; readonly answer: string };

export interface ScheduleRunnerDeps {
  readonly store: ScheduleStore;
  /**
   * 頼む（Task Dock と同じ入口）。`turnId` は 1 回分の id（同じ回で仕事を二つ作らない）。
   * 予約の言い方の読み取りは飛ばす（予約から予約を作らない）。
   */
  readonly turn: (
    job: ScheduledJob,
    text: string,
    turnId: string,
  ) => Promise<ScheduledTurnOutcome>;
  /**
   * 頼まれた会話がチャット（Slack / LINE）なら、そこへ返す。チャットでなければ 'none'。
   */
  readonly channels?: {
    notify(tenantId: string, conversationId: string, text: string): Promise<DeliveryStatus>;
    followTask(
      tenantId: string,
      conversationId: string,
      taskId: string,
      title: string | null,
    ): Promise<DeliveryStatus>;
  };
  readonly log?: (event: string, detail: Record<string, unknown>) => void;
  readonly now?: () => number;
}

export class ScheduleRunner {
  readonly #deps: ScheduleRunnerDeps;
  #timer: ReturnType<typeof setInterval> | null = null;
  #ticking: Promise<number> | null = null;

  constructor(deps: ScheduleRunnerDeps) {
    this.#deps = deps;
  }

  #now(): number {
    return (this.#deps.now ?? Date.now)();
  }

  #log(event: string, detail: Record<string, unknown>): void {
    this.#deps.log?.(event, detail);
  }

  start(intervalMs = 15_000): void {
    if (this.#timer) return;
    this.#timer = setInterval(() => {
      void this.tick().catch((error: unknown) =>
        this.#log('schedule.tick_failed', { error: errorCode(error) }),
      );
    }, intervalMs);
    this.#timer.unref();
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
  }

  /** 1 回見回る。動かした回数を返す。重ねて呼ばれたら、走っているものを待つ。 */
  async tick(): Promise<number> {
    if (this.#ticking) return this.#ticking;
    this.#ticking = this.#tickOnce().finally(() => {
      this.#ticking = null;
    });
    return this.#ticking;
  }

  async #tickOnce(): Promise<number> {
    let ran = 0;
    for (const tenantId of await this.#deps.store.tenantsNeedingAttention()) {
      try {
        await this.#deps.store.pruneProposals(tenantId);
        for (const job of await this.#deps.store.interruptStalled(tenantId)) {
          await this.#interrupted(job);
        }
        for (const claimed of await this.#deps.store.claimDue(tenantId)) {
          await this.#run(claimed);
          ran += 1;
        }
      } catch (error) {
        this.#log('schedule.tenant_failed', { error: errorCode(error) });
      }
    }
    return ran;
  }

  /** 途中で落ちた回。やり直さず、次の時刻へ進めて、本人に知らせる。 */
  async #interrupted(job: ScheduledJob): Promise<void> {
    const next = nextRunAfter(job.schedule, this.#now());
    await this.#deps.store.moveNext(job.tenantId, job.id, next === null ? null : new Date(next));
    await this.#deps.store.addNotice({
      tenantId: job.tenantId,
      userId: job.userId,
      kind: 'schedule_problem',
      title: '予約の途中で Genie が止まりました',
      body: `${job.name}。仕事になったかは作業一覧で確かめてください。`,
      jobId: job.id,
    });
    this.#log('schedule.interrupted', { job_id: job.id });
  }

  async #run(claimed: ClaimedRun): Promise<void> {
    const { job, runId, scheduledFor, lateMs } = claimed;
    const now = this.#now();
    // 同じ予定時刻はもう走った（記録だけ残して落ちた）。次へ進めるだけ
    if (!runId) {
      const next = nextRunAfter(job.schedule, Math.max(now, scheduledFor.getTime()));
      await this.#deps.store.moveNext(job.tenantId, job.id, next === null ? null : new Date(next));
      return;
    }
    // 1 回だけの予約は、1 回動かしたら終わり
    const naturalNext = isRecurring(job.schedule)
      ? nextRunAfter(job.schedule, Math.max(now, scheduledFor.getTime()))
      : null;
    // 遅れて、追いつかない設定の繰り返しは飛ばす
    if (lateMs > LATE_NOTE_MS && job.catchUp === 'skip' && isRecurring(job.schedule)) {
      await this.#deps.store.finishRun(
        job.tenantId,
        { jobId: job.id, runId },
        { status: 'skipped', deliveryStatus: 'none', error: 'late' },
        {
          status: naturalNext === null ? 'done' : 'active',
          nextRunAt: naturalNext === null ? null : new Date(naturalNext),
          consecutiveErrors: job.consecutiveErrors,
        },
      );
      return;
    }
    const lateNote =
      lateMs > LATE_NOTE_MS
        ? `（${formatWhen(scheduledFor.getTime(), job.tz)} の予定でしたが、${lateText(lateMs)}遅れました）`
        : '';

    try {
      const outcome =
        job.payload.kind === 'reminder'
          ? await this.#remind(job, job.payload.text, lateNote)
          : await this.#ask(job, job.payload.text, runId, lateNote);
      await this.#deps.store.finishRun(
        job.tenantId,
        { jobId: job.id, runId },
        { status: 'ok', deliveryStatus: outcome.delivery, taskId: outcome.taskId },
        {
          status: naturalNext === null ? 'done' : 'active',
          nextRunAt: naturalNext === null ? null : new Date(naturalNext),
          consecutiveErrors: 0,
        },
      );
      this.#log('schedule.ran', {
        job_id: job.id,
        kind: job.payload.kind,
        late_ms: lateMs,
        delivery: outcome.delivery,
      });
    } catch (error) {
      await this.#failed(claimed, naturalNext, errorCode(error));
    }
  }

  async #failed(claimed: ClaimedRun, naturalNext: number | null, code: string): Promise<void> {
    const { job, runId, scheduledFor } = claimed;
    const errors = job.consecutiveErrors + 1;
    const limit = isRecurring(job.schedule) ? MAX_CONSECUTIVE_ERRORS : MAX_ONESHOT_ATTEMPTS;
    const giveUp = errors >= limit;
    const backoff = ERROR_BACKOFF_MS[Math.min(errors - 1, ERROR_BACKOFF_MS.length - 1)]!;
    const retryAt = this.#now() + backoff;
    // 1 回だけの予約は同じ回を後で試し直す。繰り返しは、次の回より前なら試し直す
    const nextRunAt = giveUp
      ? null
      : isRecurring(job.schedule)
        ? Math.min(retryAt, naturalNext ?? retryAt)
        : Math.max(retryAt, scheduledFor.getTime());
    await this.#deps.store.finishRun(
      job.tenantId,
      { jobId: job.id, runId },
      { status: 'error', deliveryStatus: 'none', error: code },
      {
        status: giveUp ? 'disabled' : 'active',
        nextRunAt: nextRunAt === null ? null : new Date(nextRunAt),
        consecutiveErrors: errors,
      },
    );
    this.#log('schedule.failed', { job_id: job.id, error: code, errors, gave_up: giveUp });
    if (giveUp) {
      await this.#deps.store.addNotice({
        tenantId: job.tenantId,
        userId: job.userId,
        kind: 'schedule_problem',
        title: '予約を止めました',
        body: `${job.name}。${String(errors)} 回続けて失敗しました（${code}）。直したら「予約の一覧」から再開できます。`,
        jobId: job.id,
      });
    }
  }

  /** お知らせ。チャットで頼まれたならチャットへ、そうでなければ Mac へ。 */
  async #remind(
    job: ScheduledJob,
    text: string,
    lateNote: string,
  ): Promise<{ delivery: DeliveryStatus; taskId: string | null }> {
    const body = `⏰ ${text}${lateNote}`;
    const channel =
      (await this.#deps.channels?.notify(job.tenantId, job.conversationId, body)) ?? 'none';
    if (channel !== 'none') return { delivery: channel, taskId: null };
    await this.#deps.store.addNotice({
      tenantId: job.tenantId,
      userId: job.userId,
      kind: 'reminder',
      title: text.slice(0, 200),
      body: lateNote,
      jobId: job.id,
    });
    return { delivery: 'delivered', taskId: null };
  }

  /** 頼む。仕事になったら、チャットならそこで区切りを返し、Mac にはお知らせを残す。 */
  async #ask(
    job: ScheduledJob,
    text: string,
    runId: string,
    lateNote: string,
  ): Promise<{ delivery: DeliveryStatus; taskId: string | null }> {
    const outcome = await this.#deps.turn(job, text, runId);
    if (outcome.kind === 'answered') {
      // 聞き返された（指示語が解けない等）。予約からは答えられないので、本人に見せる
      return this.#remind(job, `予約「${text}」: ${outcome.answer}`, lateNote);
    }
    if (!outcome.taskId) throw new ScheduleRunError(outcome.notice ?? 'not_started');
    const taskId = outcome.taskId;
    const channel =
      (await this.#deps.channels?.followTask(
        job.tenantId,
        job.conversationId,
        taskId,
        outcome.title,
      )) ?? 'none';
    if (channel !== 'none') return { delivery: channel, taskId };
    await this.#deps.store.addNotice({
      tenantId: job.tenantId,
      userId: job.userId,
      kind: 'scheduled_task',
      title: `予約の仕事を始めました：${(outcome.title ?? text).slice(0, 150)}`,
      body: `結果は作業一覧で開けます。${lateNote}`,
      jobId: job.id,
      taskId,
    });
    return { delivery: 'delivered', taskId };
  }
}

class ScheduleRunError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ScheduleRunError';
  }
}

function lateText(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${String(minutes)} 分`;
  const hours = Math.floor(minutes / 60);
  return minutes % 60 === 0 ? `${String(hours)} 時間` : `${String(hours)} 時間 ${String(minutes % 60)} 分`;
}

function errorCode(error: unknown): string {
  if (error instanceof ScheduleRunError) return error.message.slice(0, 200);
  if (error instanceof Error)
    return error.name === 'Error' ? error.message.slice(0, 120) : error.name;
  return 'unknown';
}
