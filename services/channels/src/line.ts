/**
 * LINE（Messaging API の Webhook）。署名の検証と、1:1 トークの発話の取り出し。
 *
 * 1 回の配信に複数のイベントが入る。受けるのは **1:1 の text メッセージだけ**（Phase 2）。
 * グループ・複数人トーク・スタンプ・画像・待機（standby）中の配信は入口にしない。
 */
import { createHmac } from 'node:crypto';
import { constantTimeEqual } from './slack.js';
import type { IgnoredReason, InboundChannelMessage } from './message.js';

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
    return { messages: [], ignored: [{ eventId: null, reason: 'malformed' }] };
  }
  const destination = payload['destination'];
  if (typeof destination !== 'string') {
    return { messages: [], ignored: [{ eventId: null, reason: 'malformed' }] };
  }

  const messages: InboundChannelMessage[] = [];
  const ignored: { eventId: string | null; reason: IgnoredReason }[] = [];
  for (const event of payload['events'] as unknown[]) {
    const result = normalizeEvent(destination, event);
    if ('message' in result) messages.push(result.message);
    else ignored.push(result);
  }
  return { messages, ignored };
}

function normalizeEvent(
  destination: string,
  event: unknown,
): { message: InboundChannelMessage } | { eventId: string | null; reason: IgnoredReason } {
  if (!isObject(event)) return { eventId: null, reason: 'malformed' };
  const eventId = typeof event['webhookEventId'] === 'string' ? event['webhookEventId'] : null;
  if (!eventId) return { eventId: null, reason: 'malformed' };
  // 別のチャネル（モジュール）が応答を持っている間は、こちらは答えない
  if (event['mode'] === 'standby') return { eventId, reason: 'standby_mode' };
  if (event['type'] !== 'message') return { eventId, reason: 'unsupported_event' };

  const source = event['source'];
  if (!isObject(source) || source['type'] !== 'user') {
    return { eventId, reason: 'not_direct_message' };
  }
  const userId = source['userId'];
  if (typeof userId !== 'string') return { eventId, reason: 'malformed' };

  const message = event['message'];
  if (!isObject(message) || message['type'] !== 'text') return { eventId, reason: 'not_text' };
  const text = message['text'];
  if (typeof text !== 'string') return { eventId, reason: 'malformed' };
  if (text.trim().length === 0) return { eventId, reason: 'empty_text' };

  const timestamp = event['timestamp'];
  const replyToken = event['replyToken'];
  return {
    message: {
      provider: 'line',
      eventId,
      workspaceId: destination,
      subject: userId,
      destination: userId,
      // 1:1 トークにスレッドは無い。相手ごとに 1 つの続きもの
      threadKey: userId,
      text,
      sentAt: typeof timestamp === 'number' ? timestamp : 0,
      replyToken: typeof replyToken === 'string' ? replyToken : null,
    },
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
