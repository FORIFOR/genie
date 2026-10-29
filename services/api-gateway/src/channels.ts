/**
 * チャット（Slack / LINE）を gateway に繋ぐ。
 *
 * 設定された提供者だけが開く:
 *   SLACK_BOT_TOKEN + SLACK_APP_TOKEN                Slack（Socket Mode。公開 URL が要らない。手元の Mac 向け）
 *   SLACK_BOT_TOKEN + SLACK_SIGNING_SECRET           Slack（Events API / Interactivity。公開 HTTPS が要る）
 *   LINE_CHANNEL_SECRET + LINE_CHANNEL_ACCESS_TOKEN  LINE（自分の公式アカウントで Messaging API を受ける）
 *   GENIE_LINE_HUB_URL + GENIE_LINE_HUB_CREDENTIAL    LINE（運営者の公式アカウント 1 つを、中継から受ける。
 *                                                     公開 URL も LINE の鍵もいらない。docs/LINE_HUB.ja.md）
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
  LineHubClient,
  hashLinkCode,
  normalizeLineWebhook,
  type LineHubEvent,
  type SocketLike,
  LineSender,
  SlackSender,
  SlackSocketMode,
  normalizeSlackAction,
  normalizeSlackEvent,
  type ChannelSender,
  type SlackSocketStatus,
} from '@genie/service-channels';
import { secretBoxFromEnv } from '@genie/service-phone';
import { createHmac } from 'node:crypto';
import WebSocket from 'ws';
import {
  handleTurn,
  splitRequests,
  type ConversationService,
  type TurnDeps,
} from '@genie/service-conversation';
import type { LibraryService } from '@genie/service-library';
import type { TaskService } from '@genie/service-task';
import type { Logger } from '@genie/telemetry';
import type { ChannelRouteDeps } from './routes/channels.js';
import { CallStore, callConfigFromEnv, type CallRecord, type CallSession } from './call.js';

/** 設定画面と doctor が見る、チャットの繋がり具合（秘密は含めない）。 */
export interface ChannelsStatus {
  readonly slack: {
    readonly configured: boolean;
    readonly transport: 'socket' | 'http' | null;
    readonly socket: SlackSocketStatus | null;
  };
  readonly line: {
    readonly configured: boolean;
    /** 中継（公式アカウント 1 つ）か、自分の公式アカウントの Webhook か。 */
    readonly transport: 'hub' | 'webhook' | null;
    readonly hub: import('@genie/service-channels').LineHubState | null;
  };
  /** 受けた本文を保存してから受け取る（GENIE_SECRET_KEY がある）か。 */
  readonly durableInbox: boolean;
  readonly approvalButtons: boolean;
}

/**
 * 管理画面の LINE の電話をつなぐ道具の合言葉。新しい鍵を増やさず、受けた本文を封じる鍵（GENIE_SECRET_KEY）から
 * 用途を分けて作る（道具も `Genie --secret get genie-secret-key` から同じものを作る）。
 */
export function lineCallBridgeKey(secretKey: string): string {
  return createHmac('sha256', secretKey).update('genie-line-call-bridge').digest('hex');
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

/** 成果物の本文（64 KB まで）。読めなければ null。 */
export async function readArtifactBody(
  library: LibraryService,
  tenantId: string,
  artifactId: string,
): Promise<string | null> {
  try {
    const { stream } = await library.readContent(tenantId, artifactId);
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
  } catch {
    return null;
  }
}

/**
 * 成果物を、チャットや声で返せる文にする。文字の成果物はそのまま、いまの情報（天気・ニュース・株価）の
 * カード（application/vnd.genie.info+json）は、カードに添えてある読み上げの文（`text`）だけ。
 * 画像やほかの JSON は流さない。
 */
export async function readArtifactText(
  library: LibraryService,
  tenantId: string,
  artifactId: string,
): Promise<string | null> {
  const { stream, artifact } = await library.readContent(tenantId, artifactId);
  // 予定の一覧（calendar.agenda）も、読み上げの文（text）を持つカード
  const info =
    artifact.mime_type === 'application/vnd.genie.info+json' ||
    artifact.mime_type === 'application/vnd.genie.agenda+json';
  if (!artifact.mime_type.startsWith('text/') && !info) {
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
  const body = Buffer.concat(chunks).toString('utf8');
  if (!info) return body;
  try {
    const card = JSON.parse(body) as { text?: unknown };
    return typeof card.text === 'string' && card.text.trim() ? card.text : null;
  } catch {
    return null;
  }
}

/** 議事録の形（モデルが書いたもの、または決まった形で組み立てたもの）。 */
export type CallMinutesText = import('@genie/service-understand').CallMinutes;

/** Genie の答えの前置き（「かしこまりました。Genieです。」など）を落とし、最初の 1〜2 文だけにする。 */
function gist(answer: string, max = 90): string {
  const text = answer
    .replace(/\s+/g, ' ')
    .replace(
      /^(?:(?:かしこまりました|承知しました|わかりました|はい)[。、!！]?\s*|Genie\s*です[。!！]?\s*)+/u,
      '',
    )
    .trim();
  const sentences = text.split(/(?<=[。！？!?])/u).filter((x) => x.trim());
  let out = '';
  for (const sentence of sentences) {
    if (out && (out + sentence).length > max) break;
    out += sentence;
  }
  out = out || text;
  return out.length > max ? `${out.slice(0, max - 1)}…` : out;
}

/**
 * モデルが使えないときの議事録。頼みと、その答え・受付から組み立てる（作り話を足さない）。
 */
export function plainMinutes(record: CallRecord): CallMinutesText {
  const seen = new Set<string>();
  const requests = record.requests.filter((r) => {
    const key = r.request.replace(/[\s。、.!?！？]/g, '');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return {
    topics: requests.slice(0, 5).map((r) => r.request.replace(/\s+/g, ' ').slice(0, 60)),
    outcomes: requests
      .filter((r) => r.status === 'answered' && r.answer)
      .slice(0, 5)
      .map((r) => gist(r.answer!)),
    next: requests
      .filter((r) => r.status !== 'answered')
      .slice(0, 5)
      .map((r) =>
        r.status === 'accepted'
          ? { who: 'genie' as const, what: `「${r.request.slice(0, 40)}」を進めています` }
          : {
              who: 'you' as const,
              what: `「${r.request.slice(0, 40)}」は受け付けられませんでした`,
            },
      ),
  };
}

/**
 * 通話の議事録（LINE へ送る）。話したこと・決まったこと・次にやること。短い通話で何も話さなければ送らない。
 */
export function callMinutesText(
  record: CallRecord,
  minutes: CallMinutesText | null,
  endedAt: Date,
  timeZone: string,
): string | null {
  if (record.requests.length === 0 && record.seconds < 20) return null;
  const m = minutes ?? plainMinutes(record);
  const length = Math.max(1, Math.round(record.seconds / 60));
  const started = new Date(endedAt.getTime() - record.seconds * 1000);
  const when = new Intl.DateTimeFormat('ja-JP', {
    timeZone,
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(started);
  const lines = [`📞 通話の議事録（${when}〜・約 ${String(length)} 分）`];
  const section = (title: string, items: readonly string[]) => {
    const kept = items.map((x) => x.replace(/\s+/g, ' ').trim()).filter(Boolean);
    if (kept.length) lines.push('', `■ ${title}`, ...kept.map((x) => `・${x}`));
  };
  section('話したこと', m.topics);
  section('決まったこと・答え', m.outcomes);
  section(
    '次にやること',
    m.next.map((n) =>
      n.who === 'you'
        ? `【あなた】${n.what}`
        : `【Genie】${n.what}（終わったらこのトークに届きます）`,
    ),
  );
  if (lines.length === 1) {
    const last = [...record.lines].reverse().find((l) => l.role === 'genie');
    lines.push(
      '',
      last ? `最後に Genie が話したこと: ${gist(last.text, 160)}` : '頼みはありませんでした。',
    );
  }
  return lines.join('\n');
}

/** 通話の中の頼みを、答えが出るまで待つ長さ。Gemini は待つ間も会話を続ける（NON_BLOCKING）。 */
const CALL_ANSWER_WAIT_MS = 45_000;

async function waitForAnswer(
  tasks: TaskService,
  library: LibraryService,
  tenantId: string,
  taskId: string,
  waitMs: number,
): Promise<string | null> {
  const until = Date.now() + waitMs;
  while (Date.now() < until) {
    const task = (await tasks.get(tenantId, taskId).catch(() => null)) as {
      status?: string;
      result_artifact_id?: string | null;
    } | null;
    if (task?.status === 'COMPLETED') {
      return task.result_artifact_id
        ? readArtifactText(library, tenantId, task.result_artifact_id).catch(() => null)
        : null;
    }
    // 承認待ち・止まった・失敗は、声では済ませない（LINE と承認カードへ）
    if (task?.status && !['QUEUED', 'RUNNING', 'PLANNING', 'PENDING'].includes(task.status))
      return null;
    await new Promise((r) => setTimeout(r, 1_000));
  }
  return null;
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
    /** 写真・外国語の文を読む。無ければ写真には「まだ読めません」と答える。 */
    readonly understand?: Pick<import('@genie/service-understand').UnderstandService, 'inbound'> &
      Partial<Pick<import('@genie/service-understand').UnderstandService, 'callMinutes'>>;
    /** 通話で Genie が声で答えたこと（「それをグループに送って」の「それ」に使う）。 */
    readonly onSpoken?: (conversationId: string, text: string) => void;
    /** 検査用: 中継への WebSocket。 */
    readonly connectHub?: (url: string, headers: Record<string, string>) => SocketLike;
    /** 検査用: 通話の Gemini Live の代わり（ループバックだけ）。 */
    readonly callEndpoint?: string;
    /** 家族・夫婦のグループ（共有スペース）。無ければグループの発言には答えない。 */
    readonly shared?: import('@genie/service-channels').ChannelServiceDeps['shared'];
    /** 仕事のホームのリンク（終わりの知らせに付ける）。 */
    readonly homeLink?: import('@genie/service-channels').ChannelServiceDeps['homeLink'];
  },
): GatewayChannels | null {
  const timeZone = env['GENIE_TIMEZONE']?.trim() || 'Asia/Tokyo';
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
  // 中継（公式アカウント 1 つ）。あれば自分の公式アカウントの鍵より優先する
  const hubUrl = env['GENIE_LINE_HUB_URL']?.trim() || null;
  const hubCredential = /^([A-Za-z0-9_-]+):([A-Za-z0-9_-]+)$/.exec(
    env['GENIE_LINE_HUB_CREDENTIAL']?.trim() ?? '',
  );
  if (hubUrl && !/^wss?:\/\//.test(hubUrl))
    throw new Error('GENIE_LINE_HUB_URL は wss:// で始まる中継の /connect にしてください。');
  let hub: LineHubClient | null = null;
  const hubEvents: { handle: ((event: LineHubEvent) => Promise<void>) | null } = { handle: null };
  if (hubUrl && hubCredential) {
    hub = new LineHubClient({
      url: hubUrl,
      installId: hubCredential[1]!,
      secret: hubCredential[2]!,
      connect:
        deps.connectHub ??
        ((url, headers) => new WebSocket(url, { headers }) as unknown as SocketLike),
      onEvent: async (event) => {
        if (!hubEvents.handle) throw new Error('not ready');
        await hubEvents.handle(event);
      },
      log: channelLog(deps.logger),
    });
  }
  const line = hub
    ? new LineSender('via-hub', hub.fetch)
    : lineSecret && lineToken
      ? new LineSender(lineToken, deps.fetchImpl)
      : null;
  if (!slack && !line) return null;

  const actionSecret = env['GENIE_CHANNEL_ACTION_SECRET']?.trim() || null;
  const sealKey = env['GENIE_SECRET_KEY']?.trim() || null;
  if (actionSecret !== null && actionSecret.length < 32) {
    throw new Error('GENIE_CHANNEL_ACTION_SECRET は 32 文字以上にしてください。');
  }

  const sealer = secretBoxFromEnv(env);
  const store = new ChannelStore(deps.db);
  const senders: Partial<Record<ChannelProvider, ChannelSender>> = {
    ...(slack ? { slack } : {}),
    ...(line ? { line } : {}),
  };
  // LINE から声で話す（通話のページ）。キー・月の上限・公開 URL がそろうまでは、理由を返すだけ
  const callConfig = {
    ...callConfigFromEnv(env),
    ...(deps.callEndpoint ? { endpoint: deps.callEndpoint } : {}),
  };
  const calls = new CallStore(deps.db);
  const service: ChannelService = new ChannelService({
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
      remember: async (tenantId, taskId, text) => {
        const task = await deps.tasks.get(tenantId, taskId);
        if (!task.conversation_id) return;
        await deps.conversations.append({
          tenantId,
          conversationId: task.conversation_id,
          role: 'assistant',
          modality: 'text',
          text: text.slice(0, 4_000),
        });
      },
    },
    ...(deps.shared ? { shared: deps.shared } : {}),
    ...(hub ? { hub } : {}),
    call: {
      groupInvite: async (owner, conversationId, space) => {
        if (!callConfig.apiKey || callConfig.monthlyMinutes <= 0 || !callConfig.publicUrl)
          return {
            text: 'この Genie では、まだ声で話せません（運営者が通話のキーと月の上限を設定すると使えます）。',
          };
        if (
          (await calls.usedSeconds(owner.tenantId, owner.userId)) >=
          callConfig.monthlyMinutes * 60
        )
          return {
            text: `今月の通話の上限（${String(callConfig.monthlyMinutes)} 分）に達しています。`,
          };
        const { token } = await calls.issue({
          tenantId: owner.tenantId,
          userId: owner.userId,
          linkId: owner.id,
          conversationId,
          householdId: space.householdId,
          groupId: space.groupId,
        });
        return {
          text: 'みんなで Genie と話せます（6 人まで・30 分）。買い物・TODO・家計簿・日程を声で頼めます。',
          link: {
            label: '通話に参加',
            url: `${callConfig.publicUrl}/v1/channels/call/${token}?openExternalBrowser=1`,
          },
        };
      },
      ring: async (link, conversationId, opening) => {
        if (link.provider !== 'line' || !callConfig.apiKey || callConfig.monthlyMinutes <= 0)
          return null;
        if (!callConfig.publicUrl) return null;
        if ((await calls.usedSeconds(link.tenantId, link.userId)) >= callConfig.monthlyMinutes * 60)
          return null;
        const { token } = await calls.issue({
          tenantId: link.tenantId,
          userId: link.userId,
          linkId: link.id,
          conversationId,
          opening,
        });
        return {
          text: `📞 Genie から電話です: ${opening}`.slice(0, 160),
          link: {
            label: '電話に出る',
            url: `${callConfig.publicUrl}/v1/channels/call/${token}?openExternalBrowser=1`,
          },
        };
      },
      // 公式アカウントへの LINE の電話（管理画面で受けたもの）。この Mac の中でつなぐので公開 URL は要らない
      bridge: async (link, conversationId) => {
        if (link.provider !== 'line' || !callConfig.apiKey || callConfig.monthlyMinutes <= 0)
          return null;
        if ((await calls.usedSeconds(link.tenantId, link.userId)) >= callConfig.monthlyMinutes * 60)
          return null;
        const { token } = await calls.issue({
          tenantId: link.tenantId,
          userId: link.userId,
          linkId: link.id,
          conversationId,
        });
        return token;
      },
      issue: async (link, conversationId) => {
        if (link.provider !== 'line') return { text: '通話は LINE から使えます。' };
        if (!callConfig.apiKey || callConfig.monthlyMinutes <= 0)
          return {
            text: 'この Genie では、まだ声で話せません（運営者が通話のキーと月の上限を設定すると使えます）。',
          };
        if (!callConfig.publicUrl)
          return {
            text: '通話のリンクを作れません（運営者が GENIE_PUBLIC_URL を設定すると使えます）。',
          };
        const used = await calls.usedSeconds(link.tenantId, link.userId);
        if (used >= callConfig.monthlyMinutes * 60)
          return {
            text: `今月の通話の上限（${String(callConfig.monthlyMinutes)} 分）に達しています。`,
          };
        const { token } = await calls.issue({
          tenantId: link.tenantId,
          userId: link.userId,
          linkId: link.id,
          conversationId,
        });
        // openExternalBrowser=1: LINE の中ではなく、マイクの使えるいつものブラウザで開く
        return {
          text: 'いつでも話せます。話している間に頼んだことは、声でお答えします（長くかかるものはこのトークに届きます）。',
          link: {
            label: '通話を開始',
            url: `${callConfig.publicUrl}/v1/channels/call/${token}?openExternalBrowser=1`,
          },
        };
      },
    },
    ...(deps.understand
      ? {
          understand: (principal, conversationId, input) =>
            deps.understand!.inbound(principal, conversationId, input),
        }
      : {}),
    turn: async (principal, conversationId, text) => {
      const one = (said: string) =>
        handleTurn(deps.turnDeps, {
          principal,
          conversationId,
          body: SendTurnRequest.parse({ text: said.slice(0, 8_000), modality: 'text' }),
        });
      // 一度に複数（「明日の予定教えて。あと、レシートも家計簿に」）は、分けて 1 つずつ同じ入口へ（仕様 v1.0 §1）
      const parts = splitRequests(text);
      if (parts) {
        const done = [];
        for (const part of parts) {
          const result = await one(part);
          const label = part.length > 20 ? `${part.slice(0, 19)}…` : part;
          done.push(
            result.kind === 'clarification' || result.kind === 'answered'
              ? { label, answer: result.answer.text, taskId: null, notice: null }
              : { label, answer: null, taskId: result.taskId, notice: result.notice },
          );
        }
        return { kind: 'multi', parts: done };
      }
      const result = await one(text);
      // 注文の条件を聞く途中（answered）も、チャットでは聞き返しと同じく答えの文を返す。
      if (result.kind === 'answered')
        return {
          kind: 'clarification',
          answer: result.answer.text,
          ...(result.card ? { card: result.card } : {}),
          ...(result.choices?.length ? { choices: result.choices } : {}),
        };
      return result.kind === 'clarification'
        ? { kind: 'clarification', answer: result.answer.text }
        : { kind: 'started', taskId: result.taskId, notice: result.notice, intent: result.intent };
    },
    tasks: {
      get: (tenantId, taskId) => deps.tasks.get(tenantId, taskId),
      eventsAfter: (tenantId, taskId, after) => deps.tasks.eventsAfter(tenantId, taskId, after),
      pendingApprovals: (tenantId, taskId) => deps.tasks.pendingApprovals(tenantId, taskId),
      decideApproval: (tenantId, taskId, userId, approvalId, decision) =>
        deps.tasks.decideApproval(tenantId, taskId, userId, approvalId, decision),
    },
    ...(deps.homeLink ? { homeLink: deps.homeLink } : {}),
    artifactText: (tenantId, artifactId) => readArtifactText(deps.library, tenantId, artifactId),
    artifactBody: (tenantId, artifactId) => readArtifactBody(deps.library, tenantId, artifactId),
    actionSecret,
    sealer,
    log: channelLog(deps.logger),
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
          log: channelLog(deps.logger),
        })
      : null;

  // 中継から届いた知らせは、Webhook で受けたときと同じく、保存してから受け取りを返す
  hubEvents.handle = async ({ destination, event }) => {
    const inbound = normalizeLineWebhook({ destination, events: [event] });
    for (const message of inbound.messages) await service.accept({ kind: 'message', message });
    for (const action of inbound.actions) await service.accept({ kind: 'action', action });
    for (const follow of inbound.follows) await service.accept({ kind: 'follow', follow });
  };

  const status = (): ChannelsStatus => ({
    slack: {
      configured: Boolean(slack),
      transport: slack ? (socket ? 'socket' : 'http') : null,
      socket: socket?.status() ?? null,
    },
    line: {
      configured: Boolean(line),
      transport: hub ? 'hub' : line ? 'webhook' : null,
      hub: hub?.state ?? null,
    },
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
      // 中継を通すときは Webhook の受け口を開かない（LINE の鍵を持たない）
      lineChannelSecret: line && !hub ? lineSecret : null,
      status,
      // 管理画面の LINE の電話をつなぐ道具（tools/line-call-bridge）の合言葉。受けた本文を封じる鍵から作る
      lineCallBridgeKey: line && sealKey ? lineCallBridgeKey(sealKey) : null,
      ...(hub
        ? {
            onLinkCode: async (provider: ChannelProvider, code: string, expiresAt: Date) => {
              if (provider !== 'line') return true;
              return hub.claimCode(hashLinkCode(code), expiresAt);
            },
          }
        : {}),
      ...(line
        ? {
            call: {
              config: callConfig,
              store: calls,
              log: (event: string, detail: Record<string, unknown>) =>
                deps.logger.info(detail, event),
              // 電話を切ったら、簡単な議事録を LINE のトークに残す（声は残さない）
              onEnded: (session: CallSession, record: CallRecord) => {
                void (async () => {
                  const minutes =
                    (await deps.understand
                      ?.callMinutes?.({ transcript: record.lines, requests: record.requests })
                      .catch(() => null)) ?? null;
                  const text = callMinutesText(record, minutes, new Date(), timeZone);
                  if (!text) return;
                  // 家族の通話の議事録は、そのグループへ
                  if (session.groupId) await service.postToGroupId('line', session.groupId, text);
                  else
                    await service.notifyConversation(
                      session.tenantId,
                      session.conversationId,
                      text,
                    );
                })().catch(() => undefined);
              },
              // 通話の中の頼み。LINE の会話と同じ conversation で handleTurn（Task Dock・チャットと同じ入口）
              delegate: async (session: CallSession, request: string) => {
                // 家族の通話: 頼みは共有スペース（買い物・TODO・家計簿・日程）だけ。持ち主の個人のものに触れない
                if (session.householdId) {
                  if (!deps.shared) return { status: 'not_accepted' as const };
                  const answer = await deps.shared.message(
                    {
                      tenantId: session.tenantId,
                      userId: session.userId,
                      householdId: session.householdId,
                      speaker: { id: 'family-call', name: null },
                    },
                    { text: request, images: [], mentioned: true },
                  );
                  // 通話では声で読む文だけ（カード・ボタンは通話では出せない）
                  return answer
                    ? {
                        status: 'answered' as const,
                        answer: typeof answer === 'string' ? answer : answer.text,
                      }
                    : { status: 'not_accepted' as const };
                }
                const result = await handleTurn(deps.turnDeps, {
                  principal: { tenantId: session.tenantId, userId: session.userId },
                  conversationId: session.conversationId,
                  body: SendTurnRequest.parse({ text: request.slice(0, 8_000), modality: 'voice' }),
                });
                if (result.kind === 'clarification' || result.kind === 'answered') {
                  deps.onSpoken?.(session.conversationId, result.answer.text);
                  return { status: 'answered' as const, answer: result.answer.text };
                }
                if (result.taskId) {
                  // 声で頼んだことは、声で答える。すぐ終わる仕事（読む・調べる）は終わるのを待って答えを返す。
                  // 長くかかるものは受け付けたことだけ伝え、結果は LINE のトークに届ける
                  const answer = await waitForAnswer(
                    deps.tasks,
                    deps.library,
                    session.tenantId,
                    result.taskId,
                    CALL_ANSWER_WAIT_MS,
                  );
                  if (answer) {
                    deps.onSpoken?.(session.conversationId, answer);
                    return { status: 'answered' as const, answer };
                  }
                  await service.watchTask(session.tenantId, session.conversationId, result.taskId);
                  return { status: 'accepted' as const };
                }
                return result.notice
                  ? { status: 'answered' as const, answer: result.notice }
                  : { status: 'not_accepted' as const };
              },
            },
          }
        : {}),
    },
    service,
    socket,
    start(intervalMs = 5_000) {
      if (timer) return;
      socket?.start();
      hub?.start();
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
      hub?.stop();
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

/**
 * チャネルの出来事のログ。失敗（*_failed・*_dead・*_unreadable）は warn に残す。
 * 2026-10-28: グループで「うまく受け取れませんでした」が出たのに、理由が info で、ログに残っていなかった。
 */
function channelLog(logger: {
  info: (detail: object, event: string) => void;
  warn: (detail: object, event: string) => void;
}): (event: string, detail: Record<string, unknown>) => void {
  return (event, detail) =>
    /_(?:failed|dead|unreadable)$/.test(event)
      ? logger.warn(detail, event)
      : logger.info(detail, event);
}
