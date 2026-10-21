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
import type { ChannelProvider } from '@genie/contracts';
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
  type SlackSender,
} from './send.js';
import {
  MAX_INBOUND_ATTEMPTS,
  type ChannelLink,
  type ChannelStore,
  type OutboxKind,
  type OutboxRow,
  type QueuedInbound,
  type WatchedTask,
} from './store.js';
import { linkCodeIn, signApprovalAction, verifyApprovalAction } from './tokens.js';

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
  | { readonly kind: 'clarification'; readonly answer: string }
  | { readonly kind: 'started'; readonly taskId: string | null; readonly notice: string | null };

export interface ChannelTaskView {
  readonly title: string | null;
  readonly result_artifact_id: string | null;
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
  /** 成果物の本文（posting_policy が full_text のときだけ読む）。 */
  readonly artifactText?: (tenantId: string, artifactId: string) => Promise<string | null>;
  /** ボタンの署名鍵。無ければチャットでは承認させない（承認カードへ案内する）。 */
  readonly actionSecret: string | null;
  /**
   * 受けた本文を封じて保存する鍵。**あれば保存してから 200 を返す**（落ちても続きから処理できる）。
   * 無ければ本文は持たず、これまでどおり 200 のあと同じプロセスで処理する。
   */
  readonly sealer?: InboundSealer | null;
  /** LINE の読み込み中を出し直す間隔（表示は 20 秒で消えるので、その少し前）。 */
  readonly typingRefreshMs?: number;
  readonly log?: (event: string, detail: Record<string, unknown>) => void;
  readonly now?: () => number;
}

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
  ): Promise<void> {
    const sender = this.deps.senders[provider];
    if (!sender) return;
    try {
      await sender.send(target, message, { replyToken, retryKey: crypto.randomUUID() });
    } catch (error) {
      this.#log('channel.reply_failed', { provider, error: errorCode(error) });
    }
  }

  /** 友だちに追加された（LINE の follow）。連携していなければ、つなぎ方を返す。 */
  async greet(
    follow: InboundChannelFollow,
    queued: QueuedContext | null = null,
  ): Promise<'duplicate' | 'unlinked' | 'linked'> {
    if (!queued && !(await this.deps.store.claimInbox(follow.provider, follow.eventId)))
      return 'duplicate';
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
      sender
        ?.typing?.(target)
        .catch((error: unknown) =>
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
      outcome = await this.deps.turn(
        { tenantId: link.tenantId, userId: link.userId },
        conversationId,
        message.text,
      );
    } catch (error) {
      this.#log('channel.turn_failed', { link_id: link.id, error: errorCode(error) });
      await this.#reply(message.provider, target, render.received(), message.replyToken);
      return 'handled';
    } finally {
      if (typing) clearInterval(typing);
    }

    if (outcome.kind === 'clarification') {
      await this.#queueAndSend(
        link,
        target,
        null,
        null,
        'notice',
        render.notice(outcome.answer),
        message.replyToken,
      );
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
        message.replyToken,
      );
    } else if (outcome.notice) {
      await this.#queueAndSend(
        link,
        target,
        null,
        null,
        'notice',
        render.notice(outcome.notice),
        message.replyToken,
      );
    }
    return 'handled';
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

  /**
   * 予約のお知らせを、頼まれたチャットのスレッドへ送る。チャットの会話でなければ 'none'。
   * 送れたか分からないときは 'unknown'（送り直しは outbox の規則どおり）。
   */
  async notifyConversation(
    tenantId: string,
    conversationId: string,
    text: string,
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
      body: render.notice(text),
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
        body: render.notice(text),
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
  async pump(): Promise<{ queued: number; sent: number; failed: number }> {
    let queued = 0;
    let sent = 0;
    let failed = 0;
    for (const tenantId of await this.deps.store.tenantsWithLinks()) {
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
      if (kind === 'completed' || kind === 'failed' || kind === 'cancelled') break;
    }
    return queued;
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
        const body =
          watch.postingPolicy === 'full_text' && task?.result_artifact_id && this.deps.artifactText
            ? await this.deps.artifactText(tenantId, task.result_artifact_id).catch(() => null)
            : null;
        return render.completed(task?.title ?? null, watch.postingPolicy, body);
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
  if (error instanceof Error)
    return error.name === 'Error' ? error.message.slice(0, 120) : error.name;
  return 'unknown';
}
