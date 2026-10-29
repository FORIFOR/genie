/**
 * LINE（Messaging API の Webhook）。署名の検証と、1:1 トークの発話の取り出し。
 *
 * 1 回の配信に複数のイベントが入る。受けるのは **text と、写真・音声・動画・ファイル**。
 * 写真は ID だけ持ち、処理するときに本体を取りに行く（読めるのはいまは写真だけ。ほかは、そう答える）。
 * グループ・複数人トークの発言も受け、Genie へのメンションがあったかを付ける（読むかは service が決める）。
 * スタンプ・位置・待機（standby）中の配信は入口にしない。
 * 友だち追加（follow）は、連携のしかたを返すために受ける。
 */
import { createHmac } from 'node:crypto';
import { constantTimeEqual } from './slack.js';
import type {
  IgnoredReason,
  InboundChannelAction,
  InboundChannelFollow,
  InboundChannelMessage,
} from './message.js';

export interface LineSignatureInput {
  readonly channelSecret: string;
  /** `X-Line-Signature`（base64） */
  readonly signature: string | undefined;
  /** 受け取ったままのバイト列。JSON を読み直してから署名を計算しない。 */
  readonly rawBody: Uint8Array;
}

/** `base64(HMAC-SHA256(channelSecret, body))` と一致するか。 */
export function verifyLineSignature(input: LineSignatureInput): boolean {
  const { channelSecret, signature, rawBody } = input;
  if (!channelSecret || !signature) return false;
  const expected = createHmac('sha256', channelSecret).update(rawBody).digest('base64');
  return constantTimeEqual(expected, signature);
}

export interface LineInbound {
  readonly messages: readonly InboundChannelMessage[];
  /** ボタン（postback）。値は Genie が署名して載せたもの。押した人の照合は別に行う。 */
  readonly actions: readonly InboundChannelAction[];
  /** 友だち追加（1:1）。 */
  readonly follows: readonly InboundChannelFollow[];
  /** 受けなかったイベントと理由。黙って捨てない。 */
  readonly ignored: readonly { readonly eventId: string | null; readonly reason: IgnoredReason }[];
}

/**
 * Webhook の本文を読む。**署名を確かめてから呼ぶ。**
 *
 * `events` が空の配信（Webhook URL の検証）は、何も受けずに 200 を返せばよい。
 */
export function normalizeLineWebhook(payload: unknown): LineInbound {
  if (!isObject(payload) || !Array.isArray(payload['events'])) {
    return {
      messages: [],
      actions: [],
      follows: [],
      ignored: [{ eventId: null, reason: 'malformed' }],
    };
  }
  const destination = payload['destination'];
  if (typeof destination !== 'string') {
    return {
      messages: [],
      actions: [],
      follows: [],
      ignored: [{ eventId: null, reason: 'malformed' }],
    };
  }

  const messages: InboundChannelMessage[] = [];
  const actions: InboundChannelAction[] = [];
  const follows: InboundChannelFollow[] = [];
  const ignored: { eventId: string | null; reason: IgnoredReason }[] = [];
  for (const event of payload['events'] as unknown[]) {
    const result = normalizeEvent(destination, event);
    if ('message' in result) messages.push(result.message);
    else if ('action' in result) actions.push(result.action);
    else if ('follow' in result) follows.push(result.follow);
    else ignored.push(result);
  }
  return { messages, actions, follows, ignored };
}

function normalizeEvent(
  destination: string,
  event: unknown,
):
  | { message: InboundChannelMessage }
  | { action: InboundChannelAction }
  | { follow: InboundChannelFollow }
  | { eventId: string | null; reason: IgnoredReason } {
  if (!isObject(event)) return { eventId: null, reason: 'malformed' };
  const eventId = typeof event['webhookEventId'] === 'string' ? event['webhookEventId'] : null;
  if (!eventId) return { eventId: null, reason: 'malformed' };
  // 別のチャネル（モジュール）が応答を持っている間は、こちらは答えない
  if (event['mode'] === 'standby') return { eventId, reason: 'standby_mode' };
  if (event['type'] === 'postback') return postbackOf(destination, eventId, event);
  if (event['type'] === 'follow') return followOf(destination, eventId, event);
  if (event['type'] === 'join') return joinOf(destination, eventId, event);
  if (event['type'] === 'unsend') return unsendOf(destination, eventId, event);
  if (event['type'] !== 'message') return { eventId, reason: 'unsupported_event' };

  const source = event['source'];
  if (!isObject(source)) return { eventId, reason: 'malformed' };
  const groupId = groupOf(source);
  if (source['type'] !== 'user' && !groupId) return { eventId, reason: 'not_direct_message' };
  const userId = source['userId'];
  if (typeof userId !== 'string') return { eventId, reason: 'malformed' };

  const message = event['message'];
  if (!isObject(message)) return { eventId, reason: 'malformed' };
  const media = MEDIA_TYPES.has(String(message['type']))
    ? (message['type'] as 'image' | 'audio' | 'video' | 'file')
    : null;
  if (message['type'] !== 'text' && !media) return { eventId, reason: 'not_text' };
  let text = '';
  if (media) {
    if (typeof message['id'] !== 'string') return { eventId, reason: 'malformed' };
  } else {
    if (typeof message['text'] !== 'string') return { eventId, reason: 'malformed' };
    text = message['text'];
  }
  const mentioned = groupId ? mentionsSelf(message) : false;
  if (mentioned) text = withoutSelfMention(text, message);
  // グループでメンションだけ（「@Genie」）なら、使い方を聞かれたものとして扱う
  if (!media && text.trim().length === 0) {
    if (!mentioned) return { eventId, reason: 'empty_text' };
    text = '使い方';
  }

  const timestamp = event['timestamp'];
  const replyToken = event['replyToken'];
  return {
    message: {
      provider: 'line',
      eventId,
      workspaceId: destination,
      subject: userId,
      // 1:1 は相手ごと、グループはグループごとに 1 つの続きもの（スレッドは無い）
      destination: groupId ?? userId,
      threadKey: groupId ?? userId,
      text,
      sentAt: typeof timestamp === 'number' ? timestamp : 0,
      replyToken: typeof replyToken === 'string' ? replyToken : null,
      ...(media ? { attachments: [{ kind: media, id: message['id'] as string }] } : {}),
      ...(groupId
        ? {
            group: {
              id: groupId,
              mentioned,
              ...(typeof message['id'] === 'string' ? { messageId: message['id'] } : {}),
              ...(typeof message['quotedMessageId'] === 'string'
                ? { quotedId: message['quotedMessageId'] }
                : {}),
            },
          }
        : {}),
    },
  };
}

/**
 * グループで送信が取り消された（unsend）。覚えた文脈から外すため、本文の無いメッセージとして渡す。
 * 1:1 の取り消しは扱わない（1:1 の発言は覚えていない）。
 */
function unsendOf(
  destination: string,
  eventId: string,
  event: Record<string, unknown>,
): { message: InboundChannelMessage } | { eventId: string; reason: IgnoredReason } {
  const source = event['source'];
  const unsend = event['unsend'];
  if (!isObject(source) || !isObject(unsend)) return { eventId, reason: 'malformed' };
  const groupId = groupOf(source);
  const messageId = unsend['messageId'];
  const userId = source['userId'];
  if (!groupId || typeof messageId !== 'string') return { eventId, reason: 'unsupported_event' };
  return {
    message: {
      provider: 'line',
      eventId,
      workspaceId: destination,
      subject: typeof userId === 'string' ? userId : 'unknown',
      destination: groupId,
      threadKey: groupId,
      text: '',
      sentAt: typeof event['timestamp'] === 'number' ? event['timestamp'] : 0,
      replyToken: null,
      group: { id: groupId, mentioned: false, unsent: messageId },
    },
  };
}

/** グループ（groupId）か複数人トーク（roomId）の ID。1:1 なら null。 */
function groupOf(source: Record<string, unknown>): string | null {
  if (source['type'] === 'group' && typeof source['groupId'] === 'string') return source['groupId'];
  if (source['type'] === 'room' && typeof source['roomId'] === 'string') return source['roomId'];
  return null;
}

type Mentionee = { index: number; length: number; isSelf?: boolean; type?: string };

function mentionees(message: Record<string, unknown>): Mentionee[] {
  const mention = message['mention'];
  if (!isObject(mention) || !Array.isArray(mention['mentionees'])) return [];
  return (mention['mentionees'] as unknown[]).filter(
    (m): m is Mentionee =>
      isObject(m) && typeof m['index'] === 'number' && typeof m['length'] === 'number',
  );
}

/** Genie（この Bot）へのメンションがあるか。LINE は Bot 自身へのメンションに isSelf を付ける。 */
function mentionsSelf(message: Record<string, unknown>): boolean {
  return mentionees(message).some((m) => m.isSelf === true);
}

/** 文から Genie へのメンション（「@Genie」）を取り除く。後ろから消すので位置がずれない。 */
function withoutSelfMention(text: string, message: Record<string, unknown>): string {
  let out = text;
  for (const m of mentionees(message)
    .filter((x) => x.isSelf === true)
    .sort((a, b) => b.index - a.index)) {
    out = out.slice(0, m.index) + out.slice(m.index + m.length);
  }
  return out.replace(/\s+/g, ' ').trim();
}

/** グループ・複数人トークに招かれた。使い始め方を返すために受ける。 */
function joinOf(
  destination: string,
  eventId: string,
  event: Record<string, unknown>,
): { follow: InboundChannelFollow } | { eventId: string; reason: IgnoredReason } {
  const source = event['source'];
  const groupId = isObject(source) ? groupOf(source) : null;
  if (!groupId) return { eventId, reason: 'malformed' };
  const replyToken = event['replyToken'];
  return {
    follow: {
      provider: 'line',
      eventId,
      workspaceId: destination,
      subject: groupId,
      destination: groupId,
      threadKey: groupId,
      replyToken: typeof replyToken === 'string' ? replyToken : null,
      group: { id: groupId },
    },
  };
}

const MEDIA_TYPES = new Set(['image', 'audio', 'video', 'file']);

/** 1:1 トークのボタン（postback）。グループの中のボタンは受けない。 */
function postbackOf(
  destination: string,
  eventId: string,
  event: Record<string, unknown>,
): { action: InboundChannelAction } | { eventId: string; reason: IgnoredReason } {
  const source = event['source'];
  if (!isObject(source) || source['type'] !== 'user')
    return { eventId, reason: 'not_direct_message' };
  const userId = source['userId'];
  const postback = event['postback'];
  const data = isObject(postback) ? postback['data'] : undefined;
  if (typeof userId !== 'string' || typeof data !== 'string' || !data) {
    return { eventId, reason: 'malformed' };
  }
  const replyToken = event['replyToken'];
  return {
    action: {
      provider: 'line',
      eventId,
      workspaceId: destination,
      subject: userId,
      destination: userId,
      value: data,
      replyToken: typeof replyToken === 'string' ? replyToken : null,
    },
  };
}

/** 友だち追加。ブロック解除（`follow.isUnblocked`）でも、連携していなければ同じ案内でよい。 */
function followOf(
  destination: string,
  eventId: string,
  event: Record<string, unknown>,
): { follow: InboundChannelFollow } | { eventId: string; reason: IgnoredReason } {
  const source = event['source'];
  if (!isObject(source) || source['type'] !== 'user')
    return { eventId, reason: 'not_direct_message' };
  const userId = source['userId'];
  if (typeof userId !== 'string') return { eventId, reason: 'malformed' };
  const replyToken = event['replyToken'];
  return {
    follow: {
      provider: 'line',
      eventId,
      workspaceId: destination,
      subject: userId,
      destination: userId,
      threadKey: userId,
      replyToken: typeof replyToken === 'string' ? replyToken : null,
    },
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
