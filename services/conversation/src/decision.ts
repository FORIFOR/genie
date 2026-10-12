/**
 * Optional System-One refinement for otherwise ambiguous conversation turns.
 *
 * D-48 remains the source of truth: deterministic rules run first. This layer may
 * only refine the `chat` fallback into a read-only research task or a computer
 * task. It cannot downgrade or bypass an already-detected lane, approval policy,
 * task risk, or device-side safety check.
 */
import type { Lane, Modality } from '@genie/contracts';
import type { LaneDecision } from './lane.js';

export interface FastDecisionInput {
  readonly text: string;
  readonly modality: Modality;
  readonly baseline: LaneDecision;
}

export interface FastDecisionEngine {
  refine(input: FastDecisionInput): Promise<LaneDecision>;
}

type JevChoiceAnswer = {
  readonly type?: unknown;
  readonly choice?: unknown;
  readonly confidence?: unknown;
  readonly probabilities?: unknown;
};

interface JevDecisionEngineConfig {
  readonly apiKey: string;
  readonly endpoint?: string;
  readonly model?: string;
  readonly timeoutMs?: number;
  readonly researchConfidence?: number;
  readonly computerConfidence?: number;
  readonly fetch?: typeof globalThis.fetch;
}

const DEFAULT_ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
const DEFAULT_TIMEOUT_MS = 900;
const DEFAULT_RESEARCH_CONFIDENCE = 0.72;
const DEFAULT_COMPUTER_CONFIDENCE = 0.86;

/**
 * Jev is deliberately used only for a small, typed judgment.
 *
 * The request contains the current utterance and modality only. Screenshots,
 * Work Context, connector records, prior turns, credentials and artifacts are
 * not sent to the decision service.
 */
export class JevDecisionEngine implements FastDecisionEngine {
  readonly #config: Required<
    Pick<
      JevDecisionEngineConfig,
      'apiKey' | 'endpoint' | 'model' | 'timeoutMs' | 'researchConfidence' | 'computerConfidence'
    >
  >;
  readonly #fetch: typeof globalThis.fetch;

  constructor(config: JevDecisionEngineConfig) {
    if (!config.apiKey.trim()) throw new Error('Jev API key is required');
    this.#config = {
      apiKey: config.apiKey,
      endpoint: config.endpoint ?? DEFAULT_ENDPOINT,
      model: config.model ?? 'jev-latest',
      timeoutMs: clamp(config.timeoutMs ?? DEFAULT_TIMEOUT_MS, 100, 5_000),
      researchConfidence: probability(
        config.researchConfidence ?? DEFAULT_RESEARCH_CONFIDENCE,
        DEFAULT_RESEARCH_CONFIDENCE,
      ),
      computerConfidence: probability(
        config.computerConfidence ?? DEFAULT_COMPUTER_CONFIDENCE,
        DEFAULT_COMPUTER_CONFIDENCE,
      ),
    };
    this.#fetch = config.fetch ?? globalThis.fetch;
  }

  async refine(input: FastDecisionInput): Promise<LaneDecision> {
    // A probabilistic service never gets to overturn a deterministic rule.
    if (input.baseline.lane !== 'chat' || !input.text.trim()) return input.baseline;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#config.timeoutMs);
    try {
      const response = await this.#fetch(this.#config.endpoint, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.#config.apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          state: {
            utterance: input.text.slice(0, 4_000),
            modality: input.modality,
          },
          model: this.#config.model,
          questions: {
            route: {
              type: 'choice',
              instructions:
                'Classify only the execution shape of utterance. Choose the one path the software should take next.',
              criteria: {
                chat: 'Answer or discuss using already available context; no external lookup or GUI operation is required.',
                research:
                  'The request needs external lookup, source verification, current information, comparison, or web research.',
                computer:
                  'The request asks the assistant to operate an app, website, desktop UI, enter data, click controls, or carry out a task through the GUI.',
                clarify:
                  'There is not enough information to safely choose a target or execution path.',
              },
            },
            goal_clear: {
              type: 'noul',
              instructions:
                'Is utterance specific enough that software can identify a concrete next goal without inventing the target?',
            },
          },
        }),
        signal: controller.signal,
      });
      if (!response.ok) return input.baseline;

      const payload = (await response.json()) as {
        answers?: Record<string, unknown>;
      };
      const route = payload.answers?.['route'] as JevChoiceAnswer | undefined;
      const goal = payload.answers?.['goal_clear'] as { noul?: unknown } | undefined;
      const choice = typeof route?.choice === 'string' ? route.choice : '';
      const confidence =
        typeof route?.confidence === 'number' && Number.isFinite(route.confidence)
          ? route.confidence
          : 0;
      const goalClear =
        typeof goal?.noul === 'number' && Number.isFinite(goal.noul) ? goal.noul : 0;

      // Unclear goals stay in chat so the normal assistant can ask one precise question.
      if (goalClear < 0.62 || choice === 'clarify' || choice === 'chat') return input.baseline;

      if (choice === 'research' && confidence >= this.#config.researchConfidence) {
        return {
          lane: 'research' satisfies Lane,
          reason: `system-one refinement: research (${confidence.toFixed(2)})`,
        };
      }

      // GUI execution has a higher threshold. This only selects the task lane;
      // risk/approval is still enforced by the task planner and native helper.
      if (choice === 'computer' && confidence >= this.#config.computerConfidence) {
        return {
          lane: 'action' satisfies Lane,
          reason: `system-one refinement: computer (${confidence.toFixed(2)})`,
        };
      }
      return input.baseline;
    } catch {
      // Routing must never depend on Jev availability. Fail closed to D-48.
      return input.baseline;
    } finally {
      clearTimeout(timer);
    }
  }
}

function clamp(value: number, min: number, max: number): number {
  return Number.isFinite(value) ? Math.min(Math.max(value, min), max) : min;
}

function probability(value: number, fallback: number): number {
  return Number.isFinite(value) && value >= 0 && value <= 1 ? value : fallback;
}
