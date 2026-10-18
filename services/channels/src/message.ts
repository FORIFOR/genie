/**
 * チャネルから届いた発話の、共通の形。
 *
 * Slack と LINE は届き方も ID の体系も違う。**ここから先は区別しない。**
 * 区別が要るのは「どこへ返すか」だけで、それは `destination` と `threadKey` に閉じ込める。
 */
import { createHash } from 'node:crypto';
import type { ChannelProvider } from '@genie/contracts';

export interface InboundChannelMessage {
  readonly provider: ChannelProvider;
  /**
   * 提供者が振った配信 ID（Slack の `event_id`、LINE の `webhookEventId`）。
   * **再送でも変わらない。**二重に仕事を作らないための鍵。
   */
  readonly eventId: string;
  /** 提供者側の区画。Slack は team（ワークスペース）、LINE は Bot の userId（`destination`）。 */
  readonly workspaceId: string;
  /** 話しかけた人。Slack の user ID、LINE の userId。連携（channel_links）の照合に使う。 */
  readonly subject: string;
  /** 返す先。Slack は DM の channel ID、LINE は 1:1 の相手の userId。 */
  readonly destination: string;
  /**
   * 会話の単位。Slack はスレッド（無ければその発言自体）、LINE は 1:1 なので相手ごとに 1 つ。
   * `channel_threads` で conversation_id に対応づける。
   */
  readonly threadKey: string;
  readonly text: string;
  /** 提供者が記録した送信時刻（ms）。届いた時刻ではない。 */
  readonly sentAt: number;
  /** LINE の reply token。すぐ期限が切れるので「受け付けました」にだけ使う。Slack には無い。 */
  readonly replyToken: string | null;
  /**
   * Slack のチャンネルでのメンション（Phase 3）。**結果はそこに書かず、本人の DM に返す。**
   * チャンネルには「DM でお返しします」とだけ答える。DM・LINE では無い。
   */
  readonly mention?: { readonly channel: string; readonly ts: string };
}

/**
 * ボタンを押した（Slack の block_actions、LINE の postback）。
 *
 * 値（`value`）は Genie が署名して載せたもの。**押した人が連携の本人かは、別に照合する。**
 */
export interface InboundChannelAction {
  readonly provider: ChannelProvider;
  /** 重複排除の鍵。Slack は trigger_id、LINE は webhookEventId。 */
  readonly eventId: string;
  readonly workspaceId: string;
  readonly subject: string;
  /** 返す先（Slack の DM channel、LINE の userId）。 */
  readonly destination: string;
  readonly value: string;
  readonly replyToken: string | null;
}

/** 受けなかった理由。黙って捨てずに、記録できる形で返す。 */
export type IgnoredReason =
  | 'bot_message'
  | 'subtype'
  | 'not_direct_message'
  | 'not_text'
  | 'empty_text'
  | 'unsupported_event'
  | 'standby_mode'
  | 'malformed';

/**
 * 仕事を作るときの冪等キー（`Idempotency-Key`、8〜128 文字）。
 *
 * **同じ配信は同じ鍵になる。**Slack は 3 秒で応答しないと同じ event_id で送り直し、
 * LINE も再配信する。鍵が揃えば、TaskService が二度目を同じ task として返す。
 */
export function channelIdempotencyKey(provider: ChannelProvider, eventId: string): string {
  const raw = `channel:${provider}:${eventId}`;
  if (raw.length <= 128) return raw;
  // 長すぎる ID は縮める。縮め方が決まっていれば、再送でも同じ鍵になる
  return `channel:${provider}:sha256:${createHash('sha256').update(eventId).digest('hex')}`;
}
