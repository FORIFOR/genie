/**
 * Conversation の HTTP 表面。正本 §7・§19、Phase 7 実装仕様 §3。
 *
 * ここが Task Dock の入口になる。**Lane は返さない。**
 * 利用者に見せないものを API で配ると、いずれ画面に出る。
 */
import {
  SendTurnRequest,
  StartConversationRequest,
  type Referent,
  type TurnAttachment,
  type InjectionStats,
  type ReplyDraftMeta,
  type WorkArtifact,
} from '@genie/contracts';
import type { ConversationService } from '@genie/service-conversation';
import {
  clarificationFor,
  isDocumentRequest,
  remember,
  resolveReferences,
  routeLane,
  type FastDecisionEngine,
} from '@genie/service-conversation';
import { agentKindFor, type TaskService } from '@genie/service-task';
import type { Redis } from 'ioredis';
import {
  classifyContextIntent,
  renderReplyContext,
  replyBasis,
  replyInstruction,
  selectContextPack,
  type WorkContextService,
} from '@genie/service-world-model';
import type { App } from '../fastify.js';
import { parseLastEventId, pollingWaker, pumpEventStream, redisWaker } from './sse.js';
import { requirePrincipal } from '../auth/middleware.js';

export interface ConversationRouteDeps {
  readonly conversations: ConversationService;
  readonly tasks: TaskService;
  readonly redis: Redis | null;
  readonly ssePollIntervalMs?: number;
  /** Work Context。chat lane の問いに、関連する案件だけを `<work_context>` として添える（正本 §6、上限つき）。 */
  readonly work?: WorkContextService;
  /** Genie 自身の task・会議を artifact として足す（work routes と同じもの）。 */
  readonly extraArtifacts?: (tenantId: string) => Promise<WorkArtifact[]>;
  /**
   * Optional fast typed judgment for the deterministic router's chat fallback.
   * It never gets to override a lane that D-48 already classified.
   */
  readonly fastDecisions?: FastDecisionEngine;
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
      const id = request.params.conversationId;
      const body = SendTurnRequest.parse(request.body ?? {});

      const state = await deps.conversations.state(principal.tenantId, id);

      // barge-in。新しい入力が来たら、走っている応答を打ち切る（正本 §7.2）
      if (body.interrupt) {
        await deps.conversations.interruptLastAssistantTurn(principal.tenantId, id);
      }

      const turn = await deps.conversations.append({
        tenantId: principal.tenantId,
        conversationId: id,
        role: 'user',
        modality: body.modality,
        text: body.text,
      });

      const resolutions = resolveReferences(body.text, {
        referents: state.referents as Referent[],
        // いま見ているもの。会話に出ていなくても「この◯◯」は解ける（正本 §6）。
        // 撮ったばかりのスクショも「見ているもの」。「これ何？」はそれで解ける。
        contextLabels: [
          ...body.context_referents.map((r) => r.label),
          ...body.attachments.map((a) => a.label),
          // 「これ返して」の「これ」は、開いているメールの題名で解ける
          ...body.reply_candidates.map((c) => c.label),
        ],
      });
      const clarification = clarificationFor(resolutions);

      const baselineDecision = routeLane({
        text: body.text,
        modality: body.modality,
        meetingActive: state.active_meeting !== null,
        hasSelection: false,
        namedAgent: null,
      });
      // Reply-in-context has its own deterministic target resolution. Do not let a
      // generic fast classifier turn "これ返して" into an unrelated GUI task.
      const contextIntent = classifyContextIntent(body.text);
      const decision =
        baselineDecision.lane === 'chat' &&
        contextIntent !== 'email_reply' &&
        deps.fastDecisions
          ? await deps.fastDecisions.refine({
              text: body.text,
              modality: body.modality,
              baseline: baselineDecision,
            })
          : baselineDecision;

      let replyMeta: ReplyDraftMeta | null = null;
      let replyContext = '';
      let replyInstructionText = '';
      if (
        deps.work &&
        decision.lane === 'chat' &&
        contextIntent === 'email_reply'
      ) {
        const extra = (await deps.extraArtifacts?.(principal.tenantId).catch(() => [])) ?? [];
        const resolution = await deps.work
          .resolveReply(
            principal.tenantId,
            principal.userId,
            { utterance: body.text, candidates: body.reply_candidates },
            extra,
          )
          .catch(() => null);
        if (!resolution || resolution.status !== 'resolved') {
          const why =
            resolution?.status === 'ambiguous'
              ? `どのメールか特定できませんでした。候補が ${String(resolution.candidates.length)} 件あります: ${resolution.candidates.join(' / ')}。メールを開いてからもう一度どうぞ。`
              : 'どのメールか特定できませんでした。返信したいメールを開いてから、もう一度どうぞ。';
          const answer = await deps.conversations.append({
            tenantId: principal.tenantId,
            conversationId: id,
            role: 'assistant',
            modality: state.response_mode,
            text: why,
          });
          request.log.info(
            { reply_resolution: resolution?.status ?? 'error' },
            'reply target not resolved',
          );
          return reply.status(200).send({ turn, answer, needs_clarification: true });
        }
        const replyPack = await deps.work.replyPack(
          principal.tenantId,
          principal.userId,
          resolution,
          extra,
        );
        replyMeta = {
          target: replyPack.target,
          sources: replyPack.sources,
          basis: replyBasis(replyPack),
        };
        replyContext = renderReplyContext(replyPack);
        replyInstructionText = replyInstruction(replyPack);
        request.log.info(
          {
            reply_target: replyPack.target.artifact_id,
            sources: replyPack.sources.length,
            matched_by: replyPack.target.matched_by,
          },
          'reply in context',
        );
      }

      /*
       * 指示語が解けないまま先へ進めない。
       * 進めると、利用者が指したものとは別のものに対して動く。
       */
      if (clarification) {
        const answer = await deps.conversations.append({
          tenantId: principal.tenantId,
          conversationId: id,
          role: 'assistant',
          modality: state.response_mode,
          text: clarification,
        });
        return reply.status(200).send({ turn, answer, needs_clarification: true });
      }

      /*
       * ここで**仕事を始める。**
       *
       * 長らく lane を決めて `intent` を返すだけで、**何も始めていなかった。**
       * Home で頼んでも、Composer で頼んでも、Dock で頼んでも、
       * 会話に行が増えるだけで仕事は現れず、Dock は 10 秒待って諦めていた。
       */
      /*
       * 全データは渡さない（CONTEXT_MINIMIZATION_GATE）。問いの意図に応じた最小の pack だけ。
       * 渡した量（selected / available）は task の input と log に残し、後から数えられるようにする。
       */
      /*
       * 「これ返して」（REPLY_IN_CONTEXT）。端末の候補（開いているメール → 選択 → 前面の窓）と発話から
       * **決定的に**相手を決め、曖昧なら似たメールを選ばずに聞き返す。決まったら、そのスレッド・案件・
       * 直近の会議・開いている件だけを添えて返信案を書かせる（送らない）。
       */
      const pack =
        deps.work && decision.lane === 'chat' && !replyMeta
          ? await deps.work
              .context(principal.tenantId, principal.userId)
              .then(async (ctx) =>
                selectContextPack({
                  question: body.text,
                  context: ctx,
                  meetingBrief:
                    ctx.inference_enabled && contextIntent === 'meeting_prep'
                      ? await deps.work!.meetingBrief(principal.tenantId, principal.userId)
                      : null,
                }),
              )
              .catch(() => null)
          : null;
      if (pack) request.log.info({ work_context: pack.stats }, 'context minimization');
      const started = await startWork(
        deps,
        principal,
        id,
        body.text,
        decision.lane,
        turn.id,
        body.attachments,
        replyMeta ? replyContext : (pack?.text ?? ''),
        pack?.stats ?? null,
        replyMeta ? { meta: replyMeta, instruction: replyInstructionText } : null,
      );

      // Lane は返さない。利用者に見せないものを API で配らない。
      return reply.status(202).send({
        turn,
        needs_clarification: false,
        // 何をする話かは、次に作られる task の kind として現れる
        intent: laneToIntent(decision.lane),
        task_id: started.taskId,
        // 始められなかった理由。**黙って intent だけ返さない。**
        notice: started.notice,
        // 返信案なら、宛先・出所・何を踏まえたか（本文は task の成果物）。
        ...(replyMeta ? { reply: replyMeta } : {}),
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

/**
 * Lane を、利用者にも見せてよい言葉へ直す。
 * 内部名（`specialist-agent` など）をそのまま出さない。
 */
function laneToIntent(lane: string): string {
  switch (lane) {
    case 'research':
      return 'looking_up';
    case 'action':
      return 'doing';
    case 'edit':
      return 'editing';
    case 'meeting':
      return 'meeting';
    case 'dictate':
      return 'writing_down';
    case 'specialist-agent':
      return 'delegating';
    default:
      return 'talking';
  }
}

/**
 * Lane に応じて仕事を作る。
 *
 *   chat     → General Assistant（正本 §2.2）。答えは成果物として残る
 *   research → Research Agent（§8）
 *   action   → Computer Use。既存の task / approval / native safety boundary を通す
 *   meeting  → 仕事にしない。録音は画面側の操作（§12）
 *   edit / dictate / specialist-agent → まだ自動では受けられない。**そう言う**
 *
 * 作れなかった理由（plugin が入っていない等）は `notice` で返す。
 * 例外で 500 にすると、利用者には「送れなかった」としか見えない。
 */
async function startWork(
  deps: ConversationRouteDeps,
  principal: { tenantId: string; userId: string },
  conversationId: string,
  text: string,
  lane: string,
  turnId: string,
  attachments: readonly TurnAttachment[] = [],
  workContext = '',
  contextStats: InjectionStats | null = null,
  replyDraft: { meta: ReplyDraftMeta; instruction: string } | null = null,
): Promise<{ taskId: string | null; notice: string | null }> {
  const request =
    lane === 'chat'
      ? {
          kind: agentKindFor('com.astra.general', 'assistant'),
          // 添付は id とラベルだけ。画素は端末に残り、端末のモデル呼び出しが読む。
          // context は Work Graph から選んだ関連分だけ（無ければ付けない）。
          input: {
            question: text,
            message: text,
            // 返信案: compose の段だけを走らせる（instruction がある = compose）。送らない。
            ...(isDocumentRequest(text) ? { instruction: text } : {}),
            ...(replyDraft ? { instruction: replyDraft.instruction, reply: replyDraft.meta } : {}),
            ...(attachments.length > 0 ? { attachments: [...attachments] } : {}),
            ...(workContext ? { context: workContext } : {}),
            // 渡した量の事実。何を知っているかではなく、何を渡したか。
            ...(contextStats ? { context_meta: contextStats } : {}),
          },
        }
      : lane === 'research'
        ? { kind: 'research', input: { question: text } }
        : lane === 'action'
          ? {
              kind: 'computer.run',
              input: {
                goal: text,
                // Keep success criteria user-authored. The vision verifier must not
                // invent a stronger completion condition than the request.
                successCriteria: text,
                title: text.slice(0, 160),
              },
            }
          : null;

  if (!request) {
    return {
      taskId: null,
      notice: lane === 'meeting' ? null : 'この頼みごとは、まだ自動では進められません。',
    };
  }

  try {
    const { task } = await deps.tasks.create({
      tenantId: principal.tenantId,
      userId: principal.userId,
      request: { ...request, conversation_id: conversationId as never },
      // 同じ発話を二度仕事にしない
      idempotencyKey: `turn:${turnId}`,
    });
    return { taskId: task.id, notice: null };
  } catch (error) {
    return {
      taskId: null,
      notice:
        lane === 'action'
          ? '画面操作を開始できませんでした。Computer Use の有効化・権限・端末接続を確認してください。'
          : error instanceof Error && /install|not installed|permission|scope/i.test(error.message)
            ? 'General Assistant が追加されていません。Apps から追加してください。'
            : '仕事を始められませんでした。',
    };
  }
}
