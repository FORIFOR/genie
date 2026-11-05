/**
 * チャット（Slack / LINE）を Genie の仕事に繋ぐ。
 *
 *   受信 → 保存（封じて受信箱へ）→ 200 → 取り出す → 重複を捨てる → 連携を照合
 *        → スレッドを会話に → handleTurn（Task Dock と同じ入口）
 *   見回り → 受け付けた task の区切り（承認待ち・一時停止・終わり）を outbox に積む → 送る
 *   ボタン → 署名・期限・押した本人を確かめて、承認を渡す（外への送信だけ）
 *
 * 守ること:
 *   - **連携した本人の 1:1 の発話だけを頼みとして受ける。**連携していない人には連携の促しだけ返す
 *   - チャットに返すのは外部への送信。本文まで送るかは連携ごとの posting_policy（既定は要約だけ）
 *   - チャットで承認できるのは EXTERNAL_COMMIT だけ。削除・お金・規制のある記録は承認カードへ
 */
import { parseInviteRequest, parseMeetingRequest } from './meeting-request.js';
import { parseCallReport, type ChannelProvider } from '@genie/contracts';
import type {
  InboundChannelAction,
  InboundChannelFollow,
  InboundChannelMessage,
} from './message.js';
import * as render from './render.js';
import {
  ChannelSendError,
  type ChannelSender,
  type OutgoingMessage,
  type ReceivedContent,
  type SlackSender,
  type QuickReply,
} from './send.js';
import {
  MAX_INBOUND_ATTEMPTS,
  type ChannelGroup,
  type ChannelLink,
  type ChannelStore,
  type OutboxKind,
  type OutboxRow,
  type QueuedInbound,
  type WatchedTask,
} from './store.js';
import {
  type AgentApprovalAction,
  isAgentApprovalAction,
  linkCodeIn,
  signAgentApprovalAction,
  signApprovalAction,
  verifyAgentApprovalAction,
  verifyApprovalAction,
} from './tokens.js';

/** 受けたもの（発話・ボタン・友だち追加）。保存してから処理する単位。 */
export type ChannelInbound =
  | { readonly kind: 'message'; readonly message: InboundChannelMessage }
  | { readonly kind: 'action'; readonly action: InboundChannelAction }
  | { readonly kind: 'follow'; readonly follow: InboundChannelFollow };

/** 受信箱に本文を置くときの封（`GENIE_SECRET_KEY` の AES-256-GCM）。 */
export interface InboundSealer {
  seal(plain: string, aad: string): string;
  open(sealed: string, aad: string): string;
}

/** handleTurn の結果のうち、チャットへ返すのに要るところ。 */
export type TurnOutcome =
  | {
      readonly kind: 'clarification';
      readonly answer: string;
      /** 答えに添えるカード（店の候補・予約など）。 */
      readonly card?: string;
      /** 次の一手の選択肢（LINE の Quick Reply）。 */
      readonly choices?: readonly string[];
    }
  | {
      readonly kind: 'started';
      readonly taskId: string | null;
      readonly notice: string | null;
      /**
       * 何の話か（handleTurn の intent）。'talking'（あいさつ・質問）は会話なので「受け付けました」を返さず、
       * 答えができたら本文をそのまま返す。それ以外（調べもの・操作）は仕事として受付を返す。
       */
      readonly intent?: string;
    }
  /**
   * 一度に頼まれた複数のこと（「明日の予定教えて。あと、レシートも家計簿に」）。仕様 v1.0 §1。
   * すぐ答えられたものは答え、仕事になったものは「確認しています」と言い、終わったら本文で返す。
   */
  | {
      readonly kind: 'multi';
      readonly parts: readonly {
        readonly label: string;
        readonly answer: string | null;
        readonly taskId: string | null;
        readonly notice: string | null;
      }[];
    };

/** 調べものの答えを待ってから「調べています」と伝えるまで（Mac の Dock と同じ 12 秒）。 */
const LOOKUP_ACK_MS = 12_000;

/**
 * 質問の形か（「〜ましたか？」「何分？」）。調べものでも、質問には答えだけを返し、依頼（「〜して」）は「承知しました」と受ける。
 */
export function isQuestion(text: string): boolean {
  const t = text.trim();
  return (
    /[？?]$/.test(t) ||
    /(?:ですか|ますか|ましたか|でしょうか|でしたか|かな|の)[。\s]*$/.test(t) ||
    /^(?:何|なに|なん|いつ|どこ|誰|だれ|どう|どれ|どの|いくら|なぜ|どうして)/.test(t) ||
    // 「今日は何曜日」「次の会議はいつ」のように、問いの語で終わる
    /(?:何|なに|いつ|どこ|誰|だれ|どう|どれ|どの|いくら|いくつ)[^。、？?\s]{0,4}[。\s]*$/.test(t)
  );
}

export interface ChannelTaskView {
  readonly title: string | null;
  readonly result_artifact_id: string | null;
  /** 頼んだ人（仕事のホームのリンクを、その人の分だけ作る）。 */
  readonly created_by?: string;
  /** 仕事の種類（電話の結果はカードにする）。 */
  readonly kind?: string;
  /** 頼んだときの入力（グループで頼まれた会議は、返事を送るグループをここに持つ）。 */
  readonly input?: Readonly<Record<string, unknown>>;
}

export interface ChannelEvent {
  readonly sequence: number;
  readonly type: string;
  readonly payload: unknown;
}

export interface ChannelServiceDeps {
  readonly store: ChannelStore;
  readonly senders: Partial<Record<ChannelProvider, ChannelSender>>;
  /** メンションの結果を本人の DM に返すため（Slack だけ）。 */
  readonly slack?: Pick<SlackSender, 'openDirect' | 'postInThread'>;
  /** 連携ごとの仮の端末（devices は api-gateway のもの）。 */
  readonly devices: {
    create(tenantId: string, userId: string, provider: ChannelProvider): Promise<string>;
    revoke(tenantId: string, deviceId: string): Promise<void>;
  };
  readonly conversations: {
    start(tenantId: string, userId: string, title: string): Promise<string>;
    /** 仕事の答えを、その仕事の会話に Genie の発話として残す。 */
    remember?(tenantId: string, taskId: string, text: string): Promise<void>;
  };
  /** handleTurn を呼ぶ（gateway が束ねる）。 */
  readonly turn: (
    principal: { tenantId: string; userId: string },
    conversationId: string,
    text: string,
  ) => Promise<TurnOutcome>;
  readonly tasks: {
    get(tenantId: string, taskId: string): Promise<ChannelTaskView>;
    eventsAfter(tenantId: string, taskId: string, after: number): Promise<readonly ChannelEvent[]>;
    pendingApprovals(
      tenantId: string,
      taskId: string,
    ): Promise<readonly { id: string; summary: string; risk: string; details: unknown }[]>;
    decideApproval(
      tenantId: string,
      taskId: string,
      userId: string,
      approvalId: string,
      decision: 'APPROVED' | 'REJECTED',
    ): Promise<void>;
  };
  /**
   * 写真・外国語の文を読む（service-understand）。家計簿に付ける・目安を返す・訳すなどは向こうで決め、
   * 返事の文か、Genie に渡す頼みの文を返す。null ならいつもどおり handleTurn に渡す。
   * 無ければ写真には「まだ読めません」と答える。
   */
  readonly understand?: (
    principal: { tenantId: string; userId: string },
    conversationId: string,
    input: {
      readonly text: string;
      readonly images: readonly { readonly mediaType: string; readonly data: Uint8Array }[];
      readonly source: ChannelProvider;
    },
  ) => Promise<{ readonly kind: 'reply' | 'turn'; readonly text: string } | null>;
  /**
   * 家族・夫婦のグループ（共有スペース。service-understand の SharedSpaceService などを gateway が束ねる）。
   * 無ければグループの発言には答えない。
   *   enable : 連携済みの本人が「@Genie このグループで使う」と言ったとき、共有スペースを作って id を返す
   *   message: 共有スペースのグループの発言（メンションつきの文、または写真）。答えの文か null を返す
   * **持ち主の個人のもの（メール・予定・ファイル・個人の家計簿）には触れない。**handleTurn は呼ばない。
   */
  readonly shared?: {
    enable(owner: { tenantId: string; userId: string }, name: string): Promise<string>;
    /**
     * グループの 1 発言を見る（覚える設定なら覚える）。呼ばれたか（名前・引用返信）と、一時停止中かを返す。
     * text は、呼びかけ（「ジーニー、」）を外した本文。
     */
    observe?(
      space: { tenantId: string; householdId: string },
      message: {
        readonly messageId: string;
        readonly senderId: string;
        readonly text: string;
        readonly quotedId: string | null;
        readonly sentAt: number;
        readonly fromGenie: boolean;
        readonly mentioned?: boolean;
      },
    ): Promise<{ readonly invoked: boolean; readonly paused: boolean; readonly text?: string }>;
    /** 送信が取り消された発言を、覚えた文脈から外す。 */
    forget?(space: { tenantId: string; householdId: string }, messageId: string): Promise<void>;
    message(
      ctx: {
        tenantId: string;
        userId: string;
        householdId: string;
        speaker: { id: string; name: string | null };
      },
      input: {
        readonly text: string;
        readonly images: readonly { readonly mediaType: string; readonly data: Uint8Array }[];
        readonly mentioned: boolean;
      },
    ): Promise<
      | string
      | {
          readonly text: string;
          /** 店の候補などのカード（cards.ts）。 */
          readonly card?: string;
          /** 次の一手（Quick Reply）。 */
          readonly choices?: readonly string[];
        }
      | null
    >;
  };
  /**
   * 「電話して」で、Genie と声で話すページのリンクを出す（gateway の call）。返すのはトークへ返す文。
   * 無ければ「電話して」はいつもどおり Genie に渡す。
   */
  /**
   * グループで頼まれた会議（「@Genie 明日15時から30分 打ち合わせ、Meet作って」）。
   * 持ち主の会話に calendar.meeting の仕事を作る（承認は持ち主の 1:1 トーク）。無ければ読まない。
   */
  readonly meeting?: {
    readonly timeZone: string;
    request(
      owner: { tenantId: string; userId: string },
      conversationId: string,
      input: Record<string, unknown>,
    ): Promise<{ readonly taskId: string; readonly title: string | null } | null>;
    /**
     * 作った会議に人を足す（「a@example.com も招待して」）。足す先は、この会話で最後に作った、まだ終わっていない会議。
     * グループからなら、そのグループで頼まれた会議だけ。
     *   started: 確認（承認のカード）を持ち主の 1:1 に出した / pending: 会議がまだ入っていない
     *   none: 足す先の会議が無い / permission: 予定を作る許可が無い（手続きのリンクは送ってある）
     */
    invite?(
      owner: { tenantId: string; userId: string },
      conversationId: string,
      request: {
        readonly emails: readonly string[];
        readonly eventKey: string;
        readonly groupId?: string;
        readonly groupProvider?: string;
        readonly requestedBy?: string;
      },
    ): Promise<
      | {
          readonly kind: 'started';
          readonly taskId: string;
          readonly title: string | null;
          readonly meeting: string;
          readonly whenLabel: string;
        }
      | { readonly kind: 'pending'; readonly meeting: string }
      | { readonly kind: 'none' }
      | { readonly kind: 'permission' }
    >;
  };
  /**
   * 「画面を見せて」: Genie のブラウザのいまの画面（隠すところを隠した 1 枚）を返す。読めない文なら null。
   */
  readonly browserView?: (
    tenantId: string,
    userId: string,
    text: string,
  ) => Promise<OutgoingMessage | null>;
  readonly call?: {
    issue(link: ChannelLink, conversationId: string): Promise<OutgoingMessage>;
    /** 家族のグループで、みんなで話す通話のリンク（何人でも入れる。頼みは共有スペースだけ）。 */
    groupInvite?(
      owner: ChannelLink,
      conversationId: string,
      space: { householdId: string; groupId: string },
    ): Promise<OutgoingMessage>;
    /** Genie からかける（出たら opening を話す）。かけられなければ null。 */
    ring?(
      link: ChannelLink,
      conversationId: string,
      opening: string,
    ): Promise<OutgoingMessage | null>;
    /**
     * 公式アカウントへの LINE の電話（管理画面で受けたもの）を Genie の声につなぐ鍵。
     * 使えなければ null（通話のキー・月の上限）。
     */
    bridge?(link: ChannelLink, conversationId: string): Promise<string | null>;
  };
  /**
   * LINE の中継（公式アカウント 1 つ）を通しているとき、届け先を中継に知らせる。
   * グループを使い始めた・やめた、連携を切った、のたびに呼ぶ。
   */
  readonly hub?: {
    claimGroup(groupId: string): Promise<boolean>;
    releaseGroup(groupId: string): Promise<void>;
    releaseUser(userId: string): Promise<void>;
  };
  /** 仕事のホームのリンク（本人だけ・読むだけ）。作れないとき・無いときは null（Mac の作業一覧へ案内する）。 */
  readonly homeLink?: (tenantId: string, userId: string) => Promise<string | null>;
  /** 成果物の元の本文（カードにする JSON を読む。無ければ文だけ）。 */
  readonly artifactBody?: (tenantId: string, artifactId: string) => Promise<string | null>;
  /** 成果物の本文（posting_policy が full_text のときだけ読む）。 */
  readonly artifactText?: (tenantId: string, artifactId: string) => Promise<string | null>;
  /** ボタンの署名鍵。無ければチャットでは承認させない（承認カードへ案内する）。 */
  readonly actionSecret: string | null;
  /**
   * Claude Code の承認（gateway の agent-approvals.ts）。押した人と印はこちらで確かめてから渡す。
   * instruct は「指示を添える」のあとの本人の文。待っていなければ null（ふつうの会話）。
   */
  readonly agentApprovals?: {
    decide(
      tenantId: string,
      userId: string,
      approvalId: string,
      choice: AgentApprovalAction['choice'],
    ): Promise<
      | 'decided'
      | 'decided_with_rule'
      | 'awaiting_instruction'
      | 'awaiting_text'
      | 'not_ruleable'
      | 'gone'
      | 'expired'
      | 'answered_on_mac'
      | 'answered'
      | 'next_question'
      | 'skipped'
    >;
    /** 「指示を添える」「文で答える」のあとの本人の文。質問なら answered / next_question。 */
    instruct(
      tenantId: string,
      userId: string,
      text: string,
    ): Promise<'decided' | 'answered' | 'next_question' | 'gone' | null>;
    /** 「承認ルール」（一覧・取り消し）。当たらなければ null（ふつうの会話）。 */
    command?(tenantId: string, userId: string, text: string): Promise<string | null>;
  };
  /**
   * 受けた本文を封じて保存する鍵。**あれば保存してから 200 を返す**（落ちても続きから処理できる）。
   * 無ければ本文は持たず、これまでどおり 200 のあと同じプロセスで処理する。
   */
  readonly sealer?: InboundSealer | null;
  /** LINE の読み込み中を出し直す間隔（表示は 20 秒で消えるので、その少し前）。 */
  readonly typingRefreshMs?: number;
  readonly log?: (event: string, detail: Record<string, unknown>) => void;
  readonly now?: () => number;
  /** 調べものが長引いたときに「調べています」と伝えるまでの長さ（既定 12 秒。検査で縮める）。 */
  readonly lookupAckMs?: number;
}

/** 声で話したい（「電話して」「通話したい」）。 */
/** 1:1 で「電話して」（Genie の振り分けより先に、通話のリンクを返す）。評価（evals/line-conversation）も使う。 */
export const CALL =
  /^\s*(?:genie|ジーニー)?(?:に|と)?\s*(?:電話|でんわ|通話)(?:で話したい|して|したい|する|かけて|しよう|をかけて)?(?:ください)?[。．.！!？?\s]*$/i;

/** 家族で Genie と話したい（グループで「@Genie みんなで話そう」「@Genie 電話して」）。 */
const GROUP_CALL =
  /^\s*(?:みんなで|家族で|全員で)?\s*(?:話そう|話したい|電話(?:して|しよう|したい)?|通話(?:して|しよう|したい)?|会議しよう)[。．.！!？?\s]*$/;

/** グループを共有スペースにする / やめる言い方（「@Genie このグループで使う」）。 */
const GROUP_ENABLE =
  /^(?:この)?(?:グループ|トーク)(?:で|を)(?:使う|使います|使って|使いたい|始める)|^(?:ここ|ここで)使(?:う|って)/;
const GROUP_RESUME = /^(?:再開|また使う|戻って|使って)/;
const GROUP_DISABLE =
  /^(?:この)?(?:グループ|トーク)(?:で使うの|を使うの)?を?(?:やめる|やめて|止める|終わる)/;

/** チャットで承認してよい risk。 */
const CHAT_APPROVABLE = new Set(['EXTERNAL_COMMIT']);
/** ボタンの有効時間。承認そのものの期限より長くはしない。 */
const BUTTON_TTL_MS = 10 * 60 * 1000;
/** 同時に処理する相手の数。同じ相手の発話は 1 列に並べて順番どおりに進める。 */
const MAX_LANES = 4;

/** 処理の途中で受信箱の行をどう扱うか。保存してから処理するときだけ渡る。 */
interface QueuedContext {
  readonly provider: ChannelProvider;
  readonly eventId: string;
}

const EVENT_KIND: Readonly<Record<string, OutboxKind>> = {
  'task.waiting_approval': 'waiting_approval',
  'task.paused': 'paused',
  'task.completed': 'completed',
  'task.failed': 'failed',
  'task.cancelled': 'cancelled',
};

export class ChannelService {
  readonly #now: () => number;
  #draining: Promise<number> | null = null;

  constructor(private readonly deps: ChannelServiceDeps) {
    this.#now = deps.now ?? Date.now;
  }

  /** 本文を保存してから受け取る経路か（`GENIE_SECRET_KEY` があるか）。 */
  get durable(): boolean {
    return Boolean(this.deps.sealer);
  }

  /**
   * 受け口（Webhook / Socket Mode）が呼ぶ。**これが返ってから提供者に「受け取った」と返す。**
   *
   * 鍵があれば、封じて受信箱に保存してから返し、処理はすぐ後ろで始める。落ちても次の見回りで続く。
   * 鍵が無ければ、何も保存せずに後ろで処理する（これまでどおり）。
   */
  async accept(inbound: ChannelInbound): Promise<'queued' | 'duplicate' | 'started'> {
    const sealer = this.deps.sealer;
    if (!sealer) {
      setImmediate(() => {
        this.#dispatch(inbound, null).catch((error: unknown) =>
          this.#log('channel.process_failed', { kind: inbound.kind, error: errorCode(error) }),
        );
      });
      return 'started';
    }
    const { provider, eventId } = keyOf(inbound);
    const fresh = await this.deps.store.enqueueInbound({
      provider,
      eventId,
      kind: inbound.kind,
      lane: laneOf(inbound),
      payload: sealer.seal(JSON.stringify(inbound), aadOf(provider, eventId)),
      ...(inbound.kind === 'message' && inbound.message.dedupeKey
        ? { sameKey: `same:${inbound.message.dedupeKey}` }
        : {}),
    });
    if (!fresh) return 'duplicate';
    setImmediate(() => {
      this.drain().catch((error: unknown) =>
        this.#log('channel.drain_failed', { error: errorCode(error) }),
      );
    });
    return 'queued';
  }

  /**
   * 受信箱の処理待ちを片づける。同じ相手は 1 列で順番どおり、相手どうしは並べて（最大 4 列）。
   * 同じプロセスで重ねて呼ばれたら、走っているものを待つ。
   */
  async drain(): Promise<number> {
    if (!this.deps.sealer) return 0;
    if (this.#draining) return this.#draining;
    this.#draining = this.#drainOnce().finally(() => {
      this.#draining = null;
    });
    return this.#draining;
  }

  async #drainOnce(): Promise<number> {
    let handled = 0;
    await this.#reportInterrupted();
    for (;;) {
      const rows = await this.deps.store.claimInbound(20);
      if (rows.length === 0) return handled;
      const lanes = new Map<string, QueuedInbound[]>();
      for (const row of rows) lanes.set(row.lane, [...(lanes.get(row.lane) ?? []), row]);
      const queue = [...lanes.values()];
      const workers = Array.from({ length: Math.min(MAX_LANES, queue.length) }, async () => {
        for (let lane = queue.shift(); lane; lane = queue.shift()) {
          for (const row of lane) {
            await this.#processQueued(row);
            handled += 1;
          }
        }
      });
      await Promise.all(workers);
    }
  }

  async #processQueued(row: QueuedInbound): Promise<void> {
    const { provider, eventId } = row;
    let inbound: ChannelInbound;
    try {
      inbound = this.#openPayload(row);
    } catch (error) {
      // 鍵が替わった・壊れた。何度やっても開かないので諦める
      await this.deps.store.finishInbound(provider, eventId, 'dead', errorCode(error));
      this.#log('channel.inbound_unreadable', { provider, error: errorCode(error) });
      return;
    }
    try {
      await this.#dispatch(inbound, { provider, eventId });
      await this.deps.store.finishInbound(provider, eventId, 'done');
    } catch (error) {
      const code = errorCode(error);
      if (row.attempts >= MAX_INBOUND_ATTEMPTS) {
        await this.deps.store.finishInbound(provider, eventId, 'dead', code);
        this.#log('channel.inbound_dead', { provider, kind: row.kind, error: code });
      } else {
        await this.deps.store.retryInbound(provider, eventId, code);
        this.#log('channel.inbound_retry', { provider, attempts: row.attempts, error: code });
      }
    }
  }

  #openPayload(row: QueuedInbound): ChannelInbound {
    const plain = this.deps.sealer!.open(row.payload, aadOf(row.provider, row.eventId));
    const inbound = JSON.parse(plain) as ChannelInbound;
    if (inbound.kind !== row.kind) throw new Error('inbound_kind_mismatch');
    return inbound;
  }

  /**
   * handleTurn の途中で止まったもの。**やり直さない**（仕事ができていれば二つになる）。
   * 本人に「途中で止まった、作業一覧で確かめて」と伝えて、記録だけ残す。
   */
  async #reportInterrupted(): Promise<void> {
    for (const row of await this.deps.store.interruptedInbound()) {
      try {
        const inbound = this.#openPayload(row);
        if (inbound.kind === 'message') {
          const message = inbound.message;
          const link = await this.deps.store.findLink(
            message.provider,
            message.workspaceId,
            message.subject,
          );
          if (link) {
            const destination =
              message.mention && this.deps.slack
                ? await this.deps.slack.openDirect(message.subject)
                : message.destination;
            await this.#reply(
              message.provider,
              { destination, threadKey: message.threadKey },
              render.interrupted(),
              null,
            );
          }
        }
      } catch (error) {
        this.#log('channel.interrupted_notice_failed', { error: errorCode(error) });
      }
      await this.deps.store.finishInbound(row.provider, row.eventId, 'dead', 'interrupted');
      this.#log('channel.inbound_interrupted', { provider: row.provider, kind: row.kind });
    }
  }

  #claimSame(message: InboundChannelMessage): Promise<boolean> {
    return this.deps.store.claimInbox(message.provider, `same:${message.dedupeKey!}`);
  }

  async #dispatch(inbound: ChannelInbound, queued: QueuedContext | null): Promise<unknown> {
    switch (inbound.kind) {
      case 'message':
        return this.receive(inbound.message, queued);
      case 'action':
        return this.act(inbound.action, queued);
      case 'follow':
        return this.greet(inbound.follow, queued);
    }
  }

  #log(event: string, detail: Record<string, unknown>): void {
    this.deps.log?.(event, detail);
  }

  /** 連携の前、または連携とは別に、その場で返す（outbox を通さない一言）。 */
  async #reply(
    provider: ChannelProvider,
    target: { destination: string; threadKey: string },
    message: OutgoingMessage,
    replyToken: string | null,
  ): Promise<string | null> {
    const sender = this.deps.senders[provider];
    if (!sender) return null;
    try {
      const sent = await sender.send(target, message, {
        replyToken,
        retryKey: crypto.randomUUID(),
      });
      return sent.providerMessageId;
    } catch (error) {
      this.#log('channel.reply_failed', { provider, error: errorCode(error) });
      return null;
    }
  }

  /**
   * グループを持ち主の共有スペースにする（招かれた・前の仕様のまま残っていた・止めたあと再開した）。
   * householdId を渡せば、前の家計簿・リスト・設定をそのまま使う。同時に届いた発言が先に作っていれば、それを返す。
   */
  async #registerGroup(
    provider: ChannelProvider,
    workspaceId: string,
    groupId: string,
    owner: { tenantId: string; userId: string; subject: string },
    householdId?: string,
  ): Promise<ChannelGroup | null> {
    const household =
      householdId ??
      (await this.deps.shared!.enable(
        { tenantId: owner.tenantId, userId: owner.userId },
        'LINE のグループ',
      ));
    try {
      await this.deps.store.createGroup({
        tenantId: owner.tenantId,
        householdId: household,
        ownerUserId: owner.userId,
        provider,
        workspaceId,
        groupId,
        enabledBy: owner.subject,
      });
    } catch {
      // 同じグループの別の発言が先に作った（channel_groups_active）。下で引き直す
    }
    if (provider === 'line') await this.deps.hub?.claimGroup(groupId);
    return this.deps.store.findGroup(provider, workspaceId, groupId);
  }

  /** 友だちに追加された（LINE の follow）。連携していなければ、つなぎ方を返す。 */
  async greet(
    follow: InboundChannelFollow,
    queued: QueuedContext | null = null,
  ): Promise<'duplicate' | 'unlinked' | 'linked'> {
    if (!queued && !(await this.deps.store.claimInbox(follow.provider, follow.eventId)))
      return 'duplicate';
    if (follow.group) {
      // グループに招かれた＝使い始め（本人の設計 2026-10-28 改）。「使う」と言わせない。挨拶は 1 回だけ
      const where = [follow.provider, follow.workspaceId, follow.group.id] as const;
      const existing = await this.deps.store.findGroup(...where);
      if (existing) {
        await this.#reply(follow.provider, follow, render.groupWelcome(true), follow.replyToken);
        return 'linked';
      }
      // 「@Genie このグループをやめる」で止めたグループは、招き直しでは勝手に再開しない
      if (await this.deps.store.stoppedGroup(...where)) {
        await this.#reply(follow.provider, follow, render.groupStopped(), follow.replyToken);
        return 'unlinked';
      }
      const owner = this.deps.shared
        ? await this.deps.store.soleLink(follow.provider, follow.workspaceId)
        : null;
      const space = owner
        ? await this.#registerGroup(follow.provider, follow.workspaceId, follow.group.id, owner)
        : null;
      await this.#reply(
        follow.provider,
        follow,
        render.groupWelcome(space !== null),
        follow.replyToken,
      );
      return space ? 'linked' : 'unlinked';
    }
    const link = await this.deps.store.findLink(
      follow.provider,
      follow.workspaceId,
      follow.subject,
    );
    if (link) return 'linked';
    await this.#reply(follow.provider, follow, render.linkPrompt(), follow.replyToken);
    return 'unlinked';
  }

  /**
   * 発話を受ける。**重複は何もしない**（再送でも仕事は 1 つ）。
   * `queued` は受信箱に保存してから処理しているとき（配信 ID の重複はもう見てある）。
   */
  async receive(
    message: InboundChannelMessage,
    queued: QueuedContext | null = null,
  ): Promise<'duplicate' | 'unlinked' | 'linked' | 'handled'> {
    if (!queued && !(await this.deps.store.claimInbox(message.provider, message.eventId)))
      return 'duplicate';
    // 同じ発言の別イベント（Slack の message と app_mention）も 1 つにする。
    // 保存してから処理するときは受け取ったときに見てある（やり直しで自分と重ならないように）
    if (!queued && message.dedupeKey && !(await this.#claimSame(message))) return 'duplicate';
    if (message.group) return this.#receiveGroup(message, message.group, queued);

    const link = await this.deps.store.findLink(
      message.provider,
      message.workspaceId,
      message.subject,
    );
    if (!link) {
      // 知らない人のメンションには答えない（チャンネルを荒らさない）
      if (message.mention) return 'unlinked';
      const code = linkCodeIn(message.text);
      if (!code) {
        await this.#reply(message.provider, message, render.linkPrompt(), message.replyToken);
        return 'unlinked';
      }
      return this.#link(message, code);
    }

    if (linkCodeIn(message.text)) {
      await this.#reply(
        message.provider,
        message,
        render.linkFailed('already_linked'),
        message.replyToken,
      );
      return 'handled';
    }
    if (/^\s*(?:連携解除|unlink)\s*$/i.test(message.text) && !message.mention) {
      await this.unlink(link.tenantId, link.userId, link.id);
      await this.#reply(message.provider, message, render.unlinked(), message.replyToken);
      return 'handled';
    }

    // 「指示を添える」を押したあとの文は、Claude Code への指示として渡す（ふつうの会話にしない）
    if (!message.mention && this.deps.agentApprovals && message.text.trim()) {
      const instructed = await this.deps.agentApprovals
        .instruct(link.tenantId, link.userId, message.text)
        .catch(() => null);
      if (instructed) {
        await this.#reply(
          message.provider,
          message,
          render.agentApprovalAnswered(instructed === 'decided' ? 'instructed' : instructed),
          message.replyToken,
        );
        return 'handled';
      }
    }

    // 「画面を見せて」: Genie のブラウザのいまの画面
    if (!message.mention && this.deps.browserView && message.text.trim()) {
      const view = await this.deps
        .browserView(link.tenantId, link.userId, message.text)
        .catch(() => null);
      if (view) {
        await this.#reply(message.provider, message, view, message.replyToken);
        return 'handled';
      }
    }

    // 「承認ルール」「承認ルール 2 を取り消して」（Claude Code の継続許可の一覧・取り消し）
    if (!message.mention && this.deps.agentApprovals?.command && message.text.trim()) {
      const said = await this.deps.agentApprovals
        .command(link.tenantId, link.userId, message.text)
        .catch(() => null);
      if (said) {
        await this.#reply(message.provider, message, render.notice(said), message.replyToken);
        return 'handled';
      }
    }

    // メンションの結果はチャンネルに書かず、本人の DM に返す
    let destination = message.destination;
    if (message.mention) {
      if (!this.deps.slack) return 'handled';
      destination = await this.deps.slack.openDirect(message.subject);
      await this.deps.slack
        .postInThread(message.mention.channel, message.mention.ts, render.mentionAck().text)
        .catch((error: unknown) =>
          this.#log('channel.reply_failed', { provider: 'slack', error: errorCode(error) }),
        );
    }
    const target = { destination, threadKey: message.threadKey };
    // 返事を待つ間、考えていることを見せる（出せなくても続ける）。表示は 20 秒で消えるので出し直す
    const sender = this.deps.senders[message.provider];
    const showTyping = () =>
      sender?.typing?.(target).catch((error: unknown) =>
        this.#log('channel.typing_failed', {
          provider: message.provider,
          error: errorCode(error),
        }),
      );
    void showTyping();
    const typing = sender?.typing
      ? setInterval(() => void showTyping(), this.deps.typingRefreshMs ?? 18_000)
      : null;
    typing?.unref?.();

    let outcome: TurnOutcome;
    try {
      const conversationId = await this.deps.store.conversationFor(
        link,
        message.threadKey,
        destination,
        () => this.deps.conversations.start(link.tenantId, link.userId, titleOf(message.provider)),
      );
      // ここから先で落ちたら、やり直さずに本人へ伝える（仕事が二つにならないように）
      if (queued) await this.deps.store.markInboundTurning(queued.provider, queued.eventId);
      const principal = { tenantId: link.tenantId, userId: link.userId };
      if (this.deps.call && !message.mention && CALL.test(message.text)) {
        const reply = await this.deps.call.issue(link, conversationId);
        await this.#queueAndSend(link, target, null, null, 'notice', reply, message.replyToken);
        return 'handled';
      }
      // 本人が 1:1 で頼んだ会議（「明日15時から30分 打ち合わせ、Meet作って」）。グループと同じ読み方で、
      // 確認（承認のカード）をこのトークに出してから Meet 付きで入れる。モデルに任せると「連携が要る」で止まる
      const meeting =
        this.deps.meeting && !message.mention
          ? parseMeetingRequest(message.text, this.#now(), this.deps.meeting.timeZone)
          : null;
      if (meeting && this.deps.meeting) {
        const started = await this.deps.meeting.request(principal, conversationId, {
          title: meeting.title,
          start: meeting.start,
          end: meeting.end,
          when_label: meeting.whenLabel,
          time_zone: this.deps.meeting.timeZone,
          meet_request_id: `genie-${message.eventId.slice(0, 40)}`,
          ...(meeting.attendees.length ? { attendees: meeting.attendees.join(',') } : {}),
        });
        // 許可がまだ無い: 手続きのリンクは持ち主へ送ってある。ここでは何も足さない
        if (!started) return 'handled';
        await this.followTask(link.tenantId, conversationId, started.taskId, started.title);
        const invited = meeting.attendees.length ? `（招待: ${meeting.attendees.join('、')}）` : '';
        await this.#reply(
          message.provider,
          target,
          render.notice(
            `会議「${meeting.title}」（${meeting.whenLabel}）${invited}を Google Meet 付きで入れます。このあと届く確認で「予定を入れる」を押してください。`,
          ),
          message.replyToken,
        );
        return 'handled';
      }
      // 作った会議に人を足す（「a@example.com も招待して」）。足す先の会議が無ければ、いつもどおり Genie へ
      const invitees =
        this.deps.meeting?.invite && !message.mention ? parseInviteRequest(message.text) : null;
      if (invitees && this.deps.meeting?.invite) {
        const invited = await this.deps.meeting.invite(principal, conversationId, {
          emails: invitees,
          eventKey: message.eventId,
        });
        if (invited.kind !== 'none') {
          if (invited.kind === 'started')
            await this.followTask(link.tenantId, conversationId, invited.taskId, invited.title);
          const text =
            invited.kind === 'started'
              ? `会議「${invited.meeting}」（${invited.whenLabel}）に ${invitees.join('、')} を招待します。このあと届く確認で「招待する」を押してください。`
              : invited.kind === 'pending'
                ? `会議「${invited.meeting}」はまだカレンダーに入っていません。先に確認で「予定を入れる」を押してから、もう一度送ってください。`
                : null;
          if (text)
            await this.#reply(message.provider, target, render.notice(text), message.replyToken);
          return 'handled';
        }
      }
      const read = await this.#understand(principal, conversationId, message, sender);
      outcome =
        read?.kind === 'reply'
          ? { kind: 'clarification', answer: read.text }
          : await this.deps.turn(principal, conversationId, read?.text ?? message.text);
    } catch (error) {
      this.#log('channel.turn_failed', { link_id: link.id, error: errorCode(error) });
      await this.#reply(message.provider, target, render.received(), message.replyToken);
      return 'handled';
    } finally {
      if (typing) clearInterval(typing);
    }

    return this.#answer(link, target, outcome, message.replyToken, isQuestion(message.text));
  }

  /** handleTurn の結果をトークへ返す（聞き返し・会話の答えの見回り・仕事の受付・お知らせ）。 */
  /**
   * 調べものが長引いたら（`lookupAckMs`、既定 12 秒）、調べていることだけ先に伝える。すぐ答えられたら何も送らない。
   * 落ちても失うのはこの一言だけ（答えは見回りが返す）。
   */
  #tellIfSlow(
    link: ChannelLink,
    target: { destination: string; threadKey: string },
    taskId: string,
  ): void {
    const timer = setTimeout(() => {
      void (async () => {
        const events = await this.deps.tasks.eventsAfter(link.tenantId, taskId, 0);
        if (events.some((e) => /^task\.(completed|failed|cancelled)$/.test(e.type))) return;
        await this.#queueAndSend(link, target, null, null, 'notice', render.lookingUp(), null);
      })().catch((error: unknown) =>
        this.#log('channel.lookup_notice_failed', { link_id: link.id, error: errorCode(error) }),
      );
    }, this.deps.lookupAckMs ?? LOOKUP_ACK_MS);
    timer.unref?.();
  }

  async #answer(
    link: ChannelLink,
    target: { destination: string; threadKey: string },
    outcome: TurnOutcome,
    replyToken: string | null,
    question = false,
  ): Promise<'handled'> {
    if (outcome.kind === 'multi') {
      // 済んだこと・要ることを 1 通に。仕事になったものは、終わったら本文で返す（受付は送らない）
      const lines = outcome.parts.map((p) => {
        const said = p.answer ?? p.notice;
        if (said) return `・${p.label}：${said}`;
        return p.taskId
          ? `・${p.label}：確認しています。このあと届きます。`
          : `・${p.label}：まだ進められません。`;
      });
      await this.#queueAndSend(
        link,
        target,
        null,
        null,
        'notice',
        render.notice(lines.join('\n')),
        replyToken,
      );
      for (const part of outcome.parts) {
        if (!part.taskId) continue;
        const id = await this.deps.store.enqueue({
          tenantId: link.tenantId,
          linkId: link.id,
          taskId: part.taskId,
          eventSequence: 0,
          kind: 'accepted',
          destination: target.destination,
          threadKey: target.threadKey,
          body: render.accepted(null),
          answerInline: true,
        });
        if (id) await this.deps.store.markSent(link.tenantId, id, null);
      }
      return 'handled';
    }
    if (outcome.kind === 'clarification') {
      await this.#queueAndSend(
        link,
        target,
        null,
        null,
        'notice',
        {
          ...render.notice(outcome.answer),
          ...(outcome.card ? { card: outcome.card } : {}),
          ...(outcome.choices?.length ? { quickReplies: outcome.choices } : {}),
        },
        replyToken,
      );
    } else if (
      outcome.taskId &&
      (outcome.intent === 'talking' || (outcome.intent === 'looking_up' && question))
    ) {
      // 会話と、調べて答える質問。受付は送らず、見回りの起点だけ残す（送った扱い）。答えは終わったら本文で返す
      // （本人の指示 2026-10-26: 質問に「受け付けました」を先に送らない。クレジットの質問で先に届いていた）。
      // 「競合を調べて」のような依頼は、下で「承知しました」と受ける
      const id = await this.deps.store.enqueue({
        tenantId: link.tenantId,
        linkId: link.id,
        taskId: outcome.taskId,
        eventSequence: 0,
        kind: 'accepted',
        destination: target.destination,
        threadKey: target.threadKey,
        body: render.accepted(null),
        answerInline: true,
      });
      if (id) await this.deps.store.markSent(link.tenantId, id, null);
      if (outcome.intent === 'looking_up') this.#tellIfSlow(link, target, outcome.taskId);
    } else if (outcome.taskId) {
      const task = await this.deps.tasks.get(link.tenantId, outcome.taskId).catch(() => null);
      // 受付は sequence 0。以後のイベントはこの行を起点に見回る
      await this.#queueAndSend(
        link,
        target,
        outcome.taskId,
        0,
        'accepted',
        render.accepted(task?.title ?? null),
        replyToken,
      );
    } else if (outcome.notice) {
      await this.#queueAndSend(
        link,
        target,
        null,
        null,
        'notice',
        render.notice(outcome.notice),
        replyToken,
      );
    }
    return 'handled';
  }

  /**
   * グループの発言。**メンションのある発言（と、自動で読むと決めた写真）だけを読む。**
   * 共有スペースにする前は、連携済みの本人の「@Genie このグループで使う」だけを受ける。
   */
  async #receiveGroup(
    message: InboundChannelMessage,
    group: NonNullable<InboundChannelMessage['group']>,
    queued: QueuedContext | null,
  ): Promise<'unlinked' | 'linked' | 'handled'> {
    const target = { destination: group.id, threadKey: group.id };
    let space = await this.deps.store.findGroup(message.provider, message.workspaceId, group.id);
    // Genie の発言も文脈に残す（引用返信で「これ」と言われたとき、どの返事への返信か分かるように）
    const say = async (reply: string | OutgoingMessage) => {
      const outgoing = typeof reply === 'string' ? render.notice(reply) : reply;
      const id = await this.#reply(message.provider, target, outgoing, message.replyToken);
      if (space && id)
        await this.deps.shared
          ?.observe?.(
            { tenantId: space.tenantId, householdId: space.householdId },
            {
              messageId: id,
              senderId: 'genie',
              text: outgoing.text,
              quotedId: null,
              sentAt: this.#now(),
              fromGenie: true,
            },
          )
          .catch(() => undefined);
    };
    // 送信の取り消し: 覚えた文脈から外す（返事はしない）
    if (group.unsent) {
      if (space)
        await this.deps.shared
          ?.forget?.({ tenantId: space.tenantId, householdId: space.householdId }, group.unsent)
          .catch(() => undefined);
      return 'handled';
    }
    if (!space) {
      const where = [message.provider, message.workspaceId, group.id] as const;
      // 止めたグループ: 「@Genie 再開」「@Genie このグループで使う」でだけ戻す（家計簿・設定は前のものを引き継ぐ）
      const stopped = await this.deps.store.stoppedGroup(...where);
      if (stopped) {
        if (!group.mentioned) return 'unlinked';
        if (
          !this.deps.shared ||
          !(GROUP_ENABLE.test(message.text) || GROUP_RESUME.test(message.text))
        ) {
          await say(render.groupStopped().text);
          return 'unlinked';
        }
        // 止めたのは持ち主なので、戻せるのも持ち主だけ
        if (message.subject !== stopped.enabledBy) {
          await say('Genie を再開できるのは、このグループの Genie の持ち主だけです。');
          return 'unlinked';
        }
        space = await this.#registerGroup(
          ...where,
          { tenantId: stopped.tenantId, userId: stopped.ownerUserId, subject: stopped.enabledBy },
          stopped.householdId,
        );
        if (space) await say(render.groupResumed());
        return space ? 'linked' : 'unlinked';
      }
      // 招かれたときに持ち主が決まらなかった・前の仕様で「使う」と言われずに残ったグループは、
      // 連携済みの人（いなければ、この公式アカウントのただ 1 人の持ち主）のものとして、ここで使い始める
      const owner =
        (await this.deps.store.findLink(message.provider, message.workspaceId, message.subject)) ??
        (await this.deps.store.soleLink(message.provider, message.workspaceId));
      if (!owner || !this.deps.shared) {
        if (group.mentioned) await say(render.groupPending().text);
        return 'unlinked';
      }
      space = await this.#registerGroup(...where, owner);
      if (!space) return 'unlinked';
    }
    // もう使える（「このグループで使う」は、招かれた時点で済んでいる）
    if (group.mentioned && GROUP_ENABLE.test(message.text)) {
      await say(render.groupWelcome(true));
      return 'handled';
    }
    if (group.mentioned && GROUP_DISABLE.test(message.text)) {
      if (message.subject !== space.enabledBy) {
        await say(
          'Genie を止められるのは、このグループの Genie の持ち主だけです。会話を覚えるのを止めるなら「@Genie 一時停止」、覚えた会話を消すなら「@Genie 忘れて」。',
        );
        return 'handled';
      }
      await this.deps.store.revokeGroup(space.tenantId, space.id);
      await say(render.groupDisabled().text);
      if (message.provider === 'line') await this.deps.hub?.releaseGroup(group.id);
      return 'handled';
    }
    // 中継に届け先を知らせ直す（中継へ移る前に使い始めたグループも、ここで中継に覚えてもらう）
    if (message.provider === 'line' && group.mentioned) void this.deps.hub?.claimGroup(group.id);
    // 「@Genie みんなで話そう」「@Genie 電話して」: 家族で Genie と話す通話のリンク
    if (group.mentioned && this.deps.call?.groupInvite && GROUP_CALL.test(message.text)) {
      const owner = await this.deps.store.findLink(
        message.provider,
        message.workspaceId,
        space.enabledBy,
      );
      if (!owner) {
        await say('使い始めた人の連携が切れているので、通話を始められません。');
        return 'handled';
      }
      const conversationId = await this.deps.store.conversationFor(
        owner,
        owner.subject,
        owner.subject,
        () => this.deps.conversations.start(owner.tenantId, owner.userId, titleOf(owner.provider)),
      );
      const invite = await this.deps.call.groupInvite(owner, conversationId, {
        householdId: space.householdId,
        groupId: group.id,
      });
      await this.#reply(message.provider, target, invite, message.replyToken);
      return 'handled';
    }
    // 「@Genie 明日15時から30分 打ち合わせ、Meet作って」: 持ち主の承認を取ってから、持ち主のカレンダーに入れる
    const meeting =
      group.mentioned && this.deps.meeting
        ? parseMeetingRequest(message.text, this.#now(), this.deps.meeting.timeZone)
        : null;
    if (meeting && this.deps.meeting) {
      const owner = await this.deps.store.findLink(
        message.provider,
        message.workspaceId,
        space.enabledBy,
      );
      if (!owner) {
        await say('使い始めた人の連携が切れているので、会議を入れられません。');
        return 'handled';
      }
      const conversationId = await this.deps.store.conversationFor(
        owner,
        owner.subject,
        owner.subject,
        () => this.deps.conversations.start(owner.tenantId, owner.userId, titleOf(owner.provider)),
      );
      const asker =
        (await this.deps.senders[message.provider]
          ?.memberName?.(group.id, message.subject)
          .catch(() => null)) ?? null;
      try {
        const started = await this.deps.meeting.request(
          { tenantId: owner.tenantId, userId: owner.userId },
          conversationId,
          {
            title: meeting.title,
            start: meeting.start,
            end: meeting.end,
            when_label: meeting.whenLabel,
            time_zone: this.deps.meeting.timeZone,
            // 返事を送るグループ（完了・見送りをここへ）。同じ頼みの重ね押しで会議を 2 つ作らない印も
            group_id: group.id,
            group_provider: message.provider,
            meet_request_id: `genie-${(group.messageId ?? message.eventId).slice(0, 40)}`,
            ...(meeting.attendees.length ? { attendees: meeting.attendees.join(',') } : {}),
            ...(asker ? { requested_by: asker } : {}),
          },
        );
        if (!started) {
          await say(
            '持ち主のカレンダーに予定を入れる許可がまだありません。持ち主に許可をお願いしたので、済んだらもう一度頼んでください。',
          );
          return 'handled';
        }
        await this.followTask(owner.tenantId, conversationId, started.taskId, started.title);
        // 持ち主が自分で頼んだときも、承認は 1:1 トークで取る（グループのボタンは誰でも押せる）
        await say(
          `会議「${meeting.title}」（${meeting.whenLabel}）を入れてよいか、持ち主に確認しています。入れたら Google Meet のリンクをここに送ります。`,
        );
      } catch (error) {
        this.#log('channel.meeting_failed', {
          provider: message.provider,
          error: errorCode(error),
        });
        await say('会議を入れる準備ができませんでした。少し待ってから、もう一度頼んでください。');
      }
      return 'handled';
    }
    // 「@Genie a@example.com も招待して」: このグループで頼まれた会議に、持ち主の承認を取ってから人を足す
    const groupInvitees =
      group.mentioned && this.deps.meeting?.invite ? parseInviteRequest(message.text) : null;
    if (groupInvitees && this.deps.meeting?.invite) {
      const owner = await this.deps.store.findLink(
        message.provider,
        message.workspaceId,
        space.enabledBy,
      );
      if (!owner) {
        await say('使い始めた人の連携が切れているので、招待できません。');
        return 'handled';
      }
      const conversationId = await this.deps.store.conversationFor(
        owner,
        owner.subject,
        owner.subject,
        () => this.deps.conversations.start(owner.tenantId, owner.userId, titleOf(owner.provider)),
      );
      const asker =
        (await this.deps.senders[message.provider]
          ?.memberName?.(group.id, message.subject)
          .catch(() => null)) ?? null;
      try {
        const invited = await this.deps.meeting.invite(
          { tenantId: owner.tenantId, userId: owner.userId },
          conversationId,
          {
            emails: groupInvitees,
            eventKey: group.messageId ?? message.eventId,
            groupId: group.id,
            groupProvider: message.provider,
            ...(asker ? { requestedBy: asker } : {}),
          },
        );
        if (invited.kind === 'started')
          await this.followTask(owner.tenantId, conversationId, invited.taskId, invited.title);
        await say(
          invited.kind === 'started'
            ? `会議「${invited.meeting}」（${invited.whenLabel}）に ${groupInvitees.join('、')} を招待してよいか、持ち主に確認しています。`
            : invited.kind === 'pending'
              ? `会議「${invited.meeting}」はまだカレンダーに入っていません。持ち主が入れたあとで、もう一度頼んでください。`
              : invited.kind === 'permission'
                ? '持ち主のカレンダーに予定を入れる許可がまだありません。持ち主に許可をお願いしたので、済んだらもう一度頼んでください。'
                : '招待を足す会議が見つかりませんでした。このグループで頼まれた、これからの会議に足せます。',
        );
      } catch (error) {
        this.#log('channel.invite_failed', { provider: message.provider, error: errorCode(error) });
        await say('招待の準備ができませんでした。少し待ってから、もう一度頼んでください。');
      }
      return 'handled';
    }
    const photos = (message.attachments ?? []).filter((a) => a.kind === 'image');
    // 会話を文脈として覚える（グループの設定が「覚える」のときだけ）。呼ばれたかもここで決める:
    // @Genie・「ジーニー、」で始まる・Genie の返事への引用返信（本人の設計 2026-10-28）
    const seen =
      message.text && group.messageId
        ? await this.deps.shared
            ?.observe?.(
              { tenantId: space.tenantId, householdId: space.householdId },
              {
                messageId: group.messageId,
                senderId: message.subject,
                text: message.text,
                quotedId: group.quotedId ?? null,
                sentAt: message.sentAt || this.#now(),
                fromGenie: false,
                mentioned: group.mentioned,
              },
            )
            .catch(() => null)
        : null;
    const invoked = group.mentioned || seen?.invoked === true;
    if (seen?.paused && !group.mentioned) return 'handled';
    // 呼ばれていない文には答えない（会話に割り込まない）
    if (!invoked && photos.length === 0) return 'handled';
    if (!this.deps.shared) return 'handled';

    const sender = this.deps.senders[message.provider];
    if (queued) await this.deps.store.markInboundTurning(queued.provider, queued.eventId);
    try {
      const images: ReceivedContent[] = [];
      for (const photo of photos.slice(0, 4)) {
        if (!sender?.content) break;
        images.push(await sender.content(photo.id));
      }
      if (photos.length > 0 && images.length === 0) return 'handled';
      const name = (await sender?.memberName?.(group.id, message.subject)) ?? null;
      const answer = await this.deps.shared.message(
        {
          tenantId: space.tenantId,
          userId: space.ownerUserId,
          householdId: space.householdId,
          speaker: { id: message.subject, name },
        },
        { text: seen?.text ?? message.text, images, mentioned: invoked },
      );
      if (answer)
        await say(
          // 文の答えはモデルが Markdown で書く。LINE に記号（**・#）をそのまま出さない（2026-10-28 の実機）
          typeof answer === 'string'
            ? render.answer(answer)
            : {
                ...render.notice(answer.text),
                ...(answer.card ? { card: answer.card } : {}),
                ...(answer.choices?.length ? { quickReplies: answer.choices } : {}),
              },
        );
    } catch (error) {
      this.#log('channel.group_failed', { provider: message.provider, error: errorCode(error) });
      if (invoked) await say(render.received().text);
    }
    return 'handled';
  }

  /**
   * 写真と外国語の文を読む。写真は本体を取りに行ってから渡す。
   * 読めない添付（音声・動画・ファイル）だけなら、そう答える。
   */
  async #understand(
    principal: { tenantId: string; userId: string },
    conversationId: string,
    message: InboundChannelMessage,
    sender: ChannelSender | undefined,
  ): Promise<{ readonly kind: 'reply' | 'turn'; readonly text: string } | null> {
    const attachments = message.attachments ?? [];
    const photos = attachments.filter((a) => a.kind === 'image');
    if (attachments.length > 0 && photos.length === 0) {
      return { kind: 'reply', text: render.mediaUnsupported() };
    }
    const images: ReceivedContent[] = [];
    for (const photo of photos.slice(0, 4)) {
      if (!sender?.content) return { kind: 'reply', text: render.mediaUnsupported() };
      try {
        images.push(await sender.content(photo.id));
      } catch (error) {
        this.#log('channel.content_failed', {
          provider: message.provider,
          error: errorCode(error),
        });
        return { kind: 'reply', text: render.mediaFailed() };
      }
    }
    if (!this.deps.understand) {
      return images.length ? { kind: 'reply', text: render.mediaUnsupported() } : null;
    }
    return this.deps.understand(principal, conversationId, {
      text: message.text,
      images,
      source: message.provider,
    });
  }

  async #link(message: InboundChannelMessage, code: string): Promise<'linked' | 'unlinked'> {
    const redeemed = await this.deps.store.redeemLinkCode(message.provider, code);
    if (!redeemed.ok) {
      await this.#reply(
        message.provider,
        message,
        render.linkFailed('invalid'),
        message.replyToken,
      );
      return 'unlinked';
    }
    const deviceId = await this.deps.devices.create(
      redeemed.tenantId,
      redeemed.userId,
      message.provider,
    );
    const link = await this.deps.store.createLink({
      tenantId: redeemed.tenantId,
      userId: redeemed.userId,
      deviceId,
      provider: message.provider,
      workspaceId: message.workspaceId,
      subject: message.subject,
    });
    if (!link) {
      // 取り合いで先に結ばれた。作った端末は残さない
      await this.deps.devices.revoke(redeemed.tenantId, deviceId);
      await this.#reply(
        message.provider,
        message,
        render.linkFailed('already_linked'),
        message.replyToken,
      );
      return 'unlinked';
    }
    this.#log('channel.linked', { link_id: link.id, provider: link.provider });
    await this.#reply(message.provider, message, render.linked(), message.replyToken);
    return 'linked';
  }

  /** 本人が切る（Genie の画面から、またはチャットの「連携解除」）。端末も無効にする。 */
  async unlink(tenantId: string, userId: string, linkId: string): Promise<boolean> {
    const link = await this.deps.store.revokeLink(tenantId, userId, linkId);
    if (!link) return false;
    await this.deps.devices.revoke(tenantId, link.deviceId);
    if (link.provider === 'line')
      await this.deps.hub?.releaseUser(link.subject).catch(() => undefined);
    return true;
  }

  /** ボタンを押した。**印・期限・押した人・risk** をすべて確かめてから承認を渡す。 */
  async act(
    action: InboundChannelAction,
    queued: QueuedContext | null = null,
  ): Promise<'duplicate' | 'refused' | 'decided'> {
    if (!queued && !(await this.deps.store.claimInbox(action.provider, action.eventId)))
      return 'duplicate';
    const target = { destination: action.destination, threadKey: action.destination };
    const refuse = async (reason: Parameters<typeof render.actionRefused>[0]) => {
      await this.#reply(action.provider, target, render.actionRefused(reason), action.replyToken);
      return 'refused' as const;
    };

    const link = await this.deps.store.findLink(
      action.provider,
      action.workspaceId,
      action.subject,
    );
    if (!link || !this.deps.actionSecret) return refuse('not_yours');
    if (isAgentApprovalAction(action.value)) return this.#actAgent(action, link, target);
    const check = verifyApprovalAction(this.deps.actionSecret, action.value, this.#now());
    if (!check.ok) return refuse(check.reason === 'expired' ? 'expired' : 'not_yours');
    // 印は「この連携に出したボタン」。転送されたボタンを別の人が押しても通さない
    if (check.action.linkId !== link.id) return refuse('not_yours');

    const pending = await this.deps.tasks
      .pendingApprovals(link.tenantId, check.action.taskId)
      .catch(() => []);
    const approval = pending.find((a) => a.id === check.action.approvalId);
    if (!approval) return refuse('decided');
    if (!CHAT_APPROVABLE.has(approval.risk)) return refuse('not_allowed');

    try {
      await this.deps.tasks.decideApproval(
        link.tenantId,
        check.action.taskId,
        link.userId,
        check.action.approvalId,
        check.action.decision,
      );
    } catch (error) {
      this.#log('channel.approval_failed', { link_id: link.id, error: errorCode(error) });
      return refuse('decided');
    }
    await this.deps.store.auditApproval(
      link,
      check.action.taskId,
      check.action.approvalId,
      check.action.decision,
    );
    await this.#reply(
      action.provider,
      target,
      render.decided(check.action.decision),
      action.replyToken,
    );
    return 'decided';
  }

  /** Claude Code の承認のボタン。印・期限・押した人を確かめてから gateway へ渡す。 */
  async #actAgent(
    action: InboundChannelAction,
    link: { id: string; tenantId: string; userId: string },
    target: { destination: string; threadKey: string },
  ): Promise<'refused' | 'decided'> {
    const answer = async (result: Parameters<typeof render.agentApprovalAnswered>[0]) =>
      this.#reply(action.provider, target, render.agentApprovalAnswered(result), action.replyToken);
    const check = verifyAgentApprovalAction(this.deps.actionSecret!, action.value, this.#now());
    if (!check.ok) {
      await answer(check.reason === 'expired' ? 'expired' : 'not_yours');
      return 'refused';
    }
    // 転送されたボタンを別の人が押しても通さない
    if (check.action.linkId !== link.id || !this.deps.agentApprovals) {
      await answer('not_yours');
      return 'refused';
    }
    const result = await this.deps.agentApprovals
      .decide(link.tenantId, link.userId, check.action.approvalId, check.action.choice)
      .catch(() => 'gone' as const);
    if (result === 'decided' || result === 'decided_with_rule') {
      const choice = check.action.choice;
      await answer(
        choice === 'deny'
          ? 'denied'
          : choice === 'allow_session'
            ? 'allowed_session'
            : choice === 'allow_project'
              ? 'allowed_project'
              : 'allowed',
      );
      return 'decided';
    }
    await answer(result);
    return result === 'awaiting_instruction' ||
      result === 'awaiting_text' ||
      result === 'answered' ||
      result === 'next_question' ||
      result === 'skipped'
      ? 'decided'
      : 'refused';
  }

  /**
   * 予約のお知らせを、頼まれたチャットのスレッドへ送る。チャットの会話でなければ 'none'。
   * 送れたか分からないときは 'unknown'（送り直しは outbox の規則どおり）。
   */
  /**
   * 本人の LINE の 1:1 へ、出来上がったメッセージ（画像つきなど）を送る。LINE をつないでいなければ none。
   */
  async notifyUserMessage(
    tenantId: string,
    userId: string,
    message: OutgoingMessage,
  ): Promise<'delivered' | 'failed' | 'unknown' | 'none'> {
    const link = (await this.deps.store.listLinks(tenantId, userId)).find(
      (l) => l.provider === 'line',
    );
    if (!link) return 'none';
    const conversationId = await this.deps.store.conversationFor(
      link,
      link.subject,
      link.subject,
      () => this.deps.conversations.start(tenantId, userId, titleOf('line')),
    );
    return this.#notice(tenantId, conversationId, message);
  }

  async notifyConversation(
    tenantId: string,
    conversationId: string,
    text: string,
    quickReplies?: readonly QuickReply[],
  ): Promise<'delivered' | 'failed' | 'unknown' | 'none'> {
    return this.#notice(tenantId, conversationId, render.notice(text, quickReplies));
  }

  /**
   * Claude Code の承認を本人の LINE の 1:1 へ（ボタンはこの連携に縛って署名する）。
   * 送れた（または outbox が送り直す）なら true。LINE をつないでいない・署名鍵が無いなら false（Mac の問いだけになる）。
   */
  async askAgentApproval(
    tenantId: string,
    userId: string,
    approvalId: string,
    view: render.AgentApprovalCardView,
    timeZone: string,
  ): Promise<boolean> {
    if (!this.deps.actionSecret) return false;
    const link = (await this.deps.store.listLinks(tenantId, userId)).find(
      (l) => l.provider === 'line',
    );
    if (!link) return false;
    const conversationId = await this.deps.store.conversationFor(
      link,
      link.subject,
      link.subject,
      () => this.deps.conversations.start(tenantId, userId, titleOf('line')),
    );
    const sign = (choice: AgentApprovalAction['choice']) =>
      signAgentApprovalAction(this.deps.actionSecret!, {
        approvalId,
        linkId: link.id,
        choice,
        expiresAt: view.expiresAt.getTime(),
      });
    const question = view.question;
    // Claude Code の質問: 選択肢をそのままボタンに（押した選択肢の文を Claude Code へ答えとして返す）
    const body = question
      ? render.agentQuestion(
          view,
          question,
          {
            options: question.options.map((_, o) => sign(`answer_${question.index}_${o}`)),
            text: sign('instruct'),
            skip: sign('deny'),
          },
          timeZone,
        )
      : render.agentApproval(
          view,
          {
            allow: sign('allow'),
            deny: sign('deny'),
            instruct: sign('instruct'),
            // 継続許可にしてよい種類のときだけ出す（gateway でも押されたときに確かめ直す）
            allowSession: view.ruleable ? sign('allow_session') : null,
            allowProject: view.ruleable ? sign('allow_project') : null,
          },
          timeZone,
        );
    // 送れたか分からない（'unknown'）ものは outbox が送り直す。待ちを閉じると、あとで届いたカードが押せなくなるので、
    // 届くものとして待つ（そのあいだも Mac の問いでは答えられる）
    const sent = await this.#notice(tenantId, conversationId, body);
    return sent === 'delivered' || sent === 'unknown';
  }

  async #notice(
    tenantId: string,
    conversationId: string,
    body: OutgoingMessage,
  ): Promise<'delivered' | 'failed' | 'unknown' | 'none'> {
    const thread = await this.deps.store.threadForConversation(tenantId, conversationId);
    if (!thread) return 'none';
    const id = await this.deps.store.enqueue({
      tenantId,
      linkId: thread.link.id,
      taskId: null,
      eventSequence: null,
      kind: 'notice',
      destination: thread.destination,
      threadKey: thread.threadKey,
      body,
    });
    if (!id) return 'failed';
    const sent = await this.#send(
      {
        id,
        tenantId,
        linkId: thread.link.id,
        provider: thread.link.provider,
        destination: thread.destination,
        threadKey: thread.threadKey,
        kind: 'notice',
        body,
        attempts: 0,
      },
      null,
    );
    // 送れなかったものは outbox に残り、見回りが送り直す（送り直してよいものだけ）
    return sent ? 'delivered' : 'unknown';
  }

  /**
   * 予約で始めた仕事を、頼まれたチャットのスレッドで見守る（受付・承認待ち・終わりを返す）。
   * チャットの会話でなければ 'none'。
   */
  /**
   * 通話などで始めた仕事を、その会話のトークで見回る。受付は送らず、終わったら答え（または終わりの知らせ）を返す。
   */
  /**
   * 本人へ知らせる。その会話がチャットの会話ならそこへ、違えば（Mac の Task Dock から頼んだなど）本人の LINE の 1:1 へ。
   * どちらも無ければ 'none'。
   */
  async notifyUser(
    tenantId: string,
    userId: string,
    /** null なら、どの会話から始まった知らせでもない（本人の LINE へ）。 */
    conversationId: string | null,
    text: string,
    quickReplies?: readonly QuickReply[],
  ): Promise<'delivered' | 'failed' | 'unknown' | 'none'> {
    if (conversationId) {
      const here = await this.notifyConversation(tenantId, conversationId, text, quickReplies);
      if (here !== 'none') return here;
    }
    const link = (await this.deps.store.listLinks(tenantId, userId)).find(
      (l) => l.provider === 'line',
    );
    if (!link) return 'none';
    const lineConversation = await this.deps.store.conversationFor(
      link,
      link.subject,
      link.subject,
      () => this.deps.conversations.start(tenantId, userId, titleOf('line')),
    );
    return this.notifyConversation(tenantId, lineConversation, text, quickReplies);
  }

  async watchTask(tenantId: string, conversationId: string, taskId: string): Promise<boolean> {
    const thread = await this.deps.store.threadForConversation(tenantId, conversationId);
    if (!thread) return false;
    const id = await this.deps.store.enqueue({
      tenantId,
      linkId: thread.link.id,
      taskId,
      eventSequence: 0,
      kind: 'accepted',
      destination: thread.destination,
      threadKey: thread.threadKey,
      body: render.accepted(null),
      answerInline: true,
    });
    if (id) await this.deps.store.markSent(tenantId, id, null);
    return true;
  }

  /**
   * 本人の共有スペースのグループへ送る（本人が「送って」と確かめたあとだけ呼ぶ）。
   * 送れたグループの数を返す（グループが無ければ 0）。
   */
  async postToGroup(tenantId: string, ownerUserId: string, text: string): Promise<number> {
    const groups = await this.deps.store.groupsForOwner(tenantId, ownerUserId);
    const group = groups[0];
    if (!group) return 0;
    const sender = this.deps.senders[group.provider];
    if (!sender) return 0;
    if (group.provider === 'line') await this.deps.hub?.claimGroup(group.groupId);
    try {
      await sender.send(
        { destination: group.groupId, threadKey: group.groupId },
        render.notice(text),
        { replyToken: null, retryKey: crypto.randomUUID() },
      );
      return 1;
    } catch (error) {
      this.#log('channel.group_post_failed', { provider: group.provider, error: errorCode(error) });
      return 0;
    }
  }

  /**
   * 公式アカウントにかかってきた LINE の電話を、かけた人の Genie の会話につなぐ鍵を出す。
   * かけた人が分からない（subject が null）ときは、この Genie の LINE の連携が 1 つだけのときに限ってその人とみなす。
   * **連携していない人の電話にはつながない**（本人のメールや予定を使える Genie に、他人が話せてしまう）。
   */
  async lineCallKey(
    subject: string | null,
  ): Promise<
    | { readonly token: string }
    | { readonly refused: 'not_linked' | 'caller_unknown' | 'unavailable' }
  > {
    if (!this.deps.call?.bridge) return { refused: 'unavailable' };
    const links = await this.deps.store.lineLinks(subject);
    if (links.length === 0) return { refused: 'not_linked' };
    if (links.length > 1) return { refused: 'caller_unknown' };
    const link = links[0]!;
    const conversationId = await this.deps.store.conversationFor(
      link,
      link.subject,
      link.subject,
      () => this.deps.conversations.start(link.tenantId, link.userId, titleOf('line')),
    );
    const token = await this.deps.call.bridge(link, conversationId);
    this.#log('channel.line_call_bridged', {
      link_id: link.id,
      ok: token !== null,
      identified: subject !== null,
    });
    return token ? { token } : { refused: 'unavailable' };
  }

  /**
   * Genie から電話する（予約の「電話で起こして」）。トークに「電話に出る」を送る。
   * 電話を使えなければ 'none'（呼ぶ側がいつものお知らせに切り替える）。
   */
  async ring(
    tenantId: string,
    conversationId: string,
    opening: string,
  ): Promise<'delivered' | 'failed' | 'unknown' | 'none'> {
    const thread = await this.deps.store.threadForConversation(tenantId, conversationId);
    if (!thread || !this.deps.call?.ring) return 'none';
    const message = await this.deps.call.ring(thread.link, conversationId, opening);
    if (!message) return 'none';
    await this.#queueAndSend(
      thread.link,
      { destination: thread.destination, threadKey: thread.threadKey },
      null,
      null,
      'notice',
      message,
      null,
    );
    return 'delivered';
  }

  /** 家族のグループへ送る（通話のまとめなど。グループを使い始めた本人の頼みの結果だけ）。 */
  async postToGroupId(provider: ChannelProvider, groupId: string, text: string): Promise<void> {
    await this.#reply(
      provider,
      { destination: groupId, threadKey: groupId },
      render.notice(text),
      null,
    );
  }

  async followTask(
    tenantId: string,
    conversationId: string,
    taskId: string,
    title: string | null,
  ): Promise<'delivered' | 'failed' | 'unknown' | 'none'> {
    const thread = await this.deps.store.threadForConversation(tenantId, conversationId);
    if (!thread) return 'none';
    await this.#queueAndSend(
      thread.link,
      { destination: thread.destination, threadKey: thread.threadKey },
      taskId,
      0,
      'accepted',
      render.scheduledStarted(title),
      null,
    );
    return 'delivered';
  }

  /**
   * 見回り。受け付けた task の区切りを積み、積んであるものを送る。
   * 何度呼んでも同じイベントは 1 回しか送らない（outbox の一意索引）。
   */
  async pump(
    /** 1 つのテナントだけを見回る（試験が、同じ DB の別の試験の行を送らないように）。 */
    only?: string,
  ): Promise<{ queued: number; sent: number; failed: number }> {
    let queued = 0;
    let sent = 0;
    let failed = 0;
    const tenants = only ? [only] : await this.deps.store.tenantsWithLinks();
    for (const tenantId of tenants) {
      for (const watch of await this.deps.store.watchedTasks(tenantId)) {
        try {
          queued += await this.#queueMilestones(tenantId, watch);
        } catch (error) {
          this.#log('channel.watch_failed', { task_id: watch.taskId, error: errorCode(error) });
        }
      }
      for (const row of await this.deps.store.pending(tenantId)) {
        if (await this.#send(row, null)) sent += 1;
        else failed += 1;
      }
    }
    return { queued, sent, failed };
  }

  async #queueMilestones(tenantId: string, watch: WatchedTask): Promise<number> {
    const events = await this.deps.tasks.eventsAfter(tenantId, watch.taskId, watch.lastSequence);
    let queued = 0;
    for (const event of events) {
      const kind = EVENT_KIND[event.type];
      if (!kind) continue;
      const terminal = kind === 'completed' || kind === 'failed' || kind === 'cancelled';
      // グループで頼まれた会議は、終わりをそのグループにも知らせる（Meet のリンク・見送り）。
      // 持ち主への終わりより先に積む（間で止まっても、次の見回りでもう一度積まれ、一意索引で 1 回になる）
      if (terminal) {
        const group = await this.#groupReply(tenantId, watch, kind);
        if (group) {
          const groupRow = await this.deps.store.enqueue({
            tenantId,
            linkId: watch.linkId,
            taskId: watch.taskId,
            // 持ち主への行とは負の番号で分ける
            eventSequence: -event.sequence,
            kind: 'notice',
            destination: group.destination,
            threadKey: group.destination,
            body: render.notice(group.text),
          });
          if (groupRow) queued += 1;
        }
      }
      const body = await this.#milestone(tenantId, watch, kind, event);
      const id = await this.deps.store.enqueue({
        tenantId,
        linkId: watch.linkId,
        taskId: watch.taskId,
        eventSequence: event.sequence,
        kind,
        destination: watch.destination,
        threadKey: watch.threadKey,
        body,
      });
      if (id) queued += 1;
      // 終わりを積んだら、この task はもう見ない
      if (terminal) break;
    }
    return queued;
  }

  /** グループで頼まれた会議の終わりに、そのグループへ送る文。会議の仕事でなければ null */
  async #groupReply(
    tenantId: string,
    watch: WatchedTask,
    kind: OutboxKind,
  ): Promise<{ destination: string; text: string } | null> {
    const task = await this.deps.tasks.get(tenantId, watch.taskId).catch(() => null);
    const groupId = task?.input?.['group_id'];
    const meetingKind = task?.kind === 'calendar.meeting' || task?.kind === 'calendar.invite';
    if (!task || !meetingKind || typeof groupId !== 'string' || !groupId) return null;
    const title = typeof task.input?.['title'] === 'string' ? task.input['title'] : '会議';
    if (task.kind === 'calendar.invite' && kind !== 'completed')
      return {
        destination: groupId,
        text:
          kind === 'cancelled'
            ? `会議「${title}」への招待は、持ち主が見送ったので送っていません。`
            : `会議「${title}」に招待できませんでした。持ち主のトークに理由を送っています。`,
      };
    if (kind !== 'completed')
      return {
        destination: groupId,
        text:
          kind === 'cancelled'
            ? `会議「${title}」は、持ち主が見送ったので入れていません。`
            : `会議「${title}」を入れられませんでした。持ち主のトークに理由を送っています。`,
      };
    const body =
      task.result_artifact_id && this.deps.artifactText
        ? await this.deps.artifactText(tenantId, task.result_artifact_id).catch(() => null)
        : null;
    return {
      destination: groupId,
      text: body?.trim() || `会議「${title}」を入れました。`,
    };
  }

  async #milestone(
    tenantId: string,
    watch: WatchedTask,
    kind: OutboxKind,
    event: ChannelEvent,
  ): Promise<OutgoingMessage> {
    const payload = (event.payload ?? {}) as Record<string, unknown>;
    switch (kind) {
      case 'waiting_approval': {
        const approvalId = typeof payload['approval_id'] === 'string' ? payload['approval_id'] : '';
        const risk = typeof payload['risk'] === 'string' ? payload['risk'] : '';
        const pending = await this.deps.tasks
          .pendingApprovals(tenantId, watch.taskId)
          .catch(() => []);
        const approval = pending.find((a) => a.id === approvalId);
        const view = {
          summary:
            approval?.summary ??
            (typeof payload['summary'] === 'string' ? payload['summary'] : '確認が必要です'),
          details: detailsOf(approval?.details),
          primaryActionLabel:
            typeof payload['primary_action_label'] === 'string'
              ? payload['primary_action_label']
              : '進める',
        };
        const expires =
          typeof payload['expires_at'] === 'string' ? Date.parse(payload['expires_at']) : NaN;
        const expiresAt = Math.min(
          this.#now() + BUTTON_TTL_MS,
          Number.isFinite(expires) ? expires : Infinity,
        );
        const buttons =
          this.deps.actionSecret && approval && CHAT_APPROVABLE.has(risk)
            ? {
                approve: signApprovalAction(this.deps.actionSecret, {
                  approvalId,
                  taskId: watch.taskId,
                  linkId: watch.linkId,
                  decision: 'APPROVED',
                  expiresAt,
                }),
                reject: signApprovalAction(this.deps.actionSecret, {
                  approvalId,
                  taskId: watch.taskId,
                  linkId: watch.linkId,
                  decision: 'REJECTED',
                  expiresAt,
                }),
              }
            : null;
        return render.waitingApproval(view, buttons);
      }
      case 'paused':
        return render.paused(typeof payload['message'] === 'string' ? payload['message'] : null);
      case 'completed': {
        const task = await this.deps.tasks.get(tenantId, watch.taskId).catch(() => null);
        // 電話は結果カード（結果を先頭に）。報告の形で読めなければ、いつもの知らせ
        if (task?.kind?.startsWith('phone.') && task.result_artifact_id && this.deps.artifactText) {
          const report = parseCallReport(
            (await this.deps.artifactText(tenantId, task.result_artifact_id).catch(() => null)) ??
              '',
          );
          if (report) {
            const homeUrl =
              task.created_by && this.deps.homeLink
                ? await this.deps.homeLink(tenantId, task.created_by).catch(() => null)
                : null;
            return render.callResult(report, homeUrl);
          }
        }
        // 会議は入れた結果（Meet のリンク・招待）をそのまま返す。作業一覧を開かないとリンクが分からないのでは使えない
        if (
          (task?.kind === 'calendar.meeting' || task?.kind === 'calendar.invite') &&
          task.result_artifact_id &&
          this.deps.artifactText
        ) {
          const made = await this.deps
            .artifactText(tenantId, task.result_artifact_id)
            .catch(() => null);
          if (made?.trim()) return render.answer(made);
        }
        // 会話の答えは本文そのもの（本人がこのチャットで聞いたこと）。読めなければ、いつもの終わりの知らせ
        if (watch.answerInline && task?.result_artifact_id && this.deps.artifactText) {
          const answer = await this.deps
            .artifactText(tenantId, task.result_artifact_id)
            .catch(() => null);
          if (answer?.trim()) {
            // 答えを会話に残す。次の「で？」「それ」が、この答えの続きとして読める（仕様 v1.0 §5②）
            void this.deps.conversations
              .remember?.(tenantId, watch.taskId, answer)
              .catch(() => undefined);
            // 予定・天気・ニュースは、元の成果物からカードにする（読めなければ文だけ）
            const card = await this.deps
              .artifactBody?.(tenantId, task.result_artifact_id)
              .catch(() => null);
            return render.answer(answer, card ?? undefined);
          }
        }
        const body =
          watch.postingPolicy === 'full_text' && task?.result_artifact_id && this.deps.artifactText
            ? await this.deps.artifactText(tenantId, task.result_artifact_id).catch(() => null)
            : null;
        const homeUrl =
          !body && task?.created_by && this.deps.homeLink
            ? await this.deps.homeLink(tenantId, task.created_by).catch(() => null)
            : null;
        return render.completed(task?.title ?? null, watch.postingPolicy, body, homeUrl);
      }
      case 'failed': {
        const error = payload['error'];
        const message =
          typeof error === 'object' &&
          error !== null &&
          typeof (error as Record<string, unknown>)['message'] === 'string'
            ? ((error as Record<string, unknown>)['message'] as string)
            : null;
        return render.failed(message);
      }
      case 'cancelled':
        return render.cancelled();
      default:
        return render.notice('');
    }
  }

  async #queueAndSend(
    link: ChannelLink,
    target: { destination: string; threadKey: string },
    taskId: string | null,
    eventSequence: number | null,
    kind: OutboxKind,
    body: OutgoingMessage,
    replyToken: string | null,
  ): Promise<void> {
    const id = await this.deps.store.enqueue({
      tenantId: link.tenantId,
      linkId: link.id,
      taskId,
      eventSequence,
      kind,
      destination: target.destination,
      threadKey: target.threadKey,
      body,
    });
    if (!id) return;
    await this.#send(
      {
        id,
        tenantId: link.tenantId,
        linkId: link.id,
        provider: link.provider,
        ...target,
        kind,
        body,
        attempts: 0,
      },
      replyToken,
    );
  }

  /** 1 行送る。送れたら SENT、駄目なら失敗を記録する（再送は次の見回り）。 */
  async #send(row: OutboxRow, replyToken: string | null): Promise<boolean> {
    const sender = this.deps.senders[row.provider];
    if (!sender) {
      await this.deps.store.markFailed(row.tenantId, row.id, 'sender_not_configured', false);
      return false;
    }
    try {
      const sent = await sender.send(row, row.body, { replyToken, retryKey: row.id });
      await this.deps.store.markSent(row.tenantId, row.id, sent.providerMessageId);
      return true;
    } catch (error) {
      const retryable = error instanceof ChannelSendError ? error.retryable : true;
      const retryAfterMs = error instanceof ChannelSendError ? error.retryAfterMs : null;
      await this.deps.store.markFailed(
        row.tenantId,
        row.id,
        errorCode(error),
        retryable,
        retryAfterMs,
      );
      this.#log('channel.send_failed', { outbox_id: row.id, error: errorCode(error), retryable });
      return false;
    }
  }
}

function keyOf(inbound: ChannelInbound): { provider: ChannelProvider; eventId: string } {
  const body =
    inbound.kind === 'message'
      ? inbound.message
      : inbound.kind === 'action'
        ? inbound.action
        : inbound.follow;
  return { provider: body.provider, eventId: body.eventId };
}

/** 同じ相手（提供者・区画・話しかけた人）の発話は 1 列に並べる。 */
function laneOf(inbound: ChannelInbound): string {
  const body =
    inbound.kind === 'message'
      ? inbound.message
      : inbound.kind === 'action'
        ? inbound.action
        : inbound.follow;
  return `${body.provider}:${body.workspaceId}:${body.subject}`;
}

/** 封を別の行へ写しても開かないように、どの配信のものかを結びつける。 */
const aadOf = (provider: ChannelProvider, eventId: string) =>
  `genie-channel-inbox:${provider}:${eventId}`;

function titleOf(provider: ChannelProvider): string {
  return provider === 'slack' ? 'Slack から' : 'LINE から';
}

function detailsOf(details: unknown): { label: string; value: string }[] {
  if (!Array.isArray(details)) return [];
  return details.flatMap((d: unknown) => {
    if (typeof d !== 'object' || d === null) return [];
    const { label, value } = d as Record<string, unknown>;
    return typeof label === 'string' && typeof value === 'string' ? [{ label, value }] : [];
  });
}

function errorCode(error: unknown): string {
  if (error instanceof ChannelSendError) return error.code;
  // 名前だけ（TypeError など）では理由が分からないので、短い説明も付ける
  if (error instanceof Error)
    return error.name === 'Error'
      ? error.message.slice(0, 120)
      : `${error.name}: ${error.message.slice(0, 120)}`;
  return 'unknown';
}
