/**
 * Work Context / Personalization の HTTP 表面。正本 §6・§10、Phase 6。
 *
 *   GET  /v1/work/context            Home の「今日、気にした方がいいこと」「待っていること」「返すもの」「今週の負荷」
 *   GET  /v1/work/evidence/:itemId   その item の出所（artifact そのもの。抜粋だけ、全文は無い）
 *   POST /v1/work/corrections        本人の訂正（1 操作）
 *   POST /v1/work/artifacts          端末の worker からの取り込み（正規化済み。全文は来ない）
 *   GET  /v1/work/sync               source ごとの同期位置（端末はここから続きを読む）
 *   POST /v1/work/sync/:source/attempt  同期の試み（失敗の理由。cursor は動かさない）
 *   GET  /v1/personalization         Genie が今あなたについて使っている情報
 *   PUT  /v1/personalization         確認・使わない・全体の停止
 *
 * Genie 自身の task と会議も同じ artifact として混ぜる（cross-source）。
 */
import {
  canonicalSha256,
  InitialProfileOutcome,
  InitialProfileSections,
  PersonalizationUpdate,
  SendReplyRequest,
  WorkArtifactBatch,
  WorkCorrection,
  WorkSource,
  WorkSyncAttempt,
  type WorkArtifact,
} from '@genie/contracts';
import { z } from 'zod';
import type { TaskService } from '@genie/service-task';
import type { MeetingService } from '@genie/service-meeting';
import type { WorkContextService } from '@genie/service-world-model';
import type { App } from '../fastify.js';
import { requirePrincipal } from '../auth/middleware.js';

export interface WorkRouteDeps {
  readonly work: WorkContextService;
  readonly tasks: TaskService;
  readonly meetings?: MeetingService;
}

/** Genie の task と会議を、同じ形にする（端末からは来ない、cloud が持っているもの）。 */
export async function localArtifacts(
  deps: WorkRouteDeps,
  tenantId: string,
): Promise<WorkArtifact[]> {
  const out: WorkArtifact[] = [];
  const tasks = await deps.tasks.list(tenantId, 50).catch(() => ({
    items: [] as {
      id: string;
      title: string | null;
      status: string;
      updated_at: string;
      created_at?: string;
    }[],
  }));
  for (const t of tasks.items) {
    if (!t.title) continue;
    const open = !['COMPLETED', 'FAILED', 'CANCELLED'].includes(t.status);
    out.push({
      id: 'astra_task:' + t.id,
      source: 'astra_task',
      kind: 'task',
      title: t.title,
      body_excerpt: null,
      people: [],
      direction: 'self',
      occurred_at: t.updated_at,
      ends_at: null,
      due_at: null,
      thread_id: null,
      project_hint: null,
      responded: null,
      completed: !open,
      provenance: {
        source: 'astra_task',
        external_id: t.id,
        label: t.title,
        observed_at: t.updated_at,
        url: null,
        excerpt: null,
      },
      semantic: null,
      origin: null,
    });
  }
  const meetings = (await deps.meetings?.list(tenantId, 30).catch(() => [])) ?? [];
  for (const m of meetings) {
    out.push({
      id: 'meeting:' + m.id,
      source: 'meeting',
      kind: 'meeting',
      title: m.title,
      body_excerpt: null,
      people: [],
      direction: 'self',
      occurred_at: m.started_at,
      ends_at: m.ended_at ?? null,
      due_at: null,
      thread_id: null,
      project_hint: null,
      responded: null,
      completed: null,
      provenance: {
        source: 'meeting',
        external_id: m.id,
        label: m.title,
        observed_at: m.started_at,
        url: null,
        excerpt: null,
      },
      semantic: null,
      origin: null,
    });
  }
  return out;
}

export function registerWorkRoutes(app: App, deps: WorkRouteDeps): void {
  app.get('/v1/work/initial-profile', async () => {
    const p = requirePrincipal();
    return { profile: await deps.work.initialProfile.get(p.tenantId, p.userId) };
  });
  app.post('/v1/work/initial-profile', async (request) => {
    const p = requirePrincipal();
    const body = z.object({ provider: z.enum(['google', 'microsoft']) }).parse(request.body);
    return { profile: await deps.work.initialProfile.begin(p.tenantId, p.userId, body.provider) };
  });
  app.post('/v1/work/initial-profile/claim', async () => {
    const p = requirePrincipal();
    return { job: await deps.work.initialProfile.claim(p.tenantId, p.userId) };
  });
  app.post('/v1/work/initial-profile/artifacts', async (request, reply) => {
    const p = requirePrincipal();
    const body = z.object({ lease: z.uuid(), batch: WorkArtifactBatch }).parse(request.body);
    const ok = await deps.work.initialProfile.ingest(p.tenantId, p.userId, body.lease, body.batch);
    return reply.status(ok ? 204 : 409).send();
  });
  app.post('/v1/work/initial-profile/progress', async (request, reply) => {
    const p = requirePrincipal();
    const body = z
      .object({
        lease: z.uuid(),
        outcome: InitialProfileOutcome,
        artifact_ids: z.array(z.string().max(512)).max(5000).default([]),
      })
      .parse(request.body);
    const ok = await deps.work.initialProfile.progress(
      p.tenantId,
      p.userId,
      body.lease,
      body.outcome,
      body.artifact_ids,
    );
    return reply.status(ok ? 204 : 409).send();
  });
  app.post('/v1/work/initial-profile/finish', async (request, reply) => {
    const p = requirePrincipal();
    const body = z
      .object({ lease: z.uuid(), artifact_ids: z.array(z.string().max(512)).max(5000) })
      .parse(request.body);
    const ok = await deps.work.initialProfile.finish(
      p.tenantId,
      p.userId,
      body.lease,
      body.artifact_ids,
    );
    return reply.status(ok ? 204 : 409).send();
  });
  app.post('/v1/work/initial-profile/retry', async (_request, reply) => {
    const p = requirePrincipal();
    await deps.work.initialProfile.retry(p.tenantId, p.userId);
    return reply.status(204).send();
  });
  app.put('/v1/work/initial-profile', async (request, reply) => {
    const p = requirePrincipal();
    const sections = InitialProfileSections.parse(request.body);
    const ok = await deps.work.initialProfile.confirm(p.tenantId, p.userId, sections);
    return reply.status(ok ? 204 : 409).send();
  });

  app.get('/v1/work/context', async () => {
    const p = requirePrincipal();
    return deps.work.context(p.tenantId, p.userId, await localArtifacts(deps, p.tenantId));
  });

  app.get<{ Params: { itemId: string } }>('/v1/work/evidence/:itemId', async (request) => {
    const p = requirePrincipal();
    return {
      items: await deps.work.evidence(
        p.tenantId,
        p.userId,
        request.params.itemId,
        await localArtifacts(deps, p.tenantId),
      ),
    };
  });

  app.post('/v1/work/corrections', async (request, reply) => {
    const p = requirePrincipal();
    await deps.work.correct(p.tenantId, p.userId, WorkCorrection.parse(request.body ?? {}));
    return reply.status(204).send();
  });

  app.post('/v1/work/artifacts', async (request, reply) => {
    const p = requirePrincipal();
    // 途中で切れた絵文字（片割れのサロゲート）は Postgres の json が受け付けない。保存の前に置き換える。
    const batch = WorkArtifactBatch.parse(wellFormed(request.body ?? {}));
    const result = await deps.work.ingest(p.tenantId, p.userId, batch);
    return reply.status(202).send(result);
  });

  app.get('/v1/work/sync', async () => {
    const p = requirePrincipal();
    return { items: await deps.work.syncState(p.tenantId, p.userId) };
  });

  app.post<{ Params: { source: string } }>(
    '/v1/work/sync/:source/attempt',
    async (request, reply) => {
      const p = requirePrincipal();
      await deps.work.recordAttempt(
        p.tenantId,
        p.userId,
        WorkSource.parse(request.params.source),
        WorkSyncAttempt.parse(request.body ?? {}),
      );
      return reply.status(204).send();
    },
  );

  /** 次の会議の brief（MEETING_BRIEF）。無ければ 204。 */
  app.get('/v1/work/brief/next', async (request, reply) => {
    const p = requirePrincipal();
    const brief = await deps.work.meetingBrief(
      p.tenantId,
      p.userId,
      await localArtifacts(deps, p.tenantId),
    );
    if (!brief) return reply.status(204).send();
    request.log.info(
      { event: brief.event_id, questions: brief.suggested_questions.length },
      'meeting brief',
    );
    return brief;
  });

  app.get<{ Params: { eventId: string } }>('/v1/work/brief/:eventId', async (request, reply) => {
    const p = requirePrincipal();
    const brief = await deps.work.meetingBrief(
      p.tenantId,
      p.userId,
      await localArtifacts(deps, p.tenantId),
      request.params.eventId,
    );
    if (!brief)
      return reply
        .status(404)
        .send({ error: { code: 'common.not_found', message: 'no such event' } });
    return brief;
  });

  /**
   * 返信を送る。**本人が確認カードで押したあとにだけ**来る。
   * 送るのは task（mail.send、EXTERNAL_COMMIT）で、承認 → 端末の送る接続 → 送信。
   * 承認は別の呼び出し（POST /v1/tasks/:id/approve）— ここで自動承認しない。
   */
  app.post('/v1/work/reply/send', async (request, reply) => {
    const p = requirePrincipal();
    const body = SendReplyRequest.parse(request.body ?? {});
    if (body.source !== 'gmail' && body.source !== 'outlook_mail') {
      return reply.status(409).send({
        error: {
          code: 'connector.unsupported',
          message: 'この送り元からはまだ送れません（Gmail / Outlook から送れます）。',
        },
      });
    }
    if (body.source === 'outlook_mail' && !body.in_reply_to) {
      return reply.status(400).send({
        error: {
          code: 'common.validation_failed',
          message: 'Outlook の返信には相手のメッセージ id が要ります。',
        },
      });
    }
    const replyFingerprint = await canonicalSha256(body);
    const { task } = await deps.tasks.create({
      tenantId: p.tenantId,
      userId: p.userId,
      request: {
        kind: 'mail.send',
        title: `返信: ${body.subject}`,
        input: {
          source: body.source,
          to: body.to,
          subject: body.subject,
          body: body.body,
          in_reply_to: body.in_reply_to,
          thread_id: body.thread_id,
        },
      },
      idempotencyKey: `reply:${p.userId}:${replyFingerprint}`,
    });
    return reply.status(202).send({ task_id: task.id });
  });

  app.get('/v1/personalization', async () => {
    const p = requirePrincipal();
    return deps.work.personalization(p.tenantId, p.userId);
  });

  app.put('/v1/personalization', async (request) => {
    const p = requirePrincipal();
    return deps.work.updateProfile(
      p.tenantId,
      p.userId,
      PersonalizationUpdate.parse(request.body ?? {}),
    );
  });
}

/**
 * 文字列の中の片割れのサロゲート（例: 「…\ud83d」で切れた絵文字）を U+FFFD に置き換える。
 * 2026-10-07: メールの抜粋が絵文字の途中で切れ、Gmail の取り込みが 500（22P02）で止まっていた。
 */
export function wellFormed(value: unknown): unknown {
  if (typeof value === 'string') return replaceLoneSurrogates(value);
  if (Array.isArray(value)) return value.map(wellFormed);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [replaceLoneSurrogates(k), wellFormed(v)]),
    );
  return value;
}

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
function replaceLoneSurrogates(text: string): string {
  return text.replace(LONE_SURROGATE, '\uFFFD');
}
