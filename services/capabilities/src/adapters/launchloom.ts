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

interface LaunchloomOptions {
  baseUrl: string;
  token?: string;
  allowRemote?: boolean;
  pollIntervalMs?: number;
  defaultMaxWaitMs?: number;
}

interface CampaignState {
  id?: string;
  state?: string;
  stage?: string;
  progress?: number;
  outputs?: Readonly<Record<string, unknown>>;
  error?: unknown;
  [key: string]: unknown;
}

const keywords = /\b(launch|landing page|social draft|social post|film|video|reel|campaign|publish material|marketing asset)\b|ローンチ|公開素材|動画|縦動画|LP|投稿案|キャンペーン/i;
const terminal = new Set(['ready', 'awaiting_review', 'failed', 'interrupted']);

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function safeBuildOptions(intent: CapabilityIntent): Record<string, unknown> {
  const requested = record(intent.inputs?.['buildOptions']) ?? {};
  const captureMode = stringValue(requested['capture_mode']) ?? 'none';
  if (!['none', 'sample'].includes(captureMode)) {
    throw new Error('Genie Launchloom adapter currently permits only capture_mode=none or sample; import/URL capture must be prepared in Launchloom directly.');
  }
  if (requested['film_provider'] !== undefined && requested['film_provider'] !== 'local') {
    throw new Error('Genie does not start paid/external Launchloom film providers.');
  }
  if (requested['llm_plan'] === true || requested['allow_site_writes'] === true) {
    throw new Error('Genie does not enable Launchloom LLM planning or site writes through this adapter.');
  }
  return {
    capture_mode: captureMode,
    film_provider: 'local',
    llm_plan: false,
    allow_site_writes: false,
    external_data_consent: false,
    review_plan: requested['review_plan'] !== false,
    quality: requested['quality'] === 'draft' ? 'draft' : 'hd',
    visual_style: ['editorial', 'spotlight', 'grid'].includes(String(requested['visual_style'])) ? requested['visual_style'] : 'editorial',
  };
}

function outputArtifacts(campaign: CampaignState, baseUrl: string): ArtifactRef[] {
  if (!campaign.outputs) return [];
  const artifacts: ArtifactRef[] = [];
  for (const [name, value] of Object.entries(campaign.outputs)) {
    const path = stringValue(value);
    if (!path) continue;
    const uri = new URL(path, `${baseUrl}/`).href;
    artifacts.push({ id: name, title: name, kind: 'launchloom-output', uri });
  }
  return artifacts;
}

export class LaunchloomCapability implements ReachmadeCapability {
  readonly id = 'launchloom';
  readonly displayName = 'Launchloom';
  readonly version = '1';
  private readonly baseUrl: string;
  private readonly headers: Readonly<Record<string, string>>;
  private readonly pollIntervalMs: number;
  private readonly defaultMaxWaitMs: number;

  constructor(options: LaunchloomOptions) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl, options.allowRemote ?? false);
    this.headers = options.token ? { authorization: `Bearer ${options.token}` } : {};
    this.pollIntervalMs = options.pollIntervalMs ?? 1500;
    this.defaultMaxWaitMs = options.defaultMaxWaitMs ?? 60 * 60_000;
  }

  canHandle(intent: CapabilityIntent): CapabilityMatch {
    const explicit = intent.preferredCapability === this.id;
    const launchHint = intent.inputs?.['launch'] === true || intent.inputs?.['campaignId'] !== undefined || intent.inputs?.['brief'] !== undefined;
    const score = explicit ? 1 : launchHint ? 0.98 : keywords.test(intent.objective) ? 0.9 : 0.04;
    return {
      capabilityId: this.id,
      score,
      reason: explicit ? 'Explicitly requested Launchloom' : launchHint ? 'Launch campaign input was supplied' : score > 0.1 ? 'Objective asks for launch assets' : 'Weak match',
    };
  }

  plan(intent: CapabilityIntent): CapabilityPlan {
    const hasCampaign = typeof intent.inputs?.['campaignId'] === 'string';
    return {
      capabilityId: this.id,
      intentId: intent.id,
      summary: `${hasCampaign ? 'Use the existing' : 'Create a'} Launchloom campaign, build local pre-publish assets, and stop at review when operator approval is required.`,
      steps: [
        ...(hasCampaign ? [] : [{ id: 'create-campaign', label: 'Create Launchloom campaign from an explicit brief', effect: 'local-write' as const, requiresApproval: false }]),
        { id: 'build-kit', label: 'Build local launch material', effect: 'local-write', requiresApproval: false },
        { id: 'review-gate', label: 'Stop for storyboard review unless explicitly approved', effect: 'read', requiresApproval: true },
        { id: 'collect-outputs', label: 'Collect generated output references', effect: 'read', requiresApproval: false },
      ],
    };
  }

  async execute(intent: CapabilityIntent, plan: CapabilityPlan, context: CapabilityExecutionContext): Promise<EvidenceEnvelope> {
    const startedAt = context.now().toISOString();
    const existingCampaignId = stringValue(intent.inputs?.['campaignId']);
    const brief = record(intent.inputs?.['brief']);
    if (!existingCampaignId && !brief) throw new Error('Launchloom needs inputs.campaignId or an explicit inputs.brief object.');

    if (intent.dryRun) {
      const finishedAt = context.now().toISOString();
      return createEvidenceEnvelope({
        executionId: `${intent.id}:launchloom:dry-run`,
        intentId: intent.id,
        capabilityId: this.id,
        status: 'awaiting_approval',
        claim: 'Launchloom was selected and planned, but no campaign was changed because dryRun=true.',
        evidence: [{ kind: 'source-record', claim: plan.summary, source: 'genie:capability-router', observedAt: finishedAt }],
        limitations: ['No launch assets were generated.'],
        startedAt,
        finishedAt,
      });
    }

    let campaignId = existingCampaignId;
    if (!campaignId) {
      const created = await jsonRequest<CampaignState>(context, `${this.baseUrl}/api/campaigns`, {
        method: 'POST',
        body: JSON.stringify(brief),
      }, this.headers);
      campaignId = stringValue(created.id);
      if (!campaignId) throw new Error('Launchloom did not return a campaign id');
    }

    const buildOptions = safeBuildOptions(intent);
    await jsonRequest<CampaignState>(context, `${this.baseUrl}/api/campaigns/${encodeURIComponent(campaignId)}/build`, {
      method: 'POST',
      body: JSON.stringify(buildOptions),
    }, this.headers);

    const deadline = Date.now() + (intent.maxWaitMs ?? this.defaultMaxWaitMs);
    let campaign: CampaignState = { id: campaignId, state: 'building' };
    let renderApproved = intent.inputs?.['approvePlan'] === true;
    while (true) {
      campaign = await jsonRequest<CampaignState>(context, `${this.baseUrl}/api/campaigns/${encodeURIComponent(campaignId)}`, { method: 'GET' }, this.headers);
      const state = stringValue(campaign.state) ?? 'unknown';
      if (state === 'awaiting_review' && renderApproved) {
        await jsonRequest<CampaignState>(context, `${this.baseUrl}/api/campaigns/${encodeURIComponent(campaignId)}/render`, { method: 'POST' }, this.headers);
        renderApproved = false;
      } else if (terminal.has(state)) {
        break;
      }
      if (Date.now() >= deadline) {
        const finishedAt = context.now().toISOString();
        return createEvidenceEnvelope({
          executionId: campaignId,
          intentId: intent.id,
          capabilityId: this.id,
          status: 'unknown',
          claim: 'Launchloom had not reached a review or terminal state before the Genie wait deadline.',
          evidence: [{ kind: 'run-state', claim: `Observed campaign state: ${state}`, source: 'launchloom', observedAt: finishedAt, uri: `${this.baseUrl}/api/campaigns/${encodeURIComponent(campaignId)}` }],
          limitations: ['Timeout does not prove whether rendering later completed. No live social submission was attempted by this adapter.'],
          startedAt,
          finishedAt,
        });
      }
      await wait(this.pollIntervalMs, context.signal);
    }

    const state = stringValue(campaign.state) ?? 'unknown';
    const finishedAt = context.now().toISOString();
    const artifacts = outputArtifacts(campaign, this.baseUrl);
    const evidence: EvidenceRecord[] = [{
      kind: 'run-state',
      claim: `Launchloom reported campaign state: ${state}`,
      source: 'launchloom',
      observedAt: finishedAt,
      uri: `${this.baseUrl}/api/campaigns/${encodeURIComponent(campaignId)}`,
      metadata: { campaignId, stage: campaign.stage ?? null, progress: campaign.progress ?? null },
    }];
    for (const artifact of artifacts) {
      evidence.push({ kind: 'artifact', claim: `Launchloom exposed output ${artifact.title}`, source: 'launchloom', observedAt: finishedAt, ...(artifact.uri ? { uri: artifact.uri } : {}) });
    }

    if (state === 'awaiting_review') {
      return createEvidenceEnvelope({
        executionId: campaignId,
        intentId: intent.id,
        capabilityId: this.id,
        status: 'awaiting_approval',
        claim: 'Launchloom reached its storyboard review gate; rendering was not approved automatically.',
        artifacts,
        evidence,
        limitations: ['Nothing is claimed as a finished launch kit until Launchloom reports ready.', 'This adapter never releases or submits social posts.'],
        startedAt,
        finishedAt,
      });
    }

    const status = state === 'ready' ? 'completed' : 'failed';
    return createEvidenceEnvelope({
      executionId: campaignId,
      intentId: intent.id,
      capabilityId: this.id,
      status,
      claim: state === 'ready'
        ? `Launchloom produced ${artifacts.length} recorded output reference(s) and reported the campaign ready.`
        : `Launchloom stopped with state ${state}; no finished launch kit is claimed.`,
      artifacts,
      evidence,
      limitations: ['Generated assets are pre-publish material. This adapter never calls release, approve-publication or submit endpoints.', 'Output presence does not prove a real social post or conversion occurred.'],
      startedAt,
      finishedAt,
    });
  }
}
