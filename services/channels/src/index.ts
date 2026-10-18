/**
 * @genie/service-channels
 *
 * チャット（Slack / LINE）を、Task Dock と同じ入口（`handleTurn`）に繋ぐ。
 *   Phase 0: 署名の検証・発話の取り出し・重複の排除
 *   Phase 1/2: 連携（コード）・会話への対応づけ・区切りの返信（outbox）
 *   Phase 3: チャットでの承認（外への送信だけ）・Slack のメンション（結果は DM）
 *
 * 受けてよいのは、連携済みの本人の発話だけ。他人の発言は指示ではなく材料（正本 §6 と同じ扱い）。
 */
export {
  channelIdempotencyKey,
  type IgnoredReason,
  type InboundChannelAction,
  type InboundChannelMessage,
} from './message.js';
export {
  SLACK_SIGNATURE_WINDOW_MS,
  constantTimeEqual,
  normalizeSlackAction,
  normalizeSlackEvent,
  verifySlackSignature,
  type SlackActionInbound,
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
export {
  ChannelSendError,
  LineSender,
  SlackSender,
  lineMessages,
  type ChannelSender,
  type OutgoingButton,
  type OutgoingMessage,
  type SendOptions,
  type SendTarget,
} from './send.js';
export * as channelMessages from './render.js';
export type { PostingPolicy } from './render.js';
export {
  LINK_CODE_LENGTH,
  LINK_CODE_TTL_MS,
  hashLinkCode,
  linkCodeIn,
  newLinkCode,
  normalizeLinkCode,
  signApprovalAction,
  verifyApprovalAction,
  type ApprovalAction,
  type ApprovalActionCheck,
} from './tokens.js';
export {
  ChannelStore,
  MAX_SEND_ATTEMPTS,
  type ChannelLink,
  type OutboxKind,
  type OutboxRow,
  type WatchedTask,
} from './store.js';
export {
  ChannelService,
  type ChannelEvent,
  type ChannelServiceDeps,
  type ChannelTaskView,
  type TurnOutcome,
} from './service.js';
