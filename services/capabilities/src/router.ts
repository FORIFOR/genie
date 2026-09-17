import { failedEvidenceEnvelope } from './evidence.js';
import {
  defaultExecutionContext,
  type CapabilityExecutionContext,
  type CapabilityIntent,
  type CapabilityMatch,
  type CapabilityPlan,
  type EvidenceEnvelope,
  type ReachmadeCapability,
} from './protocol.js';

export interface RouteDecision {
  capability: ReachmadeCapability;
  match: CapabilityMatch;
  considered: readonly CapabilityMatch[];
}

export class CapabilityRouter {
  private readonly capabilities = new Map<string, ReachmadeCapability>();

  constructor(capabilities: readonly ReachmadeCapability[] = []) {
    for (const capability of capabilities) this.register(capability);
  }

  register(capability: ReachmadeCapability): this {
    if (this.capabilities.has(capability.id)) {
      throw new Error(`Capability already registered: ${capability.id}`);
    }
    this.capabilities.set(capability.id, capability);
    return this;
  }

  list(): readonly ReachmadeCapability[] {
    return [...this.capabilities.values()];
  }

  route(intent: CapabilityIntent): RouteDecision {
    if (!intent.id.trim() || !intent.objective.trim()) {
      throw new Error('Capability intent requires id and objective');
    }

    if (intent.preferredCapability) {
      const preferred = this.capabilities.get(intent.preferredCapability);
      if (!preferred) throw new Error(`Unknown preferred capability: ${intent.preferredCapability}`);
      const match = preferred.canHandle(intent);
      return { capability: preferred, match: { ...match, score: 1 }, considered: [match] };
    }

    const considered = [...this.capabilities.values()]
      .map((capability) => capability.canHandle(intent))
      .sort((a, b) => b.score - a.score || a.capabilityId.localeCompare(b.capabilityId));
    const best = considered[0];
    if (!best || best.score <= 0) throw new Error('No registered capability can handle this intent');
    const capability = this.capabilities.get(best.capabilityId);
    if (!capability) throw new Error(`Router selected an unregistered capability: ${best.capabilityId}`);
    return { capability, match: best, considered };
  }

  async plan(intent: CapabilityIntent): Promise<{ decision: RouteDecision; plan: CapabilityPlan }> {
    const decision = this.route(intent);
    const plan = await decision.capability.plan(intent);
    if (plan.capabilityId !== decision.capability.id || plan.intentId !== intent.id) {
      throw new Error('Capability returned a plan for a different capability or intent');
    }
    return { decision, plan };
  }

  async execute(
    intent: CapabilityIntent,
    context: CapabilityExecutionContext = defaultExecutionContext(),
  ): Promise<EvidenceEnvelope> {
    const { decision, plan } = await this.plan(intent);
    const startedAt = context.now().toISOString();
    try {
      const result = await decision.capability.execute(intent, plan, context);
      if (result.capabilityId !== decision.capability.id || result.intentId !== intent.id) {
        throw new Error('Capability returned evidence for a different capability or intent');
      }
      return result;
    } catch (error) {
      const finishedAt = context.now().toISOString();
      return failedEvidenceEnvelope({
        executionId: `${intent.id}:${decision.capability.id}`,
        intentId: intent.id,
        capabilityId: decision.capability.id,
        message: error instanceof Error ? error.message : String(error),
        source: `${decision.capability.id}:adapter`,
        startedAt,
        finishedAt,
      });
    }
  }
}
