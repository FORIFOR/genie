/**
 * Conversation の HTTP 表面。正本 §7・§19、Phase 7 実装仕様 §3。
 *
 * ここが Task Dock の入口になる。**Lane は返さない。**
 * 利用者に見せないものを API で配ると、いずれ画面に出る。
 *
 * 発話から仕事を始めるまでは `handleTurn`（service-conversation）にある。
 * チャネル（Slack / LINE）も同じものを呼ぶ。ここは HTTP との変換だけ。
 */
import {
  SendTurnRequest,
  StartConversationRequest,
  GenieError,
  ConversationId,
  type Referent,
} from '@genie/contracts';
import { z } from 'zod';
import type { ConversationService, TurnDeps } from '@genie/service-conversation';
import { handleTurn, remember } from '@genie/service-conversation';
import type { Redis } from 'ioredis';
import type { App } from '../fastify.js';
import { parseLastEventId, pollingWaker, pumpEventStream, redisWaker } from './sse.js';
import { requirePrincipal } from '../auth/middleware.js';

export interface ConversationRouteDeps extends TurnDeps {
  readonly conversations: ConversationService;
  readonly redis: Redis | null;
  readonly ssePollIntervalMs?: number;
}

export function registerConversationRoutes(app: App, deps: ConversationRouteDeps): void {
  app.post('/v1/conversations', async (request, reply) => {
    const principal = requirePrincipal();
    const body = StartConversationRequest.parse(request.body ?? {});
    const started = await deps.conversations.start(principal.tenantId, principal.userId, {
      ...(body.title === undefined ? {} : { title: body.title }),
      responseMode: body.response_mode,
    });
    return reply.status(201).send({ id: started.id, state: started.state });
  });

  app.get<{ Params: { conversationId: string } }>(
    '/v1/conversations/:conversationId',
    async (request) => {
      const principal = requirePrincipal();
      const id = request.params.conversationId;
      const [state, turns, summaries] = await Promise.all([
        deps.conversations.state(principal.tenantId, id),
        deps.conversations.recentTurns(principal.tenantId, id),
        deps.conversations.summaries(principal.tenantId, id),
      ]);
      return { id, state, turns, summaries };
    },
  );

  /**
   * SSE。正本 §19 `GET /v1/conversations/{id}/stream`、§20 の統一 envelope（sequence 付き）を流す。
   * Last-Event-ID で再開できる（取りこぼしを検知できるよう sequence は詰めない）。
   */
  app.get<{ Params: { conversationId: string } }>(
    '/v1/conversations/:conversationId/stream',
    { config: { rateLimit: false } },
    async (request, reply) => {
      const principal = requirePrincipal();
      const conversationId = request.params.conversationId;
      // 存在しない / 他テナントならストリームを開く前に 404
      await deps.conversations.state(principal.tenantId, conversationId);

      // 購読はリプレイの前に張る（実装仕様 §7.3）
      const waker = deps.redis
        ? await redisWaker(deps.redis, 'conversation', conversationId)
        : pollingWaker();

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
          fetchAfter: (sequence) =>
            deps.conversations.eventsAfter(principal.tenantId, conversationId, sequence),
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

  app.get<{ Params: { conversationId: string; requestId: string } }>(
    '/v1/conversations/:conversationId/requests/:requestId',
    async (request) => {
      const principal = requirePrincipal();
      return deps.conversations.requestStatus(
        principal.tenantId,
        principal.userId,
        ConversationId.parse(request.params.conversationId),
        z.uuid().parse(request.params.requestId),
      );
    },
  );

  /**
   * 発話を受ける。
   *
   * ここで決まるのは「何をする話か（Lane）」と「指示語が解けたか」だけ。
   * **解けなかったら聞き返す**。埋めて進めない（D-49）。
   */
  app.post<{ Params: { conversationId: string } }>(
    '/v1/conversations/:conversationId/turns',
    async (request, reply) => {
      const principal = requirePrincipal();
      const body = SendTurnRequest.parse(request.body ?? {});
      const id = request.params.conversationId;

      // 受け取りの控え（request_id）。同じ依頼の送り直しで仕事を二重に作らない。
      const receipt = body.request_id
        ? await deps.conversations.reserveRequest(
            principal.tenantId,
            principal.userId,
            id,
            body.request_id,
            body,
          )
        : null;
      if (receipt && !receipt.fresh) {
        if (receipt.response) return reply.status(receipt.status!).send(receipt.response);
        const recovered = await deps.conversations.requestStatus(
          principal.tenantId,
          principal.userId,
          id,
          body.request_id!,
        );
        if (recovered.status === 'resolved') return reply.status(202).send(recovered.response);
        throw new GenieError(
          'common.conflict',
          'request is pending; query its receipt instead of submitting again',
        );
      }
      const respond = async (status: number, response: Record<string, unknown>) => {
        if (body.request_id)
          await deps.conversations.finishRequest(
            principal.tenantId,
            principal.userId,
            id,
            body.request_id,
            status,
            response,
          );
        return reply.status(status).send(response);
      };

      const result = await handleTurn(deps, {
        principal,
        conversationId: id,
        body,
        log: request.log,
        ...(receipt ? { turnId: receipt.turnId } : {}),
        ...(body.request_id
          ? {
              onPrepared: (response: Record<string, unknown>, dispatchTurnId?: string) =>
                deps.conversations.prepareRequest(
                  principal.tenantId,
                  principal.userId,
                  id,
                  body.request_id!,
                  response,
                  dispatchTurnId,
                ),
            }
          : {}),
      });

      if (result.kind === 'clarification') {
        return respond(200, { turn: result.turn, answer: result.answer, needs_clarification: true });
      }
      if (result.kind === 'answered') {
        return respond(200, {
          turn: result.turn,
          answer: result.answer,
          needs_clarification: result.needsClarification,
        });
      }
      const started = result;

      // A task may be durable even if runtime dispatch threw. Reconcile before
      // storing a negative notice so a lost dispatch response cannot hide the task.
      if (body.request_id && !started.taskId) {
        const recovered = await deps.conversations.requestStatus(
          principal.tenantId,
          principal.userId,
          id,
          body.request_id,
        );
        if (recovered.status === 'resolved') return respond(202, recovered.response!);
      }
      // Lane は返さない。利用者に見せないものを API で配らない。
      return respond(202, {
        turn: result.turn,
        needs_clarification: false,
        intent: result.intent,
        task_id: result.taskId,
        notice: result.notice,
        // 返信案なら、宛先・出所・何を踏まえたか（本文は task の成果物）。
        ...(result.reply ? { reply: result.reply } : {}),
      });
    },
  );

  /** 触れたものを覚える。「それ」の解決先になる。 */
  app.post<{ Params: { conversationId: string } }>(
    '/v1/conversations/:conversationId/referents',
    async (request, reply) => {
      const principal = requirePrincipal();
      const id = request.params.conversationId;
      const state = await deps.conversations.state(principal.tenantId, id);
      const next = request.body as Omit<Referent, 'index'>;

      await deps.conversations.rememberReferent(
        principal.tenantId,
        id,
        remember(state.referents as Referent[], next),
      );
      return reply.status(204).send();
    },
  );
}
