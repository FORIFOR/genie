/**
 * チャット（Slack / LINE）を Genie の仕事に繋ぐ。
 *
 *   受信 → 重複を捨てる → 連携を照合 → スレッドを会話に → handleTurn（Task Dock と同じ入口）
 *   見回り → 受け付けた task の区切り（承認待ち・一時停止・終わり）を outbox に積む → 送る
 *   ボタン → 署名・期限・押した本人を確かめて、承認を渡す（外への送信だけ）
 *
 * 守ること:
 *   - **連携した本人の 1:1 の発話だけを頼みとして受ける。**連携していない人には連携の促しだけ返す
 *   - チャットに返すのは外部への送信。本文まで送るかは連携ごとの posting_policy（既定は要約だけ）
 *   - チャットで承認できるのは EXTERNAL_COMMIT だけ。削除・お金・規制のある記録は承認カードへ
 */
import type { ChannelProvider } from '@genie/contracts';
import type { InboundChannelAction, InboundChannelMessage } from './message.js';
import * as render from './render.js';
import {
  ChannelSendError,
  type ChannelSender,
  type OutgoingMessage,
  type SlackSender,
} from './send.js';
import type { ChannelLink, ChannelStore, OutboxKind, OutboxRow, WatchedTask } from './store.js';
import { linkCodeIn, signApprovalAction, verifyApprovalAction } from './tokens.js';

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
  readonly log?: (event: string, detail: Record<string, unknown>) => void;
  readonly now?: () => number;
}

/** チャットで承認してよい risk。 */
const CHAT_APPROVABLE = new Set(['EXTERNAL_COMMIT']);
/** ボタンの有効時間。承認そのものの期限より長くはしない。 */
const BUTTON_TTL_MS = 10 * 60 * 1000;

const EVENT_KIND: Readonly<Record<string, OutboxKind>> = {
  'task.waiting_approval': 'waiting_approval',
  'task.paused': 'paused',
  'task.completed': 'completed',
  'task.failed': 'failed',
  'task.cancelled': 'cancelled',
};

export class ChannelService {
  readonly #now: () => number;

  constructor(private readonly deps: ChannelServiceDeps) {
    this.#now = deps.now ?? Date.now;
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

  /** 発話を受ける。**重複は何もしない**（再送でも仕事は 1 つ）。 */
  async receive(
    message: InboundChannelMessage,
  ): Promise<'duplicate' | 'unlinked' | 'linked' | 'handled'> {
    if (!(await this.deps.store.claimInbox(message.provider, message.eventId))) return 'duplicate';

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

    let outcome: TurnOutcome;
    try {
      const conversationId = await this.deps.store.conversationFor(
        link,
        message.threadKey,
        destination,
        () => this.deps.conversations.start(link.tenantId, link.userId, titleOf(message.provider)),
      );
      outcome = await this.deps.turn(
        { tenantId: link.tenantId, userId: link.userId },
        conversationId,
        message.text,
      );
    } catch (error) {
      this.#log('channel.turn_failed', { link_id: link.id, error: errorCode(error) });
      await this.#reply(message.provider, target, render.received(), message.replyToken);
      return 'handled';
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
  async act(action: InboundChannelAction): Promise<'duplicate' | 'refused' | 'decided'> {
    if (!(await this.deps.store.claimInbox(action.provider, action.eventId))) return 'duplicate';
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
      await this.deps.store.markFailed(row.tenantId, row.id, errorCode(error), retryable);
      this.#log('channel.send_failed', { outbox_id: row.id, error: errorCode(error), retryable });
      return false;
    }
  }
}

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
