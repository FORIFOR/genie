/**
 * Slack（Events API）。署名の検証と、DM の発話の取り出し。
 *
 * 受けるのは **1:1 の DM で、人が書いた素の発話だけ**（Phase 1）。
 * チャンネル・グループ・Bot の発言・編集や削除（subtype 付き）は仕事の入口にしない。
 * 他人の発言を指示として扱わないための線引き。
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { IgnoredReason, InboundChannelMessage } from './message.js';

/** Slack が勧める許容幅。これより古い（新しい）署名は再送攻撃とみなす。 */
export const SLACK_SIGNATURE_WINDOW_MS = 5 * 60 * 1000;

export interface SlackSignatureInput {
  readonly signingSecret: string;
  /** `X-Slack-Request-Timestamp`（秒） */
  readonly timestamp: string | undefined;
  /** `X-Slack-Signature`（`v0=<hex>`） */
  readonly signature: string | undefined;
  /** 受け取ったままのバイト列。JSON を読み直してから署名を計算しない。 */
  readonly rawBody: Uint8Array;
  readonly now?: () => number;
}

/** `v0=HMAC-SHA256(signingSecret, "v0:{ts}:{body}")` を、時刻の幅と合わせて確かめる。 */
export function verifySlackSignature(input: SlackSignatureInput): boolean {
  const { signingSecret, timestamp, signature, rawBody } = input;
  if (!signingSecret || !timestamp || !signature) return false;
  if (!/^\d{1,12}$/.test(timestamp)) return false;
  const now = (input.now ?? Date.now)();
  if (Math.abs(now - Number(timestamp) * 1000) > SLACK_SIGNATURE_WINDOW_MS) return false;

  const expected =
    'v0=' +
    createHmac('sha256', signingSecret).update(`v0:${timestamp}:`).update(rawBody).digest('hex');
  return constantTimeEqual(expected, signature);
}

export type SlackInbound =
  | { readonly kind: 'url_verification'; readonly challenge: string }
  | { readonly kind: 'message'; readonly message: InboundChannelMessage }
  | { readonly kind: 'ignored'; readonly reason: IgnoredReason };

/**
 * Events API の envelope を読む。**署名を確かめてから呼ぶ。**
 *
 * 返すのは 3 通り: URL 確認への応答、受ける発話、受けない理由。
 */
export function normalizeSlackEvent(payload: unknown): SlackInbound {
  if (!isObject(payload)) return { kind: 'ignored', reason: 'malformed' };
  if (payload['type'] === 'url_verification') {
    const challenge = payload['challenge'];
    return typeof challenge === 'string' && challenge.length <= 200
      ? { kind: 'url_verification', challenge }
      : { kind: 'ignored', reason: 'malformed' };
  }
  if (payload['type'] !== 'event_callback') return { kind: 'ignored', reason: 'unsupported_event' };

  const event = payload['event'];
  const team = payload['team_id'];
  const eventId = payload['event_id'];
  const eventTime = payload['event_time'];
  if (!isObject(event) || typeof team !== 'string' || typeof eventId !== 'string') {
    return { kind: 'ignored', reason: 'malformed' };
  }
  if (event['type'] !== 'message') return { kind: 'ignored', reason: 'unsupported_event' };
  // Bot（自分の返事を含む）を拾うと、自分の発言に自分で答え続ける
  if (event['bot_id'] !== undefined || event['bot_profile'] !== undefined) {
    return { kind: 'ignored', reason: 'bot_message' };
  }
  // 編集・削除・参加などは発話ではない
  if (event['subtype'] !== undefined) return { kind: 'ignored', reason: 'subtype' };
  if (event['channel_type'] !== 'im') return { kind: 'ignored', reason: 'not_direct_message' };

  const user = event['user'];
  const channel = event['channel'];
  const ts = event['ts'];
  const text = event['text'];
  if (typeof user !== 'string' || typeof channel !== 'string' || typeof ts !== 'string') {
    return { kind: 'ignored', reason: 'malformed' };
  }
  if (typeof text !== 'string') return { kind: 'ignored', reason: 'not_text' };
  if (text.trim().length === 0) return { kind: 'ignored', reason: 'empty_text' };

  const threadTs = typeof event['thread_ts'] === 'string' ? event['thread_ts'] : null;
  return {
    kind: 'message',
    message: {
      provider: 'slack',
      eventId,
      workspaceId: team,
      subject: user,
      destination: channel,
      // スレッドの中なら、そのスレッド。外なら、この発言から新しいスレッドを始める
      threadKey: threadTs ?? ts,
      text,
      sentAt: typeof eventTime === 'number' ? eventTime * 1000 : Math.round(Number(ts) * 1000),
      replyToken: null,
    },
  };
}

/** 長さが違えば即 false。同じ長さなら比較時間が中身に依らない。 */
export function constantTimeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
