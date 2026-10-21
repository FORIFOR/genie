/**
 * 予約とお知らせの記録（scheduled_jobs / scheduled_runs / user_notices）。
 *
 * 期限の来たテナントを探すときだけ astra_identity（いつ・どのテナントかの列だけ GRANT 済み）で引き、
 * 中身の読み書きは withTenant（RLS）で行う。
 */
import { uuidv7 } from '@genie/contracts';
import { withIdentity, withTenant, type DbHandle } from '@genie/db';
import { sql } from 'kysely';
import type { SchedulePayload } from './parse.js';
import type { Schedule } from './time.js';

export type JobStatus = 'proposed' | 'active' | 'paused' | 'done' | 'cancelled' | 'disabled';
export type RunStatus = 'running' | 'ok' | 'error' | 'skipped' | 'interrupted';
export type DeliveryStatus = 'delivered' | 'failed' | 'unknown' | 'none';
export type NoticeKind = 'reminder' | 'scheduled_task' | 'schedule_problem';

export interface ScheduledJob {
  readonly id: string;
  readonly tenantId: string;
  readonly userId: string;
  readonly conversationId: string;
  readonly name: string;
  readonly status: JobStatus;
  readonly schedule: Schedule;
  readonly payload: SchedulePayload;
  readonly tz: string;
  readonly catchUp: 'once' | 'skip';
  readonly nextRunAt: Date | null;
  readonly lastRunAt: Date | null;
  readonly lastStatus: RunStatus | null;
  readonly lastError: string | null;
  readonly consecutiveErrors: number;
  readonly createdAt: Date;
}

/** 取り出した 1 回分。 */
export interface ClaimedRun {
  readonly runId: string;
  readonly job: ScheduledJob;
  readonly scheduledFor: Date;
  /** DB の時計で数えた遅れ（ms）。 */
  readonly lateMs: number;
}

export interface Notice {
  readonly id: string;
  readonly kind: NoticeKind;
  readonly title: string;
  readonly body: string;
  readonly jobId: string | null;
  readonly taskId: string | null;
  readonly createdAt: string;
}

/** 確かめ中の予約が消えるまで。 */
export const PROPOSAL_TTL_MS = 10 * 60 * 1000;
/** 走ったまま返ってこない回を、落ちたものとみなすまで。 */
export const RUN_STALL_MS = 10 * 60 * 1000;

type JobRow = {
  id: string;
  tenant_id: string;
  user_id: string;
  conversation_id: string;
  name: string;
  status: string;
  schedule: unknown;
  payload: unknown;
  tz: string;
  catch_up: string;
  next_run_at: Date | null;
  last_run_at: Date | null;
  last_status: string | null;
  last_error: string | null;
  consecutive_errors: number;
  created_at: Date;
};

const json = <T>(value: unknown): T => (typeof value === 'string' ? JSON.parse(value) : value) as T;

function toJob(row: JobRow): ScheduledJob {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    userId: row.user_id,
    conversationId: row.conversation_id,
    name: row.name,
    status: row.status as JobStatus,
    schedule: json<Schedule>(row.schedule),
    payload: json<SchedulePayload>(row.payload),
    tz: row.tz,
    catchUp: row.catch_up === 'skip' ? 'skip' : 'once',
    nextRunAt: row.next_run_at,
    lastRunAt: row.last_run_at,
    lastStatus: row.last_status as RunStatus | null,
    lastError: row.last_error,
    consecutiveErrors: row.consecutive_errors,
    createdAt: row.created_at,
  };
}

export class ScheduleStore {
  constructor(private readonly db: DbHandle) {}

  /** 確かめ中の予約を置く。同じ会話の前の案は捨てる（会話ごとに 1 つ）。 */
  async propose(input: {
    tenantId: string;
    userId: string;
    conversationId: string;
    name: string;
    schedule: Schedule;
    payload: SchedulePayload;
    tz: string;
  }): Promise<ScheduledJob> {
    return withTenant(this.db, input.tenantId, async (tx) => {
      await tx
        .deleteFrom('scheduled_jobs')
        .where('conversation_id', '=', input.conversationId)
        .where('status', '=', 'proposed')
        .execute();
      const row = await tx
        .insertInto('scheduled_jobs')
        .values({
          id: uuidv7(),
          tenant_id: input.tenantId,
          user_id: input.userId,
          conversation_id: input.conversationId,
          name: input.name.slice(0, 300),
          status: 'proposed',
          schedule: JSON.stringify(input.schedule),
          payload: JSON.stringify(input.payload),
          tz: input.tz,
          proposed_expires_at: sql<Date>`now() + ${PROPOSAL_TTL_MS} * interval '1 millisecond'`,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      return toJob(row);
    });
  }

  /** この会話で確かめ中の予約（期限内のもの）。 */
  async proposalFor(tenantId: string, conversationId: string): Promise<ScheduledJob | null> {
    return withTenant(this.db, tenantId, async (tx) => {
      const row = await tx
        .selectFrom('scheduled_jobs')
        .selectAll()
        .where('conversation_id', '=', conversationId)
        .where('status', '=', 'proposed')
        .where('proposed_expires_at', '>', sql<Date>`now()`)
        .executeTakeFirst();
      return row ? toJob(row) : null;
    });
  }

  /** 確かめが取れた。次の時刻を入れて動かし始める。 */
  async activate(tenantId: string, jobId: string, nextRunAt: Date): Promise<ScheduledJob | null> {
    return withTenant(this.db, tenantId, async (tx) => {
      const row = await tx
        .updateTable('scheduled_jobs')
        .set({
          status: 'active',
          next_run_at: nextRunAt,
          proposed_expires_at: null,
          updated_at: sql`now()`,
        })
        .where('id', '=', jobId)
        .where('status', '=', 'proposed')
        .returningAll()
        .executeTakeFirst();
      return row ? toJob(row) : null;
    });
  }

  /** 本人の予約の状態を変える（取り消し・一時停止・再開）。変えられたら新しい行。 */
  async setStatus(
    tenantId: string,
    userId: string,
    jobId: string,
    status: 'cancelled' | 'paused' | 'active',
    nextRunAt: Date | null = null,
  ): Promise<ScheduledJob | null> {
    return withTenant(this.db, tenantId, async (tx) => {
      const from: JobStatus[] =
        status === 'active' ? ['paused', 'disabled'] : ['proposed', 'active', 'paused', 'disabled'];
      const row = await tx
        .updateTable('scheduled_jobs')
        .set({
          status,
          ...(status === 'active'
            ? { next_run_at: nextRunAt, consecutive_errors: 0, last_error: null }
            : {}),
          updated_at: sql`now()`,
        })
        .where('id', '=', jobId)
        .where('user_id', '=', userId)
        .where('status', 'in', from)
        .returningAll()
        .executeTakeFirst();
      return row ? toJob(row) : null;
    });
  }

  async get(tenantId: string, userId: string, jobId: string): Promise<ScheduledJob | null> {
    return withTenant(this.db, tenantId, async (tx) => {
      const row = await tx
        .selectFrom('scheduled_jobs')
        .selectAll()
        .where('id', '=', jobId)
        .where('user_id', '=', userId)
        .executeTakeFirst();
      return row ? toJob(row) : null;
    });
  }

  /** 本人の予約（確かめ中を除く）。動いているものを先に、次の時刻の順。 */
  async list(
    tenantId: string,
    userId: string,
    options: { includeFinished?: boolean } = {},
  ): Promise<ScheduledJob[]> {
    return withTenant(this.db, tenantId, async (tx) => {
      let query = tx
        .selectFrom('scheduled_jobs')
        .selectAll()
        .where('user_id', '=', userId)
        .where('status', '!=', 'proposed');
      if (!options.includeFinished)
        query = query.where('status', 'in', ['active', 'paused', 'disabled']);
      const rows = await query
        .orderBy(sql`case status when 'active' then 0 when 'paused' then 1 else 2 end`)
        .orderBy('next_run_at', 'asc')
        .orderBy('created_at', 'desc')
        .limit(100)
        .execute();
      return rows.map(toJob);
    });
  }

  async runs(
    tenantId: string,
    jobId: string,
    limit = 20,
  ): Promise<
    {
      id: string;
      scheduledFor: string;
      startedAt: string;
      finishedAt: string | null;
      status: RunStatus;
      deliveryStatus: DeliveryStatus | null;
      taskId: string | null;
      lateMs: number;
      error: string | null;
    }[]
  > {
    return withTenant(this.db, tenantId, async (tx) => {
      const rows = await tx
        .selectFrom('scheduled_runs')
        .selectAll()
        .where('job_id', '=', jobId)
        .orderBy('started_at', 'desc')
        .limit(limit)
        .execute();
      return rows.map((r) => ({
        id: r.id,
        scheduledFor: r.scheduled_for.toISOString(),
        startedAt: r.started_at.toISOString(),
        finishedAt: r.finished_at?.toISOString() ?? null,
        status: r.status as RunStatus,
        deliveryStatus: r.delivery_status as DeliveryStatus | null,
        taskId: r.task_id,
        lateMs: Number(r.late_ms),
        error: r.error,
      }));
    });
  }

  /**
   * 見回りの要るテナント: 期限が来た予約か、走ったまま止まった回がある。
   * astra_identity は「いつ・どのテナントか」の列しか読めない。
   */
  async tenantsNeedingAttention(): Promise<string[]> {
    return withIdentity(this.db, async (tx) => {
      const rows = await tx
        .selectFrom('scheduled_jobs')
        .select('tenant_id')
        .distinct()
        .where('status', '=', 'active')
        .where((eb) =>
          eb.or([
            eb.and([eb('running_at', 'is', null), eb('next_run_at', '<=', sql<Date>`now()`)]),
            eb(
              'running_at',
              '<',
              sql<Date>`now() - ${RUN_STALL_MS} * interval '1 millisecond'`,
            ),
          ]),
        )
        .limit(500)
        .execute();
      return rows.map((r) => r.tenant_id);
    });
  }

  /**
   * 期限の来た予約を取り出し、1 回分の記録（running）を作る。
   * **同じ予約を二つのプロセスが同時に取らない**（SKIP LOCKED と、running の一意索引）。
   */
  async claimDue(tenantId: string, limit = 5): Promise<ClaimedRun[]> {
    return withTenant(this.db, tenantId, async (tx) => {
      const rows = await sql<JobRow & { late_ms: string }>`
        select j.*, (extract(epoch from now() - j.next_run_at) * 1000)::bigint::text as late_ms
          from scheduled_jobs j
         where j.status = 'active' and j.running_at is null and j.next_run_at <= now()
         order by j.next_run_at
         limit ${limit}
         for update skip locked
      `.execute(tx);
      const claimed: ClaimedRun[] = [];
      for (const row of rows.rows) {
        const runId = uuidv7();
        const inserted = await tx
          .insertInto('scheduled_runs')
          .values({
            id: runId,
            tenant_id: tenantId,
            job_id: row.id,
            scheduled_for: row.next_run_at!,
            status: 'running',
            late_ms: row.late_ms,
          })
          .onConflict((oc) => oc.doNothing())
          .returning('id')
          .executeTakeFirst();
        if (!inserted) {
          // この予定時刻はもう走った（前のプロセスが記録だけ残して落ちた）。次へ進めるのは呼ぶ側
          claimed.push({
            runId: '',
            job: toJob(row),
            scheduledFor: row.next_run_at!,
            lateMs: Number(row.late_ms),
          });
          continue;
        }
        await tx
          .updateTable('scheduled_jobs')
          .set({ running_at: sql`now()` })
          .where('id', '=', row.id)
          .execute();
        claimed.push({
          runId,
          job: toJob(row),
          scheduledFor: row.next_run_at!,
          lateMs: Number(row.late_ms),
        });
      }
      return claimed;
    });
  }

  /** 1 回分を閉じ、予約を次へ進める（次が無ければ done、続けて失敗したら disabled）。 */
  async finishRun(
    tenantId: string,
    run: { jobId: string; runId: string },
    outcome: {
      status: Exclude<RunStatus, 'running'>;
      deliveryStatus: DeliveryStatus;
      taskId?: string | null;
      error?: string | null;
    },
    next: {
      status: JobStatus;
      nextRunAt: Date | null;
      consecutiveErrors: number;
    },
  ): Promise<void> {
    await withTenant(this.db, tenantId, async (tx) => {
      if (run.runId) {
        await tx
          .updateTable('scheduled_runs')
          .set({
            status: outcome.status,
            delivery_status: outcome.deliveryStatus,
            task_id: outcome.taskId ?? null,
            error: outcome.error?.slice(0, 500) ?? null,
            finished_at: sql`now()`,
          })
          .where('id', '=', run.runId)
          .execute();
      }
      await tx
        .updateTable('scheduled_jobs')
        .set({
          running_at: null,
          last_run_at: sql`now()`,
          last_status: outcome.status,
          last_error: outcome.error?.slice(0, 500) ?? null,
          consecutive_errors: next.consecutiveErrors,
          next_run_at: next.nextRunAt,
          // 走っている間に本人が止めた・取り消したものは、そのまま
          status: sql`case when status = 'active' then ${next.status} else status end`,
          updated_at: sql`now()`,
        })
        .where('id', '=', run.jobId)
        .execute();
    });
  }

  /**
   * 走ったまま止まった回（プロセスが落ちた）。**やり直さない**（仕事が二つになる）。
   * interrupted として閉じ、予約の running を外して返す（次の時刻へ進めるのは呼ぶ側）。
   */
  async interruptStalled(tenantId: string): Promise<ScheduledJob[]> {
    return withTenant(this.db, tenantId, async (tx) => {
      const rows = await tx
        .updateTable('scheduled_jobs')
        .set({ running_at: null, last_status: 'interrupted', updated_at: sql`now()` })
        .where('status', '=', 'active')
        .where('running_at', '<', sql<Date>`now() - ${RUN_STALL_MS} * interval '1 millisecond'`)
        .returningAll()
        .execute();
      if (rows.length > 0) {
        await tx
          .updateTable('scheduled_runs')
          .set({ status: 'interrupted', finished_at: sql`now()`, delivery_status: 'unknown' })
          .where(
            'job_id',
            'in',
            rows.map((r) => r.id),
          )
          .where('status', '=', 'running')
          .execute();
      }
      return rows.map(toJob);
    });
  }

  /** 期限の切れた案を消す。 */
  async pruneProposals(tenantId: string): Promise<void> {
    await withTenant(this.db, tenantId, (tx) =>
      tx
        .deleteFrom('scheduled_jobs')
        .where('status', '=', 'proposed')
        .where('proposed_expires_at', '<', sql<Date>`now()`)
        .execute(),
    );
  }

  /** 次の時刻だけ進める（遅れて飛ばした、止まった回のあと）。 */
  async moveNext(tenantId: string, jobId: string, nextRunAt: Date | null): Promise<void> {
    await withTenant(this.db, tenantId, (tx) =>
      tx
        .updateTable('scheduled_jobs')
        .set({
          next_run_at: nextRunAt,
          status: sql`case when ${nextRunAt === null} and status = 'active' then 'done' else status end`,
          updated_at: sql`now()`,
        })
        .where('id', '=', jobId)
        .execute(),
    );
  }

  async addNotice(input: {
    tenantId: string;
    userId: string;
    kind: NoticeKind;
    title: string;
    body?: string;
    jobId?: string | null;
    taskId?: string | null;
  }): Promise<string> {
    const id = uuidv7();
    await withTenant(this.db, input.tenantId, (tx) =>
      tx
        .insertInto('user_notices')
        .values({
          id,
          tenant_id: input.tenantId,
          user_id: input.userId,
          kind: input.kind,
          title: input.title.slice(0, 200),
          body: (input.body ?? '').slice(0, 2000),
          job_id: input.jobId ?? null,
          task_id: input.taskId ?? null,
        })
        .execute(),
    );
    return id;
  }

  /** 端末がまだ受け取っていないお知らせ（古い順）。 */
  async pendingNotices(tenantId: string, userId: string, limit = 20): Promise<Notice[]> {
    return withTenant(this.db, tenantId, async (tx) => {
      const rows = await tx
        .selectFrom('user_notices')
        .selectAll()
        .where('user_id', '=', userId)
        .where('delivered_at', 'is', null)
        .orderBy('created_at')
        .limit(limit)
        .execute();
      return rows.map((r) => ({
        id: r.id,
        kind: r.kind as NoticeKind,
        title: r.title,
        body: r.body,
        jobId: r.job_id,
        taskId: r.task_id,
        createdAt: r.created_at.toISOString(),
      }));
    });
  }

  /** 端末が通知に出した。二度出さない。 */
  async markNoticesDelivered(tenantId: string, userId: string, ids: string[]): Promise<number> {
    if (ids.length === 0) return 0;
    return withTenant(this.db, tenantId, async (tx) => {
      const result = await tx
        .updateTable('user_notices')
        .set({ delivered_at: sql`now()` })
        .where('user_id', '=', userId)
        .where('id', 'in', ids)
        .where('delivered_at', 'is', null)
        .executeTakeFirst();
      return Number(result.numUpdatedRows);
    });
  }
}
