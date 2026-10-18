/**
 * @genie/service-channels
 *
 * チャット（Slack / LINE）を、Task Dock と同じ入口（`handleTurn`）に繋ぐための部品。
 * Phase 0: 署名の検証・発話の取り出し・重複の排除。**外へは何も送らない。**
 *
 * 受けてよいのは、連携済みの本人が 1:1 で書いた発話だけ。
 * 他人の発言は指示ではなく材料（正本 §6 と同じ扱い）。
 */
export {
  channelIdempotencyKey,
  type IgnoredReason,
  type InboundChannelMessage,
} from './message.js';
export {
  SLACK_SIGNATURE_WINDOW_MS,
  constantTimeEqual,
  normalizeSlackEvent,
  verifySlackSignature,
  type SlackInbound,
  type SlackSignatureInput,
} from './slack.js';
export {
  normalizeLineWebhook,
  verifyLineSignature,
  type LineInbound,
  type LineSignatureInput,
} from './line.js';
export { MemoryChannelInbox, type ChannelInbox } from './inbox.js';
