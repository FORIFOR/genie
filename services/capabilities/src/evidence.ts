import {
  REACHMADE_CAPABILITY_PROTOCOL,
  type ArtifactRef,
  type CapabilityStatus,
  type EvidenceEnvelope,
  type EvidenceRecord,
} from './protocol.js';

export interface EvidenceEnvelopeInput {
  executionId: string;
  intentId: string;
  capabilityId: string;
  status: CapabilityStatus;
  claim: string;
  artifacts?: readonly ArtifactRef[];
  evidence?: readonly EvidenceRecord[];
  limitations?: readonly string[];
  startedAt: string;
  finishedAt: string;
}

export function createEvidenceEnvelope(input: EvidenceEnvelopeInput): EvidenceEnvelope {
  const envelope: EvidenceEnvelope = {
    protocol: REACHMADE_CAPABILITY_PROTOCOL,
    executionId: input.executionId,
    intentId: input.intentId,
    capabilityId: input.capabilityId,
    status: input.status,
    claim: input.claim.trim(),
    artifacts: input.artifacts ?? [],
    evidence: input.evidence ?? [],
    limitations: input.limitations ?? [],
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
  };
  assertEvidenceEnvelope(envelope);
  return envelope;
}

export function assertEvidenceEnvelope(envelope: EvidenceEnvelope): void {
  if (envelope.protocol !== REACHMADE_CAPABILITY_PROTOCOL) {
    throw new Error(`Unsupported capability protocol: ${String(envelope.protocol)}`);
  }
  for (const [name, value] of [
    ['executionId', envelope.executionId],
    ['intentId', envelope.intentId],
    ['capabilityId', envelope.capabilityId],
    ['claim', envelope.claim],
    ['startedAt', envelope.startedAt],
    ['finishedAt', envelope.finishedAt],
  ] as const) {
    if (!value.trim()) throw new Error(`Evidence envelope ${name} must not be empty`);
  }
  if ((envelope.status === 'completed' || envelope.status === 'partial') && envelope.evidence.length === 0) {
    throw new Error(`${envelope.status} capability result requires evidence`);
  }
  for (const record of envelope.evidence) {
    if (!record.claim.trim() || !record.source.trim() || !record.observedAt.trim()) {
      throw new Error('Evidence records require claim, source and observedAt');
    }
  }
}

export function failedEvidenceEnvelope(args: {
  executionId: string;
  intentId: string;
  capabilityId: string;
  message: string;
  source: string;
  startedAt: string;
  finishedAt: string;
}): EvidenceEnvelope {
  return createEvidenceEnvelope({
    executionId: args.executionId,
    intentId: args.intentId,
    capabilityId: args.capabilityId,
    status: 'failed',
    claim: 'Capability execution failed; no successful outcome is claimed.',
    evidence: [
      {
        kind: 'source-record',
        claim: args.message,
        source: args.source,
        observedAt: args.finishedAt,
      },
    ],
    limitations: ['Failure evidence records the observed error only; it does not prove that no external side effect occurred.'],
    startedAt: args.startedAt,
    finishedAt: args.finishedAt,
  });
}
