/**
 * Task の HTTP 表面。実装仕様 §11。
 *
 * ここは HTTP ↔ TaskService の変換だけを行う。業務判断は service 側にある（ADR 0004）。
 */
import type { Redis } from 'ioredis';
import {
  ApprovalDecision,
  GenieError,
  CancelTaskRequest,
  CreateTaskRequest,
  HEADER_IDEMPOTENCY_KEY,
  IdempotencyKey,
  PageQuery,
  dockStateFor,
  AddTaskInstructionRequest,
} from '@genie/contracts';
import type { TaskService } from '@genie/service-task';
import type { App } from '../fastify.js';
import { requirePrincipal } from '../auth/middleware.js';
import { CREATE_TASK_RATE_LIMIT } from '../plugins/rate-limit.js';
import { parseLastEventId, pollingWaker, pumpEventStream, redisWaker } from './sse.js';

/** Evidence Ledger を引く口。読むだけなので、検索も生成も要らない（§5.1）。 */
export interface EvidenceReader {
  ledger(tenantId: string, taskId: string): Promise<unknown>;
}

export interface TaskRouteDeps {
  readonly tasks: TaskService;
  /** UI/UX §15 の Evidence。無ければその経路は 404 のまま。 */
  readonly evidence?: EvidenceReader;
  readonly redis: Redis | null;
  /** SSE のポーリング間隔。Redis があれば「起こされなかったとき」の上限として働く。 */
  readonly ssePollIntervalMs?: number;
}

export function registerTaskRoutes(app: App, deps: TaskRouteDeps): void {
  app.post(
    '/v1/tasks',
    { config: { rateLimit: CREATE_TASK_RATE_LIMIT } },
    async (request, reply) => {
      const principal = requirePrincipal();
      const header = request.headers[HEADER_IDEMPOTENCY_KEY];
      const parsedKey = IdempotencyKey.safeParse(Array.isArray(header) ? header[0] : header);
      if (!parsedKey.success) {
        // 実装仕様 §11: POST /v1/tasks では必須。無いまま受けると再送で二重実行になる。
        throw new GenieError(
          'common.validation_failed',
          `${HEADER_IDEMPOTENCY_KEY} header is required (8-128 chars)`,
        );
      }

      const body = CreateTaskRequest.parse(request.body ?? {});
      const result = await deps.tasks.create({
        tenantId: principal.tenantId,
        userId: principal.userId,
        request: body,
        idempotencyKey: parsedKey.data,
      });

      // 冪等な再送は 200、新規受理は 202（実行はこれから）
      return reply.status(result.deduplicated ? 200 : 202).send(result.task);
    },
  );

  app.get('/v1/tasks', async (request) => {
    const principal = requirePrincipal();
    const query = PageQuery.parse(request.query ?? {});
    const page = await deps.tasks.list(principal.tenantId, query.limit, query.cursor);
    return { items: page.items, next_cursor: page.nextCursor };
  });

  app.get<{ Params: { taskId: string } }>('/v1/tasks/:taskId', async (request) => {
    const principal = requirePrincipal();
    const task = await deps.tasks.get(principal.tenantId, request.params.taskId);
    // Dock の表示状態はサーバが導く。クライアントごとに解釈がぶれないようにするため。
    return { ...task, dock_state: dockStateFor(task.status, task.error) };
  });

  app.get<{ Params: { taskId: string } }>('/v1/tasks/:taskId/receipts', async (request) => {
    const principal = requirePrincipal();
    // UI/UX §22: 監査ログは管理者向け。本人には受け取りの控えを人が読める形で返す。
    const items = await deps.tasks.receipts(principal.tenantId, request.params.taskId);
    return { items };
  });

  app.get<{ Params: { taskId: string } }>('/v1/tasks/:taskId/evidence', async (request) => {
    const principal = requirePrincipal();
    // 存在しない / 他テナントなら、evidence を見に行く前に 404
    await deps.tasks.get(principal.tenantId, request.params.taskId);
    if (!deps.evidence) {
      throw new GenieError('common.not_found', 'evidence is not available in this deployment');
    }
    // UI/UX §15: L0〜L3 を 1 度に返す。段ごとに待たせない。
    return deps.evidence.ledger(principal.tenantId, request.params.taskId);
  });

  app.post<{ Params: { taskId: string } }>('/v1/tasks/:taskId/cancel', async (request) => {
    const principal = requirePrincipal();
    const body = CancelTaskRequest.parse(request.body ?? {});
    return deps.tasks.cancel(principal.tenantId, request.params.taskId, body.reason);
  });

  /**
   * 動いている仕事への追加指示。返すのは「受け取った」（202）。反映したかは一覧で分かる
   * （APPLIED と段 / NOT_APPLIED）。終わった仕事には 409（続きは新しい仕事として頼む）。
   */
  app.post<{ Params: { taskId: string } }>('/v1/tasks/:taskId/instructions', async (request, reply) => {
    const principal = requirePrincipal();
    const body = AddTaskInstructionRequest.parse(request.body ?? {});
    const instruction = await deps.tasks.addInstruction(
      principal.tenantId,
      request.params.taskId,
      principal.userId,
      body,
    );
    return reply.status(202).send(instruction);
  });

  app.get<{ Params: { taskId: string } }>('/v1/tasks/:taskId/instructions', async (request) => {
    const principal = requirePrincipal();
    return { items: await deps.tasks.listInstructions(principal.tenantId, request.params.taskId) };
  });

  app.get<{ Params: { taskId: string } }>('/v1/tasks/:taskId/approvals', async (request) => {
    const principal = requirePrincipal();
    return { items: await deps.tasks.pendingApprovals(principal.tenantId, request.params.taskId) };
  });

  app.post<{ Params: { taskId: string } }>('/v1/tasks/:taskId/approve', async (request, reply) => {
    const principal = requirePrincipal();
    const body = ApprovalDecision.parse(request.body ?? {});
    await deps.tasks.decideApproval(
      principal.tenantId,
      request.params.taskId,
      principal.userId,
      body.approval_id,
      body.decision,
    );
    return reply.status(204).send();
  });

  app.get<{ Params: { taskId: string } }>(
    '/v1/tasks/:taskId/stream',
    { config: { rateLimit: false } },
    async (request, reply) => {
      const principal = requirePrincipal();
      const taskId = request.params.taskId;

      // 存在しない / 他テナントのタスクなら、ストリームを開く前に 404 を返す
      await deps.tasks.get(principal.tenantId, taskId);

      // 購読はリプレイの前に張る（実装仕様 §7.3）
      const waker = deps.redis ? await redisWaker(deps.redis, 'task', taskId) : pollingWaker();

      reply.raw.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      });
      reply.hijack();

      let open = true;
      const close = (): void => {
        open = false;
      };
      request.raw.on('close', close);
      request.raw.on('error', close);

      try {
        await pumpEventStream({
          write: (chunk) => {
            if (open) reply.raw.write(chunk);
          },
          isOpen: () => open && !reply.raw.destroyed,
          fetchAfter: (sequence) => deps.tasks.eventsAfter(principal.tenantId, taskId, sequence),
          waker,
          startAfter: parseLastEventId(request.headers['last-event-id']),
          ...(deps.ssePollIntervalMs === undefined
            ? {}
            : { pollIntervalMs: deps.ssePollIntervalMs }),
        });
      } finally {
        await waker.close();
        if (!reply.raw.destroyed) reply.raw.end();
      }
    },
  );
}
