export {
  OathraError,
  checkedOrigin,
  oathraClient,
  phoneSetupFromEnv,
  readConnectionFile,
  type OathraCallResult,
  type OathraClient,
  type OathraConnection,
  type OathraInboundCall,
  type OathraInboundPage,
  type OathraOutcome,
  type OathraPhoneRequest,
  type OathraSalesContext,
  type OathraSalesRequest,
  type OathraUtterance,
  type PhoneOwner,
  type PhoneSetup,
  type SalesGoal,
} from './oathra.js';
export {
  phoneIntentOf,
  salesGoalOf,
  salesTargetOf,
  type PhoneIntent,
  type SalesTarget,
} from './intent.js';
export {
  PhoneUnavailableError,
  operationKeyFor,
  phoneExecutors,
  type PhoneExecutorDeps,
  type PhoneExecutorResult,
} from './executor.js';
export {
  InboundPhoneSync,
  callerWords,
  type InboundPhoneSyncDeps,
  type InboundSyncResult,
  type InboundTaskRequest,
  type InboundTaskSink,
} from './inbound.js';
export { phoneTaskFor, type PhoneTaskDecision } from './request.js';
