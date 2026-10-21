/**
 * チャット（Slack / LINE）を gateway に繋ぐ。
 *
 * 設定された提供者だけが開く:
 *   SLACK_BOT_TOKEN + SLACK_APP_TOKEN                Slack（Socket Mode。公開 URL が要らない。手元の Mac 向け）
 *   SLACK_BOT_TOKEN + SLACK_SIGNING_SECRET           Slack（Events API / Interactivity。公開 HTTPS が要る）
 *   LINE_CHANNEL_SECRET + LINE_CHANNEL_ACCESS_TOKEN  LINE（Messaging API）
 *   GENIE_CHANNEL_ACTION_SECRET                       チャットの承認ボタンの署名鍵（無ければボタンを出さない）
 *   GENIE_SECRET_KEY                                  あれば、受けた本文を封じて保存してから「受け取った」と返す
 *                                                     （落ちても続きから処理できる）。無ければ本文を持たない
 *
 * 連携ごとの仮の端末は devices（このサービスの持ち物）に作る。
 */
import { SendTurnRequest, uuidv7, type ChannelProvider } from '@genie/contracts';
import { withTenant, type DbHandle } from '@genie/db';
import {
  ChannelService,
  ChannelStore,
  LineSender,
  SlackSender,
  SlackSocketMode,
  normalizeSlackAction,
  normalizeSlackEvent,
  type ChannelSender,
  type SlackSocketStatus,
} from '@genie/service-channels';
import { secretBoxFromEnv } from '@genie/service-phone';
import { handleTurn, type ConversationService, type TurnDeps } from '@genie/service-conversation';
import type { LibraryService } from '@genie/service-library';
import type { TaskService } from '@genie/service-task';
import type { Logger } from '@genie/telemetry';
import type { ChannelRouteDeps } from './routes/channels.js';

/** 設定画面と doctor が見る、チャットの繋がり具合（秘密は含めない）。 */
export interface ChannelsStatus {
  readonly slack: {
    readonly configured: boolean;
    readonly transport: 'socket' | 'http' | null;
    readonly socket: SlackSocketStatus | null;
  };
  readonly line: { readonly configured: boolean };
  /** 受けた本文を保存してから受け取る（GENIE_SECRET_KEY がある）か。 */
  readonly durableInbox: boolean;
  readonly approvalButtons: boolean;
}

export interface GatewayChannels {
  readonly routes: ChannelRouteDeps;
  readonly service: ChannelService;
  /** Socket Mode のとき、その接続（テストで状態を見るため）。 */
  readonly socket: SlackSocketMode | null;
  /** 見回り（区切りの送信）を回す。止めるときは stop。 */
  start(intervalMs?: number): void;
  stop(): void;
}

export function channelsFromEnv(
  env: NodeJS.ProcessEnv,
  deps: {
    readonly db: DbHandle;
    readonly tasks: TaskService;
    readonly conversations: ConversationService;
    readonly library: LibraryService;
    readonly turnDeps: TurnDeps;
    readonly logger: Logger;
    readonly fetchImpl?: typeof fetch;
    /** Socket Mode の WebSocket（テストで差し替える）。 */
    readonly connectSocket?: (url: string) => import('@genie/service-channels').SocketLike;
  },
): GatewayChannels | null {
  const slackSecret = env['SLACK_SIGNING_SECRET']?.trim() || null;
  const slackToken = env['SLACK_BOT_TOKEN']?.trim() || null;
  const slackAppToken = env['SLACK_APP_TOKEN']?.trim() || null;
  const lineSecret = env['LINE_CHANNEL_SECRET']?.trim() || null;
  const lineToken = env['LINE_CHANNEL_ACCESS_TOKEN']?.trim() || null;
  if (slackAppToken && !slackAppToken.startsWith('xapp-')) {
    throw new Error('SLACK_APP_TOKEN は App-Level Token（xapp- で始まる）にしてください。');
  }
  const slack =
    slackToken && (slackSecret || slackAppToken)
      ? new SlackSender(slackToken, deps.fetchImpl)
      : null;
  const line = lineSecret && lineToken ? new LineSender(lineToken, deps.fetchImpl) : null;
  if (!slack && !line) return null;

  const actionSecret = env['GENIE_CHANNEL_ACTION_SECRET']?.trim() || null;
  if (actionSecret !== null && actionSecret.length < 32) {
    throw new Error('GENIE_CHANNEL_ACTION_SECRET は 32 文字以上にしてください。');
  }

  const sealer = secretBoxFromEnv(env);
  const store = new ChannelStore(deps.db);
  const senders: Partial<Record<ChannelProvider, ChannelSender>> = {
    ...(slack ? { slack } : {}),
    ...(line ? { line } : {}),
  };
  const service = new ChannelService({
    store,
    senders,
    ...(slack ? { slack } : {}),
    devices: {
      create: (tenantId, userId, provider) =>
        createChannelDevice(deps.db, tenantId, userId, provider),
      revoke: (tenantId, deviceId) => revokeChannelDevice(deps.db, tenantId, deviceId),
    },
    conversations: {
      start: async (tenantId, userId, title) =>
        (await deps.conversations.start(tenantId, userId, { title, responseMode: 'text' })).id,
    },
    turn: async (principal, conversationId, text) => {
      const result = await handleTurn(deps.turnDeps, {
        principal,
        conversationId,
        body: SendTurnRequest.parse({ text: text.slice(0, 8_000), modality: 'text' }),
      });
      // 注文の条件を聞く途中（answered）も、チャットでは聞き返しと同じく答えの文を返す。
      return result.kind === 'clarification' || result.kind === 'answered'
        ? { kind: 'clarification', answer: result.answer.text }
        : { kind: 'started', taskId: result.taskId, notice: result.notice };
    },
    tasks: {
      get: (tenantId, taskId) => deps.tasks.get(tenantId, taskId),
      eventsAfter: (tenantId, taskId, after) => deps.tasks.eventsAfter(tenantId, taskId, after),
      pendingApprovals: (tenantId, taskId) => deps.tasks.pendingApprovals(tenantId, taskId),
      decideApproval: (tenantId, taskId, userId, approvalId, decision) =>
        deps.tasks.decideApproval(tenantId, taskId, userId, approvalId, decision),
    },
    artifactText: async (tenantId, artifactId) => {
      const { stream, artifact } = await deps.library.readContent(tenantId, artifactId);
      // 文字の成果物だけ。画像や JSON はチャットに流さない
      if (!artifact.mime_type.startsWith('text/')) {
        stream.destroy();
        return null;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of stream) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
        chunks.push(buffer);
        size += buffer.length;
        if (size > 64_000) break;
      }
      stream.destroy();
      return Buffer.concat(chunks).toString('utf8');
    },
    actionSecret,
    sealer,
    log: (event, detail) => deps.logger.info(detail, event),
  });

  // Socket Mode: gateway から Slack へ繋ぐ。受けたものは HTTP の受け口と同じ形で受け口へ
  const socket =
    slack && slackAppToken
      ? new SlackSocketMode({
          appToken: slackAppToken,
          ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
          ...(deps.connectSocket ? { connect: deps.connectSocket } : {}),
          onEvent: async (payload) => {
            const inbound = normalizeSlackEvent(payload);
            if (inbound.kind === 'message')
              await service.accept({ kind: 'message', message: inbound.message });
          },
          onInteractive: async (payload) => {
            const inbound = normalizeSlackAction(payload);
            if (inbound.kind === 'action')
              await service.accept({ kind: 'action', action: inbound.action });
          },
          log: (event, detail) => deps.logger.info(detail, event),
        })
      : null;

  const status = (): ChannelsStatus => ({
    slack: {
      configured: Boolean(slack),
      transport: slack ? (socket ? 'socket' : 'http') : null,
      socket: socket?.status() ?? null,
    },
    line: { configured: Boolean(line) },
    durableInbox: Boolean(sealer),
    approvalButtons: Boolean(actionSecret),
  });

  let timer: ReturnType<typeof setInterval> | null = null;
  let running = false;
  return {
    routes: {
      service,
      store,
      slackSigningSecret: slack ? slackSecret : null,
      lineChannelSecret: line ? lineSecret : null,
      status,
    },
    service,
    socket,
    start(intervalMs = 5_000) {
      if (timer) return;
      socket?.start();
      timer = setInterval(() => {
        if (running) return;
        running = true;
        // 受けて残っているもの（前に落ちたプロセスの分を含む）→ 区切りの送信 → 掃除
        service
          .drain()
          .then(() => service.pump())
          .then(() => store.pruneInbox())
          .catch((error: unknown) => deps.logger.warn({ err: error }, 'channel pump failed'))
          .finally(() => {
            running = false;
          });
      }, intervalMs);
      timer.unref();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
      socket?.stop();
    },
  };
}

/** 連携 1 件につき仮の端末を 1 つ。監査に「どこから来たか」が残る。 */
export async function createChannelDevice(
  db: DbHandle,
  tenantId: string,
  userId: string,
  provider: ChannelProvider,
): Promise<string> {
  const id = uuidv7();
  await withTenant(db, tenantId, (tx) =>
    tx
      .insertInto('devices')
      .values({
        id,
        tenant_id: tenantId,
        user_id: userId,
        platform: provider,
        name: provider === 'slack' ? 'Slack' : 'LINE',
        app_version: 'channel',
      })
      .execute(),
  );
  return id;
}

export async function revokeChannelDevice(
  db: DbHandle,
  tenantId: string,
  deviceId: string,
): Promise<void> {
  await withTenant(db, tenantId, (tx) =>
    tx.updateTable('devices').set({ revoked_at: new Date() }).where('id', '=', deviceId).execute(),
  );
}
