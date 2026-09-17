import { createEvidenceEnvelope } from './evidence.js';
import {
  defaultExecutionContext,
  type ArtifactRef,
  type CapabilityExecutionContext,
  type CapabilityIntent,
  type CapabilityStatus,
  type EvidenceEnvelope,
  type EvidenceRecord,
} from './protocol.js';
import { CapabilityRouter } from './router.js';

export interface CapabilityWorkflowStep {
  id: string;
  capabilityId: string;
  inputs?: Readonly<Record<string, unknown>>;
  dryRun?: boolean;
}

export interface CapabilityWorkflowRequest {
  id: string;
  objective: string;
  inputs?: Readonly<Record<string, unknown>>;
  steps: readonly CapabilityWorkflowStep[];
  maxWaitMs?: number;
}

export interface CapabilityWorkflowResult {
  workflowId: string;
  status: CapabilityStatus;
  steps: readonly EvidenceEnvelope[];
  envelope: EvidenceEnvelope;
}

function workflowStatus(results: readonly EvidenceEnvelope[]): CapabilityStatus {
  if (results.length === 0) return 'failed';
  if (results.some((result) => result.status === 'failed')) return 'failed';
  if (results.some((result) => result.status === 'unknown')) return 'unknown';
  if (results.some((result) => result.status === 'awaiting_approval')) return 'awaiting_approval';
  if (results.some((result) => result.status === 'partial')) return 'partial';
  return 'completed';
}

function handoff(result: EvidenceEnvelope): Readonly<Record<string, unknown>> {
  return {
    executionId: result.executionId,
    capabilityId: result.capabilityId,
    status: result.status,
    claim: result.claim,
    artifacts: result.artifacts.map((artifact) => ({
      id: artifact.id,
      title: artifact.title,
      kind: artifact.kind,
      ...(artifact.uri ? { uri: artifact.uri } : {}),
      ...(artifact.digest ? { digest: artifact.digest } : {}),
    })),
    evidence: result.evidence.map((record) => ({
      kind: record.kind,
      claim: record.claim,
      source: record.source,
      ...(record.uri ? { uri: record.uri } : {}),
      ...(record.digest ? { digest: record.digest } : {}),
    })),
    limitations: [...result.limitations],
  };
}

export class CapabilityWorkflowRunner {
  constructor(private readonly router: CapabilityRouter) {}

  async execute(
    workflow: CapabilityWorkflowRequest,
    context: CapabilityExecutionContext = defaultExecutionContext(),
  ): Promise<CapabilityWorkflowResult> {
    if (!workflow.id.trim() || !workflow.objective.trim()) throw new Error('Workflow requires id and objective');
    if (workflow.steps.length === 0) throw new Error('Workflow requires at least one capability step');
    const seen = new Set<string>();
    for (const step of workflow.steps) {
      if (!step.id.trim() || !step.capabilityId.trim()) throw new Error('Workflow steps require id and capabilityId');
      if (seen.has(step.id)) throw new Error(`Duplicate workflow step id: ${step.id}`);
      seen.add(step.id);
    }

    const startedAt = context.now().toISOString();
    const results: EvidenceEnvelope[] = [];
    for (const step of workflow.steps) {
      const previous = results.at(-1);
      // Do not silently continue from an ambiguous or approval-blocked state.
      if (previous && !['completed', 'partial'].includes(previous.status)) break;
      const upstreamEvidence = previous ? handoff(previous) : undefined;
      const inputs: Record<string, unknown> = {
        ...(workflow.inputs ?? {}),
        ...(step.inputs ?? {}),
      };
      if (upstreamEvidence) inputs['upstreamEvidence'] = upstreamEvidence;
      const intent: CapabilityIntent = {
        id: `${workflow.id}:${step.id}`,
        objective: workflow.objective,
        preferredCapability: step.capabilityId,
        inputs,
        ...(workflow.maxWaitMs === undefined ? {} : { maxWaitMs: workflow.maxWaitMs }),
        ...(step.dryRun === undefined ? {} : { dryRun: step.dryRun }),
      };
      results.push(await this.router.execute(intent, context));
    }

    const finishedAt = context.now().toISOString();
    const status = workflowStatus(results);
    const artifacts: ArtifactRef[] = results.flatMap((result) => result.artifacts.map((artifact) => ({
      ...artifact,
      id: `${result.capabilityId}:${artifact.id}`,
      metadata: { ...(artifact.metadata ?? {}), capabilityId: result.capabilityId, executionId: result.executionId },
    })));
    const evidence: EvidenceRecord[] = results.flatMap((result) => result.evidence.map((record) => ({
      ...record,
      metadata: { ...(record.metadata ?? {}), capabilityId: result.capabilityId, executionId: result.executionId },
    })));
    if (evidence.length === 0) {
      evidence.push({
        kind: 'source-record',
        claim: 'No capability step produced evidence.',
        source: 'genie:reachmade-workflow',
        observedAt: finishedAt,
      });
    }
    const completedIds = results.map((result) => result.capabilityId).join(' → ');
    const envelope = createEvidenceEnvelope({
      executionId: workflow.id,
      intentId: workflow.id,
      capabilityId: 'reachmade-workflow',
      status,
      claim: completedIds
        ? `Reachmade workflow observed ${results.length}/${workflow.steps.length} step(s): ${completedIds}. Final status: ${status}.`
        : 'Reachmade workflow executed no capability steps.',
      artifacts,
      evidence,
      limitations: [
        'Each capability owns its own completion semantics; the workflow only aggregates recorded evidence.',
        'A later step is not started after failed, unknown or awaiting-approval evidence from the previous step.',
      ],
      startedAt,
      finishedAt,
    });
    return { workflowId: workflow.id, status, steps: results, envelope };
  }
}
