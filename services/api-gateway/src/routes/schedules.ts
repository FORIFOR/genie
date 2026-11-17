/**
 * 予約とお知らせの HTTP 表面（本人の操作だけ。認証必須）。
 *
 *   GET    /v1/schedules              予約の一覧（?all=1 で終わったものも）
 *   PATCH  /v1/schedules/:id          止める・再開する・取り消す
 *   GET    /v1/schedules/:id/runs     1 回ごとの記録（実行の結果と、届けた結果）
 *   GET    /v1/notices                Mac がまだ出していないお知らせ
 *   POST   /v1/notices/ack            出したお知らせ（二度出さない）
 *
 * 予約を作るのは会話（handleTurn）だけ。言い直して確かめてから作る。
 */
import { GenieError } from '@genie/contracts';
import { nextRunAfter, type ScheduleService, type ScheduledJob } from '@genie/service-schedule';
import { z } from 'zod';
import type { App } from '../fastify.js';
import { requirePrincipal } from '../auth/middleware.js';

export interface ScheduleRouteDeps {
  readonly schedules: ScheduleService;
  readonly now?: () => number;
}

const Patch = z.object({ status: z.enum(['paused', 'active', 'cancelled']) });
const Ack = z.object({ ids: z.array(z.string().uuid()).min(1).max(100) });

function view(job: ScheduledJob) {
  return {
    id: job.id,
    name: job.name,
    status: job.status,
    kind: job.payload.kind,
    text: job.payload.text,
    schedule: job.schedule,
    tz: job.tz,
    next_run_at: job.nextRunAt?.toISOString() ?? null,
    last_run_at: job.lastRunAt?.toISOString() ?? null,
    last_status: job.lastStatus,
    last_error: job.lastError,
    consecutive_errors: job.consecutiveErrors,
    conversation_id: job.conversationId,
    created_at: job.createdAt.toISOString(),
  };
}

export function registerScheduleRoutes(app: App, deps: ScheduleRouteDeps): void {
  const store = deps.schedules.store;
  const now = deps.now ?? Date.now;

  app.get<{ Querystring: { all?: string } }>('/v1/schedules', async (request) => {
    const principal = requirePrincipal();
    const jobs = await store.list(principal.tenantId, principal.userId, {
      includeFinished: request.query.all === '1',
    });
    return { items: jobs.map(view) };
  });

  app.patch<{ Params: { id: string } }>('/v1/schedules/:id', async (request) => {
    const principal = requirePrincipal();
    const body = Patch.parse(request.body ?? {});
    const job = await store.get(principal.tenantId, principal.userId, request.params.id);
    if (!job) throw new GenieError('common.not_found', 'no such schedule');
    let next: Date | null = null;
    if (body.status === 'active') {
      const t = nextRunAfter(job.schedule, now());
      if (t === null) throw new GenieError('common.validation_failed', 'this schedule has no future run');
      next = new Date(t);
    }
    const updated = await store.setStatus(
      principal.tenantId,
      principal.userId,
      job.id,
      body.status,
      next,
    );
    if (!updated) throw new GenieError('common.conflict', 'the schedule cannot change to that state');
    return view(updated);
  });

  app.get<{ Params: { id: string } }>('/v1/schedules/:id/runs', async (request) => {
    const principal = requirePrincipal();
    const job = await store.get(principal.tenantId, principal.userId, request.params.id);
    if (!job) throw new GenieError('common.not_found', 'no such schedule');
    const runs = await store.runs(principal.tenantId, job.id);
    return {
      items: runs.map((r) => ({
        id: r.id,
        scheduled_for: r.scheduledFor,
        started_at: r.startedAt,
        finished_at: r.finishedAt,
        status: r.status,
        delivery_status: r.deliveryStatus,
        task_id: r.taskId,
        late_ms: r.lateMs,
        error: r.error,
      })),
    };
  });

  app.get('/v1/notices', async () => {
    const principal = requirePrincipal();
    const notices = await store.pendingNotices(principal.tenantId, principal.userId);
    return {
      items: notices.map((n) => ({
        id: n.id,
        kind: n.kind,
        title: n.title,
        body: n.body,
        job_id: n.jobId,
        task_id: n.taskId,
        created_at: n.createdAt,
      })),
    };
  });

  app.post('/v1/notices/ack', async (request) => {
    const principal = requirePrincipal();
    const body = Ack.parse(request.body ?? {});
    const acknowledged = await store.markNoticesDelivered(
      principal.tenantId,
      principal.userId,
      body.ids,
    );
    return { acknowledged };
  });
}
