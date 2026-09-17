/**
 * @genie/service-capabilities
 *
 * 起動時に「何が本物で、何が代役か」を答える。正本 §21・§25。
 * Reachmade Capability Protocol は、外部プロダクトを同じ契約で
 * route → plan → execute → evidence に落とす。
 */
export { capabilityReport, capabilitySummary, VERIFIED_IMPLEMENTATIONS } from './report.js';
export {
  REACHMADE_CAPABILITY_PROTOCOL,
  defaultExecutionContext,
  type ArtifactRef,
  type CapabilityEffect,
  type CapabilityExecutionContext,
  type CapabilityIntent,
  type CapabilityMatch,
  type CapabilityPlan,
  type CapabilityPlanStep,
  type CapabilityStatus,
  type EvidenceEnvelope,
  type EvidenceKind,
  type EvidenceRecord,
  type ReachmadeCapability,
} from './protocol.js';
export { assertEvidenceEnvelope, createEvidenceEnvelope, failedEvidenceEnvelope } from './evidence.js';
export { CapabilityRouter, type RouteDecision } from './router.js';
export { AgentTeamCapability } from './adapters/agent-team.js';
export { LaunchloomCapability } from './adapters/launchloom.js';
