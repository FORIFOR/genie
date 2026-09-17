import { createEvidenceEnvelope } from '../evidence.js';
import type {
  ArtifactRef,
  CapabilityExecutionContext,
  CapabilityIntent,
  CapabilityMatch,
  CapabilityPlan,
  EvidenceEnvelope,
  EvidenceRecord,
  ReachmadeCapability,
} from '../protocol.js';
import { jsonRequest, normalizeBaseUrl, wait } from './http.js';

interface AgentTeamOptions {
  baseUrl: string;
  allowRemote?: boolean;
  headers?: Readonly<Record<string, string>>;
  pollIntervalMs?: number;
  defaultMaxWaitMs?: number;
}

interface AgentTeamRun {
  run_id: string;
  status: string;
  artifacts?: unknown[];
  artifact_selection?: Readonly<Record<string, unknown>>;
  problems?: unknown[];
  [key: string]: unknown;
}

const terminal = new Set(['completed', 'partial', 'failed', 'cancelled', 'interrupted', 'blocked', 'approval_required']);
const successLike = new Set(['completed', 'partial']);
const keywords = /\b(review|revise|research|implement|implementation|code|draft|artifact|investigate|compare)\b|レビュー|修正|調査|実装|コード|成果物|比較/i;

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function artifactRefs(run: AgentTeamRun): ArtifactRef[] {
  if (!Array.isArray(run.artifacts)) return [];
  return run.artifacts.map((value, index) => {
    const item = value && typeof value === 'object' ? value as Record<string, unknown> : {};
    const id = asString(item['artifact_id']) ?? `artifact-${index + 1}`;
    const revision = typeof item['revision'] === 'number' ? item['revision'] : undefined;
    const digest = asString(item['sha256']);
    const title = asString(item['path']) ?? asString(item['name']) ?? id;
    const ref: ArtifactRef = { id, title, kind: 'agent-team-artifact' };
    if (digest) ref.digest = `sha256:${digest}`;
    if (revision !== undefined) ref.metadata = { revision };
    return ref;
  });
}

export class AgentTeamCapability implements ReachmadeCapability {
  readonly id = 'agent-team';
  readonly displayName = 'Agent Team';
  readonly version = '1';
  private readonly baseUrl: string;
  private readonly headers: Readonly<Record<string, string>>;
  private readonly pollIntervalMs: number;
  private readonly defaultMaxWaitMs: number;

  constructor(options: AgentTeamOptions) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl, options.allowRemote ?? false);
    this.headers = options.headers ?? {};
    this.pollIntervalMs = options.pollIntervalMs ?? 1000;
    this.defaultMaxWaitMs = options.defaultMaxWaitMs ?? 30 * 60_000;
  }

  canHandle(intent: CapabilityIntent): CapabilityMatch {
    const explicit = intent.preferredCapability === this.id;
    const teamHint = intent.inputs?.['team'] === true || intent.inputs?.['multiAgent'] === true;
    const score = explicit ? 1 : teamHint ? 0.96 : keywords.test(intent.objective) ? 0.78 : 0.08;
    return {
      capabilityId: this.id,
      score,
      reason: explicit ? 'Explicitly requested Agent Team' : teamHint ? 'Multi-agent work requested' : score > 0.1 ? 'Objective matches draft/review/research work' : 'Weak match',
    };
  }

  plan(intent: CapabilityIntent): CapabilityPlan {
    return {
      capabilityId: this.id,
      intentId: intent.id,
      summary: 'Create an Agent Team run, wait for its recorded terminal state, then collect immutable artifacts and run evidence.',
      steps: [
        { id: 'create-run', label: 'Create Agent Team run', effect: 'local-write', requiresApproval: false },
        { id: 'execute-run', label: 'Execute the planned multi-agent work', effect: 'local-write', requiresApproval: false },
        { id: 'collect-evidence', label: 'Read run state and artifact manifests', effect: 'read', requiresApproval: false },
      ],
    };
  }

  async execute(intent: CapabilityIntent, plan: CapabilityPlan, context: CapabilityExecutionContext): Promise<EvidenceEnvelope> {
    const startedAt = context.now().toISOString();
    if (intent.dryRun) {
      const finishedAt = context.now().toISOString();
      return createEvidenceEnvelope({
        executionId: `${intent.id}:agent-team:dry-run`,
        intentId: intent.id,
        capabilityId: this.id,
        status: 'awaiting_approval',
        claim: 'Agent Team was selected and planned, but execution was not started because dryRun=true.',
        evidence: [{ kind: 'source-record', claim: plan.summary, source: 'genie:capability-router', observedAt: finishedAt }],
        limitations: ['No Agent Team run exists for this dry run.'],
        startedAt,
        finishedAt,
      });
    }

    const createBody: Record<string, unknown> = { goal: intent.objective, start: true };
    const budget = intent.inputs?.['budgetUsd'];
    if (typeof budget === 'number' && Number.isFinite(budget) && budget > 0) createBody['budget_usd'] = budget;

    const created = await jsonRequest<AgentTeamRun>(context, `${this.baseUrl}/api/runs`, {
      method: 'POST',
      body: JSON.stringify(createBody),
    }, this.headers);
    const runId = asString(created.run_id);
    if (!runId) throw new Error('Agent Team did not return a run_id');

    const deadline = Date.now() + (intent.maxWaitMs ?? this.defaultMaxWaitMs);
    let run = created;
    while (!terminal.has(run.status)) {
      if (Date.now() >= deadline) {
        const finishedAt = context.now().toISOString();
        return createEvidenceEnvelope({
          executionId: runId,
          intentId: intent.id,
          capabilityId: this.id,
          status: 'unknown',
          claim: 'Agent Team had not reached a terminal state before the Genie wait deadline.',
          evidence: [{ kind: 'run-state', claim: `Observed run status: ${run.status}`, source: 'agent-team', observedAt: finishedAt, uri: `${this.baseUrl}/api/runs/${encodeURIComponent(runId)}` }],
          limitations: ['Timeout does not prove whether the Agent Team run later completed or produced side effects.'],
          startedAt,
          finishedAt,
        });
      }
      await wait(this.pollIntervalMs, context.signal);
      run = await jsonRequest<AgentTeamRun>(context, `${this.baseUrl}/api/runs/${encodeURIComponent(runId)}`, { method: 'GET' }, this.headers);
    }

    if (!run.artifacts) {
      run = await jsonRequest<AgentTeamRun>(context, `${this.baseUrl}/api/runs/${encodeURIComponent(runId)}`, { method: 'GET' }, this.headers);
    }
    const artifacts = artifactRefs(run);
    const finishedAt = context.now().toISOString();
    const evidence: EvidenceRecord[] = [{
      kind: 'run-state',
      claim: `Agent Team reported terminal status: ${run.status}`,
      source: 'agent-team',
      observedAt: finishedAt,
      uri: `${this.baseUrl}/api/runs/${encodeURIComponent(runId)}`,
      metadata: { runId },
    }];
    for (const artifact of artifacts) {
      evidence.push({
        kind: artifact.digest ? 'hash' : 'artifact',
        claim: `Agent Team recorded artifact ${artifact.title}`,
        source: 'agent-team',
        observedAt: finishedAt,
        ...(artifact.digest ? { digest: artifact.digest } : {}),
        metadata: { artifactId: artifact.id, ...(artifact.metadata ?? {}) },
      });
    }

    const mappedStatus = run.status === 'completed' ? 'completed' : run.status === 'partial' ? 'partial' : run.status === 'approval_required' ? 'awaiting_approval' : 'failed';
    return createEvidenceEnvelope({
      executionId: runId,
      intentId: intent.id,
      capabilityId: this.id,
      status: mappedStatus,
      claim: successLike.has(run.status)
        ? `Agent Team finished with status ${run.status}; ${artifacts.length} artifact record(s) were returned.`
        : `Agent Team stopped with status ${run.status}; no successful completion is claimed.`,
      artifacts,
      evidence,
      limitations: [
        'The envelope proves what Agent Team recorded, not independent correctness of artifact contents.',
        'Human artifact adoption remains a separate Agent Team event when required.',
      ],
      startedAt,
      finishedAt,
    });
  }
}
