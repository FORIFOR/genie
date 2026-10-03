/**
 * @genie/service-conversation
 *
 * Conversation Engine。正本 §7。
 * 実装仕様: docs/spec/phase-7-implementation-spec.md
 */
export { routeLane, isDocumentRequest, type LaneDecision, type LaneInput } from './lane.js';
export { checkoutAssistanceRequest } from './checkout-request.js';
export { officeEditRequest, type OfficeEditRequest } from './office-request.js';
export { simulationOrderRequest } from './transaction-request.js';
export {
  clarificationFor,
  fullyResolved,
  remember,
  resolveReferences,
  type ResolutionContext,
} from './reference.js';
export { ConversationService, type AppendTurnInput, type ConversationDeps } from './service.js';
export {
  classifyCurrentInfo,
  type CurrentInfoQuery,
  type CurrentInfoWhen,
} from './current-info.js';
