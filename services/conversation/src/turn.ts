/**
 * 発話を受けて、仕事を始めるまで。正本 §6・§7、Phase 7 実装仕様 §3。
 *
 * HTTP（Task Dock）と、これから来るチャネル（Slack / LINE / 電話）の**同じ入口**。
 * 入口ごとに作り直すと、同じ頼みごとが入口によって違う扱いになる。
 * ここは HTTP を知らない。状態コードへの写し方は呼ぶ側が決める。
 */
import type {
  InjectionStats,
  Referent,
  ReplyDraftMeta,
  SendTurnRequest,
  Turn,
  TurnAttachment,
  WorkArtifact,
} from '@genie/contracts';
import { agentKindFor, type TaskService } from '@genie/service-task';
import {
  classifyContextIntent,
  renderReplyContext,
  replyBasis,
  replyInstruction,
  selectContextPack,
  type WorkContextService,
} from '@genie/service-world-model';
import { isDocumentRequest, routeLane } from './lane.js';
import { clarificationFor, resolveReferences } from './reference.js';
import type { ConversationService } from './service.js';

/** 記録だけ。どこへ書くかは呼ぶ側（gateway なら request.log）。 */
export interface TurnLogger {
  info(fields: Record<string, unknown>, message: string): void;
}

export interface TurnDeps {
  readonly conversations: ConversationService;
  readonly tasks: TaskService;
  /** Work Context。chat lane の問いに、関連する案件だけを `<work_context>` として添える（正本 §6、上限つき）。 */
  readonly work?: WorkContextService;
  /** Genie 自身の task・会議を artifact として足す（work routes と同じもの）。 */
  readonly extraArtifacts?: (tenantId: string) => Promise<WorkArtifact[]>;
}

export interface HandleTurnInput {
  readonly principal: { readonly tenantId: string; readonly userId: string };
  readonly conversationId: string;
  /** 検証済みの発話。チャネルから来るものも、同じ形に直してから渡す。 */
  readonly body: SendTurnRequest;
  readonly log?: TurnLogger;
}

/**
 * 結果は 2 通り。
 *
 *   clarification → 聞き返した（仕事は始めていない）
 *   started       → 仕事を始めた、または始められない理由を `notice` に持つ
 *
 * **Lane は含めない。**利用者に見せないものを、入口の外へ出さない。
 */
export type HandleTurnResult =
  | { readonly kind: 'clarification'; readonly turn: Turn; readonly answer: Turn }
  | {
      readonly kind: 'started';
      readonly turn: Turn;
      readonly intent: string;
      readonly taskId: string | null;
      readonly notice: string | null;
      readonly reply: ReplyDraftMeta | null;
    };

const silent: TurnLogger = { info: () => undefined };

/**
 * ここで決まるのは「何をする話か（Lane）」と「指示語が解けたか」だけ。
 * **解けなかったら聞き返す**。埋めて進めない（D-49）。
 */
export async function handleTurn(
  deps: TurnDeps,
  input: HandleTurnInput,
): Promise<HandleTurnResult> {
  const { principal, conversationId: id, body } = input;
  const log = input.log ?? silent;

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

  const decision = routeLane({
    text: body.text,
    modality: body.modality,
    meetingActive: state.active_meeting !== null,
    hasSelection: false,
    namedAgent: null,
  });

  const answerWith = (text: string): Promise<Turn> =>
    deps.conversations.append({
      tenantId: principal.tenantId,
      conversationId: id,
      role: 'assistant',
      modality: state.response_mode,
      text,
    });

  let replyMeta: ReplyDraftMeta | null = null;
  let replyContext = '';
  let replyInstructionText = '';
  if (deps.work && decision.lane === 'chat' && classifyContextIntent(body.text) === 'email_reply') {
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
      const answer = await answerWith(why);
      log.info({ reply_resolution: resolution?.status ?? 'error' }, 'reply target not resolved');
      return { kind: 'clarification', turn, answer };
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
    log.info(
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
    return { kind: 'clarification', turn, answer: await answerWith(clarification) };
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
  const work = deps.work;
  const pack =
    work && decision.lane === 'chat' && !replyMeta
      ? await work
          .context(principal.tenantId, principal.userId)
          .then(async (ctx) =>
            selectContextPack({
              question: body.text,
              context: ctx,
              meetingBrief:
                ctx.inference_enabled && classifyContextIntent(body.text) === 'meeting_prep'
                  ? await work.meetingBrief(principal.tenantId, principal.userId)
                  : null,
            }),
          )
          .catch(() => null)
      : null;
  if (pack) log.info({ work_context: pack.stats }, 'context minimization');

  const started = await startWork(deps, principal, id, turn.id, {
    text: body.text,
    lane: decision.lane,
    attachments: body.attachments,
    workContext: replyMeta ? replyContext : (pack?.text ?? ''),
    contextStats: pack?.stats ?? null,
    replyDraft: replyMeta ? { meta: replyMeta, instruction: replyInstructionText } : null,
  });

  return {
    kind: 'started',
    turn,
    // 何をする話かは、次に作られる task の kind として現れる
    intent: laneToIntent(decision.lane),
    taskId: started.taskId,
    // 始められなかった理由。**黙って intent だけ返さない。**
    notice: started.notice,
    reply: replyMeta,
  };
}

/**
 * Lane を、利用者にも見せてよい言葉へ直す。
 * 内部名（`specialist-agent` など）をそのまま出さない。
 */
export function laneToIntent(lane: string): string {
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

/** 仕事の種類を決めるのに要るもの。発話と、Lane と、添えるものだけ。 */
export interface LaneTaskInput {
  readonly text: string;
  readonly lane: string;
  readonly attachments?: readonly TurnAttachment[];
  readonly workContext?: string;
  readonly contextStats?: InjectionStats | null;
  readonly replyDraft?: { readonly meta: ReplyDraftMeta; readonly instruction: string } | null;
}

/** `TaskService.create` に渡す依頼の中身（conversation_id は呼ぶ側が足す）。 */
export interface LaneTaskRequest {
  readonly kind: string;
  readonly input: Record<string, unknown>;
}

/**
 * Lane に応じて、どの仕事にするかを決める。**純粋関数。**
 *
 *   chat     → General Assistant（正本 §2.2）。答えは成果物として残る
 *   research → Research Agent（§8）
 *   meeting  → 仕事にしない。録音は画面側の操作（§12）
 *   action / edit / dictate / specialist-agent → まだ自動では受けられない（null）
 *
 * 新しい種類の仕事はここに足す。入口（HTTP・チャネル）には足さない。
 */
export function taskRequestForLane(input: LaneTaskInput): LaneTaskRequest | null {
  const { text, lane } = input;
  const attachments = input.attachments ?? [];
  const workContext = input.workContext ?? '';
  const contextStats = input.contextStats ?? null;
  const replyDraft = input.replyDraft ?? null;
  if (lane === 'chat') {
    return {
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
    };
  }
  if (lane === 'research') return { kind: 'research', input: { question: text } };
  return null;
}

/**
 * Lane に応じて仕事を作る。
 *
 * 作れなかった理由（plugin が入っていない等）は `notice` で返す。
 * 例外で 500 にすると、利用者には「送れなかった」としか見えない。
 */
async function startWork(
  deps: TurnDeps,
  principal: { tenantId: string; userId: string },
  conversationId: string,
  turnId: string,
  input: LaneTaskInput,
): Promise<{ taskId: string | null; notice: string | null }> {
  const request = taskRequestForLane(input);

  if (!request) {
    return {
      taskId: null,
      notice: input.lane === 'meeting' ? null : 'この頼みごとは、まだ自動では進められません。',
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
        error instanceof Error && /install|not installed|permission|scope/i.test(error.message)
          ? 'General Assistant が追加されていません。Apps から追加してください。'
          : '仕事を始められませんでした。',
    };
  }
}
