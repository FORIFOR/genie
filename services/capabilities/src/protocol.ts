export const REACHMADE_CAPABILITY_PROTOCOL = 'reachmade.capability.v1' as const;

export type CapabilityEffect = 'read' | 'local-write' | 'external-write';
export type CapabilityStatus =
  | 'completed'
  | 'partial'
  | 'failed'
  | 'unknown'
  | 'awaiting_approval';

export interface CapabilityIntent {
  id: string;
  objective: string;
  preferredCapability?: string;
  inputs?: Readonly<Record<string, unknown>>;
  maxWaitMs?: number;
  dryRun?: boolean;
}

export interface CapabilityMatch {
  capabilityId: string;
  score: number;
  reason: string;
}

export interface CapabilityPlanStep {
  id: string;
  label: string;
  effect: CapabilityEffect;
  requiresApproval: boolean;
}

export interface CapabilityPlan {
  capabilityId: string;
  intentId: string;
  summary: string;
  steps: readonly CapabilityPlanStep[];
}

export interface ArtifactRef {
  id: string;
  title: string;
  kind: string;
  uri?: string;
  mediaType?: string;
  digest?: string;
  metadata?: Readonly<Record<string, unknown>>;
}

export type EvidenceKind =
  | 'run-state'
  | 'artifact'
  | 'hash'
  | 'operator-approval'
  | 'external-state'
  | 'source-record';

export interface EvidenceRecord {
  kind: EvidenceKind;
  claim: string;
  source: string;
  observedAt: string;
  uri?: string;
  digest?: string;
  metadata?: Readonly<Record<string, unknown>>;
}

export interface EvidenceEnvelope {
  protocol: typeof REACHMADE_CAPABILITY_PROTOCOL;
  executionId: string;
  intentId: string;
  capabilityId: string;
  status: CapabilityStatus;
  claim: string;
  artifacts: readonly ArtifactRef[];
  evidence: readonly EvidenceRecord[];
  limitations: readonly string[];
  startedAt: string;
  finishedAt: string;
}

export interface CapabilityExecutionContext {
  fetch: typeof fetch;
  now: () => Date;
  signal?: AbortSignal;
}

export interface ReachmadeCapability {
  readonly id: string;
  readonly displayName: string;
  readonly version: string;
  canHandle(intent: CapabilityIntent): CapabilityMatch;
  plan(intent: CapabilityIntent): Promise<CapabilityPlan> | CapabilityPlan;
  execute(
    intent: CapabilityIntent,
    plan: CapabilityPlan,
    context: CapabilityExecutionContext,
  ): Promise<EvidenceEnvelope>;
}

export const defaultExecutionContext = (): CapabilityExecutionContext => ({
  fetch: globalThis.fetch,
  now: () => new Date(),
});
