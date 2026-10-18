/**
 * 発話を受けて、仕事を始めるまで。正本 §6・§7、Phase 7 実装仕様 §3。
 *
 * HTTP（Task Dock）と、これから来るチャネル（Slack / LINE / 電話）の**同じ入口**。
 * 入口ごとに作り直すと、同じ頼みごとが入口によって違う扱いになる。
 * ここは HTTP を知らない。状態コードへの写し方は呼ぶ側が決める。
 */
import {
  ACCOUNT_REGISTRATION_NOTICE,
  CHECKOUT_HANDOFF_NOTICE,
  CHECKOUT_PREPARATION_NOTICE,
  simulationOrderIntent,
  type InjectionStats,
  type Referent,
  type ReplyDraftMeta,
  type SendTurnRequest,
  type Turn,
  type TurnAttachment,
  type WorkArtifact,
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
import { browserOpenRequest } from './browser-request.js';
import { accountRegistrationRequest, checkoutAssistanceRequest } from './checkout-request.js';
import { classifyCurrentInfo, type CurrentInfoQuery } from './current-info.js';
import { isDocumentRequest, routeLane } from './lane.js';
import { officeEditRequest } from './office-request.js';
import { clarificationFor, resolveReferences } from './reference.js';
import { simulationOrderRequest } from './transaction-request.js';
import { workPreviewRequest } from './work-preview-request.js';
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
  /**
   * 「電話して」を Oathra 経由の仕事にする（service-phone の `phoneTaskFor`）。
   * action lane のときだけ聞く。電話の頼みでなければ null を返し、ほかの振り分けに任せる。
   * 進められない電話の頼みは notice（直し方）を返す。
   */
  readonly phone?: {
    taskFor(
      principal: { tenantId: string; userId: string },
      text: string,
    ): Promise<
      | { readonly kind: 'task'; readonly request: LaneTaskRequest & { readonly title?: string } }
      | { readonly kind: 'notice'; readonly notice: string }
      | null
    >;
  };
}

export interface HandleTurnInput {
  readonly principal: { readonly tenantId: string; readonly userId: string };
  readonly conversationId: string;
  /** 検証済みの発話。チャネルから来るものも、同じ形に直してから渡す。 */
  readonly body: SendTurnRequest;
  readonly log?: TurnLogger;
  /** 受け取りの控え（HTTP の request_id）で決めた発話の id。同じ依頼の送り直しで行を増やさない。 */
  readonly turnId?: string;
  /**
   * 仕事を作る直前に呼ぶ。返す予定の中身を控えに残すため（応答が届かなくても、仕事を隠さない）。
   * チャネルは控えを持たないので渡さない。
   */
  readonly onPrepared?: (response: Record<string, unknown>, dispatchTurnId?: string) => Promise<void>;
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
  /** 注文の条件を聞いている途中など、答えだけ返した（仕事はまだ）。 */
  | {
      readonly kind: 'answered';
      readonly turn: Turn;
      readonly answer: Turn;
      readonly needsClarification: boolean;
    }
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
    ...(input.turnId ? { id: input.turnId } : {}),
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
  // 場所の書かれた文書を直す依頼の「その下」「この段落」は、会話ではなく文書の中を指す。
  // 文書を読む端末のモデルが解くので、ここで聞き返さない。
  const clarification =
    officeEditRequest(body.text) || browserOpenRequest(body.text) || workPreviewRequest(body.text)
      ? null
      : clarificationFor(resolutions);

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

  // Slot answers can be ordinary chat. Keep them with the durable order rather than
  // sending each answer to an unrelated assistant or screen-automation task.
  const order =
    decision.lane === 'meeting' || decision.lane === 'specialist-agent'
      ? null
      : await deps.conversations.advanceCheckoutOrder(
          principal.tenantId,
          principal.userId,
          id,
          turn.id,
          body.text,
        );
  if (order) {
    if (!order.prepare && !order.taskId) {
      return {
        kind: 'answered',
        turn,
        answer: await answerWith(order.message),
        needsClarification: order.draft.status === 'collecting',
      };
    }
    const notice = order.message || CHECKOUT_PREPARATION_NOTICE;
    await input.onPrepared?.(
      { turn, needs_clarification: false, intent: 'doing', task_id: null, notice },
      order.draft.dispatchTurnId ?? undefined,
    );
    let taskId = order.taskId;
    if (order.prepare) {
      const dispatchTurnId = order.draft.dispatchTurnId!;
      try {
        const created = await deps.tasks.create({
          tenantId: principal.tenantId,
          userId: principal.userId,
          request: {
            kind: 'checkout.prepare',
            title: 'カートの準備（未注文）',
            input: order.prepare,
            conversation_id: id as never,
          },
          idempotencyKey: `turn:${dispatchTurnId}`,
        });
        taskId = created.task.id;
      } catch {
        // The task row may have committed before its acknowledgement was lost.
        taskId = await deps.tasks.findByConversationTurn(
          principal.tenantId,
          principal.userId,
          id,
          dispatchTurnId,
        );
      }
      if (taskId)
        await deps.conversations.markCheckoutDispatched(
          principal.tenantId,
          principal.userId,
          id,
          order.draft.orderKey,
          taskId,
        );
    }
    return {
      kind: 'started',
      turn,
      intent: 'doing',
      taskId,
      notice: taskId
        ? notice
        : '注文条件は保存しましたが、カートの準備を始められませんでした。「注文を再開して」で再試行できます。注文は確定していません。',
      reply: null,
    };
  }

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
  /*
   * いまの情報（天気・ニュース・株価）。規則で拾い、端末の取得に回す。
   * モデルに当てさせると「分かりません」か、それらしい作り話になる。
   * 株価は取得元（公開の chart、参考値）の値だけを出す。銘柄が分からなければそう言う（数字を作らない）。
   */
  const info: CurrentInfoQuery | null =
    (decision.lane === 'chat' || decision.lane === 'research') &&
    !replyMeta &&
    !isDocumentRequest(body.text)
      ? classifyCurrentInfo(body.text)
      : null;
  const work = deps.work;
  const pack =
    work && decision.lane === 'chat' && !replyMeta && !info
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
  await input.onPrepared?.({
    turn,
    needs_clarification: false,
    intent: laneToIntent(decision.lane),
    task_id: null,
    // Lost task-dispatch responses must retain the same no-order disclosure.
    notice:
      decision.lane === 'action' && accountRegistrationRequest(body.text)
        ? ACCOUNT_REGISTRATION_NOTICE
        : decision.lane === 'action' && checkoutAssistanceRequest(body.text)
          ? CHECKOUT_HANDOFF_NOTICE
          : null,
    ...(replyMeta ? { reply: replyMeta } : {}),
  });

  const started = await startWork(deps, principal, id, turn.id, {
    text: body.text,
    lane: decision.lane,
    attachments: body.attachments,
    workContext: replyMeta ? replyContext : (pack?.text ?? ''),
    contextStats: pack?.stats ?? null,
    replyDraft: replyMeta ? { meta: replyMeta, instruction: replyInstructionText } : null,
    info,
    turnId: turn.id,
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
  /** いまの情報（天気・ニュース・株価）。chat / research より先に端末の取得へ回す。 */
  readonly info?: CurrentInfoQuery | null;
  /** 模擬注文の冪等キー（`turn:<id>`）に使う。 */
  readonly turnId?: string;
}

/** `TaskService.create` に渡す依頼の中身（conversation_id は呼ぶ側が足す）。 */
export interface LaneTaskRequest {
  readonly kind: string;
  readonly title?: string;
  readonly input: Record<string, unknown>;
}

/**
 * Lane に応じて、どの仕事にするかを決める。**純粋関数。**
 *
 *   会員登録・書類の案・公式サイト・文書の編集・模擬注文・注文画面 → 規則で拾った専用の仕事
 *   天気・ニュース・株価 → info.lookup（端末で取得。chat / research より先）
 *   chat     → General Assistant（正本 §2.2）。答えは成果物として残る
 *   research → Research Agent（§8）
 *   action   → computer.run（画面を見ながらの操作。承認カードを通る）
 *   meeting  → 仕事にしない。録音は画面側の操作（§12）
 *   edit / dictate / specialist-agent → まだ自動では受けられない（null）
 *
 * 新しい種類の仕事はここに足す。入口（HTTP・チャネル）には足さない。
 * 外部への問い合わせが要るもの（電話の相手を Oathra の連絡先から決める）だけは
 * `startWork` で `deps.phone` に聞く。
 */
export function taskRequestForLane(input: LaneTaskInput): LaneTaskRequest | null {
  const { text, lane } = input;
  const attachments = input.attachments ?? [];
  const workContext = input.workContext ?? '';
  const contextStats = input.contextStats ?? null;
  const replyDraft = input.replyDraft ?? null;
  const info = input.info ?? null;
  const registration = lane === 'action' ? accountRegistrationRequest(text) : null;
  if (registration)
    return {
      kind: 'account.registration.prepare',
      title: '会員登録の準備（未登録）',
      input: { service: registration },
    };
  const checkout = lane === 'action' ? checkoutAssistanceRequest(text) : null;
  const simulation = lane === 'action' ? simulationOrderRequest(text) : null;
  // 場所の書かれた Word / Excel を直す依頼は、どの lane でも端末の編集に回す（原本は変えない）。
  const office = lane === 'meeting' ? null : officeEditRequest(text);
  // 「端末を120台にしたら提案書も合わせた案を」: 案件の書類をコピーの上でそろえて変え、確かめる。
  const preview = lane === 'meeting' || office ? null : workPreviewRequest(text);
  if (preview)
    return {
      kind: 'work.preview',
      title: `書類の案（${preview.subject ?? '数'}を ${preview.to} に）`,
      input: {
        to: preview.to,
        ...(preview.subject ? { subject: preview.subject } : {}),
        ...(preview.folder ? { folder: preview.folder } : {}),
      },
    };
  // 「〇〇の公式サイトを開いて」: 端末が検索し、公式と見極めたページを既定のブラウザで開く。
  const browser = lane === 'meeting' || office || checkout ? null : browserOpenRequest(text);
  if (browser)
    return {
      kind: 'browser.open_official',
      title: `${browser.subject} の公式サイト`,
      input: { subject: browser.subject, ...(browser.browser ? { browser: browser.browser } : {}) },
    };
  if (office)
    return {
      kind: 'office.edit',
      title: text.length > 30 ? `${text.slice(0, 30)}…` : text,
      input: { path: office.path, instruction: office.instruction },
    };
  if (simulation)
    return {
      kind: 'transaction.order',
      title: '模擬注文（課金なし）',
      input: { intent: simulationOrderIntent(simulation, `turn:${input.turnId ?? ''}`) },
    };
  if (checkout)
    return {
      kind: 'checkout.assist',
      title: '注文画面への引き継ぎ（未注文）',
      input: { service: checkout },
    };
  // 端末が取りに行く。場所・話題・銘柄だけを渡し、会話の文脈や Work Context は渡さない。
  if (info) return { kind: 'info.lookup', input: { question: text, ...info } };
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
  if (lane === 'action')
    return {
      kind: 'computer.run',
      input: {
        goal: text,
        title: text.length > 30 ? `${text.slice(0, 30)}…` : text,
        ...(attachments.length > 0 ? { attachments: [...attachments] } : {}),
      },
    };
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
  // 電話の頼み（営業・伝言）。承認カードを通る仕事になるか、直し方の notice になる
  const phone =
    input.lane === 'action' && deps.phone ? await deps.phone.taskFor(principal, input.text) : null;
  if (phone?.kind === 'notice') return { taskId: null, notice: phone.notice };
  const request = phone?.kind === 'task' ? phone.request : taskRequestForLane(input);

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
    const notice =
      request.kind === 'account.registration.prepare'
        ? ACCOUNT_REGISTRATION_NOTICE
        : request.kind === 'checkout.assist'
          ? CHECKOUT_HANDOFF_NOTICE
          : null;
    return { taskId: task.id, notice };
  } catch (error) {
    return {
      taskId: null,
      notice:
        // 追加していない plugin の kind は task.unknown_kind（"unknown task kind: plugin:…"）で断られる。
        error instanceof Error &&
        /install|not installed|permission|scope|unknown task kind: plugin:/i.test(error.message)
          ? 'General Assistant が追加されていません。Apps から追加してください。'
          : '仕事を始められませんでした。',
    };
  }
}
