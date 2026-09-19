import type { HostStep, StepOutcome } from './connector-steps.js';
import type { StepRunner } from './step-loop.js';

/**
 * Chooses the most structured execution path that is actually available on this device.
 * Vision is deliberately the final fallback, never the first choice.
 */
export class IntentExecutionRouter implements StepRunner {
  readonly #structured: StepRunner;
  readonly #computer: StepRunner;
  readonly #model: StepRunner;

  constructor(deps: { structured: StepRunner; computer: StepRunner; model: StepRunner }) {
    this.#structured = deps.structured;
    this.#computer = deps.computer;
    this.#model = deps.model;
  }

  handles(toolId: string): boolean {
    return toolId === 'intent.execute';
  }

  async run(step: HostStep, signal?: AbortSignal): Promise<StepOutcome> {
    const goal = stringArg(step.args, 'goal');
    if (!goal) {
      return fail('intent.invalid_goal', '実行する目的が指定されていません。');
    }

    const route = await this.#route(step, goal, signal);
    if (!route.ok) return route;
    const decision = parseDecision(route.result);
    if (!decision) {
      return fail('intent.invalid_route', '安全に実行経路を決められませんでした。');
    }

    if (decision.kind === 'answer') {
      return this.#model.run(
        {
          id: `${step.id}:answer`,
          toolId: 'general.answer',
          args: { question: goal, context: decision.context ?? '' },
          approval: null,
        },
        signal,
      );
    }

    if (decision.kind === 'computer') {
      if (!this.#computer.handles('computer.run')) {
        return fail('intent.computer_unavailable', 'この端末では画面操作を利用できません。');
      }
      return this.#computer.run(
        {
          id: `${step.id}:computer`,
          toolId: 'computer.run',
          args: {
            goal,
            successCriteria: decision.successCriteria ?? goal,
          },
          approval: step.approval,
        },
        signal,
      );
    }

    if (!this.#structured.handles(decision.toolId)) {
      // Do not silently fall back from a named structured action to pixels.
      return fail(
        'intent.structured_unavailable',
        '必要な接続がこの端末で利用できません。接続を確認してください。',
      );
    }
    const outcome = await this.#structured.run(
      {
        id: `${step.id}:structured`,
        toolId: decision.toolId,
        args: decision.args,
        approval: step.approval,
      },
      signal,
    );
    if (!outcome.ok) return outcome;

    const verification = await this.#verifyStructured(
      step,
      goal,
      decision,
      outcome.result,
      signal,
    );
    return verification.ok
      ? {
          ok: true,
          result: {
            route: 'structured',
            toolId: decision.toolId,
            result: outcome.result,
            verification: verification.result,
          },
        }
      : verification;
  }

  async #route(step: HostStep, goal: string, signal?: AbortSignal): Promise<StepOutcome> {
    return this.#model.run(
      {
        id: `${step.id}:route`,
        toolId: 'llm.route_execution',
        approval: null,
        args: {
          goal,
          availableStructuredTools: [
            'mail.send',
            'outlook.mail.reply',
            'calendar.create',
            'outlook.calendar.create',
            'todo.create',
          ].filter((toolId) => this.#structured.handles(toolId)),
          computerAvailable: this.#computer.handles('computer.run'),
        },
      },
      signal,
    );
  }

  async #verifyStructured(
    step: HostStep,
    goal: string,
    decision: StructuredDecision,
    result: unknown,
    signal?: AbortSignal,
  ): Promise<StepOutcome> {
    // Provider/API result is stronger evidence than a screenshot. The verifier is
    // intentionally unable to execute more tools; it only judges returned evidence.
    const judged = await this.#model.run(
      {
        id: `${step.id}:verify`,
        toolId: 'llm.verify_execution_result',
        approval: null,
        args: { goal, toolId: decision.toolId, requested: decision.args, result },
      },
      signal,
    );
    if (!judged.ok) return judged;
    const row = object(judged.result);
    if (row?.['verified'] !== true) {
      return fail(
        'intent.verification_failed',
        typeof row?.['reason'] === 'string'
          ? row['reason']
          : '実行結果を確認できなかったため、完了扱いにしませんでした。',
      );
    }
    return { ok: true, result: row };
  }
}

type StructuredDecision = {
  kind: 'structured';
  toolId: string;
  args: Record<string, unknown>;
};
type RouteDecision =
  | StructuredDecision
  | { kind: 'computer'; successCriteria?: string }
  | { kind: 'answer'; context?: string };

function parseDecision(value: unknown): RouteDecision | null {
  const row = object(value);
  if (!row || typeof row['kind'] !== 'string') return null;
  if (row['kind'] === 'answer') {
    return {
      kind: 'answer',
      ...(typeof row['context'] === 'string' ? { context: row['context'] } : {}),
    };
  }
  if (row['kind'] === 'computer') {
    return {
      kind: 'computer',
      ...(typeof row['successCriteria'] === 'string'
        ? { successCriteria: row['successCriteria'] }
        : {}),
    };
  }
  if (
    row['kind'] === 'structured' &&
    typeof row['toolId'] === 'string' &&
    object(row['args'])
  ) {
    return { kind: 'structured', toolId: row['toolId'], args: object(row['args'])! };
  }
  return null;
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringArg(args: Record<string, unknown>, key: string): string {
  return typeof args[key] === 'string' ? args[key].trim() : '';
}

function fail(code: string, message: string): StepOutcome {
  return { ok: false, error: { code, message } };
}
