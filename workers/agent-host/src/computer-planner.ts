import type { HostStep, StepOutcome } from './connector-steps.js';
import type { StepRunner } from './step-loop.js';
import type { ComputerObservation } from './computer-runtime.js';

const PLANNER_TOOL = 'computer.run';
const MAX_ACTIONS = 12;

type PlannedAction =
  | { action: 'click'; x: number; y: number; expectChange?: boolean }
  | { action: 'type'; text: string; expectChange?: boolean }
  | { action: 'key'; keycode: number; modifiers?: string[]; expectChange?: boolean }
  | { action: 'done'; reason: string }
  | { action: 'stop'; reason: string };

export interface ComputerPlannerConfig {
  readonly computer: StepRunner;
  readonly model: StepRunner;
  readonly maxActions?: number;
}

export class ComputerPlannerRuntime implements StepRunner {
  readonly #computer: StepRunner;
  readonly #model: StepRunner;
  readonly #maxActions: number;

  constructor(config: ComputerPlannerConfig) {
    this.#computer = config.computer;
    this.#model = config.model;
    this.#maxActions = Math.min(Math.max(config.maxActions ?? MAX_ACTIONS, 1), MAX_ACTIONS);
  }

  handles(toolId: string): boolean {
    return toolId === PLANNER_TOOL && this.#computer.handles('computer.observe');
  }

  async run(step: HostStep, signal?: AbortSignal): Promise<StepOutcome> {
    if (!this.handles(step.toolId))
      return {
        ok: false,
        error: {
          code: 'computer.planner_disabled',
          message: '画面操作プランナーは利用できません。',
        },
      };

    const goal = typeof step.args['goal'] === 'string' ? step.args['goal'].trim() : '';
    if (!goal)
      return {
        ok: false,
        error: { code: 'computer.invalid_goal', message: '画面操作の目的が指定されていません。' },
      };

    const history: { action: PlannedAction; outcome: unknown }[] = [];
    for (let turn = 0; turn < this.#maxActions; turn++) {
      if (signal?.aborted)
        return {
          ok: false,
          error: { code: 'computer.cancelled', message: '画面操作を取り消しました。' },
        };

      const observed = await this.#computer.run(
        { id: `${step.id}:observe:${turn}`, toolId: 'computer.observe', args: {}, approval: null },
        signal,
      );
      if (!observed.ok)
        return {
          ok: false,
          error: observed.error ?? {
            code: 'computer.observe_failed',
            message: '現在の画面を確認できませんでした。',
          },
        };

      const observation = observed.result as ComputerObservation;
      const decision = await this.#decide(step, goal, observation, history, turn, signal);
      if (!decision.ok) return decision;
      const action = decision.result as PlannedAction;

      if (action.action === 'done')
        return {
          ok: true,
          result: { goal, completed: true, reason: action.reason, actions: history, observation },
        };
      if (action.action === 'stop')
        return {
          ok: false,
          error: {
            code: 'computer.planner_stopped',
            message: action.reason || '安全に続行できません。',
          },
        };

      const toolId = `computer.${action.action}`;
      const args = actionArgs(action);
      const outcome = await this.#computer.run(
        {
          id: `${step.id}:action:${turn}`,
          toolId,
          args,
          approval: step.approval,
        },
        signal,
      );
      history.push({ action, outcome: outcome.ok ? outcome.result : outcome.error });
      if (!outcome.ok) {
        // Verification failures are useful evidence for one re-plan. Other failures stop.
        if (outcome.error?.code === 'computer.verification_failed') continue;
        return outcome;
      }
    }

    return {
      ok: false,
      error: {
        code: 'computer.action_limit',
        message: `画面操作が${this.#maxActions}回に達したため停止しました。目的を小さく分けてください。`,
      },
    };
  }

  async #decide(
    step: HostStep,
    goal: string,
    observation: ComputerObservation,
    history: readonly { action: PlannedAction; outcome: unknown }[],
    turn: number,
    signal?: AbortSignal,
  ): Promise<StepOutcome> {
    const planner = await this.#model.run(
      {
        id: `${step.id}:plan:${turn}`,
        toolId: 'llm.plan_computer_action',
        approval: null,
        args: { goal, observation, history, turn, maxActions: this.#maxActions },
      },
      signal,
    );
    if (!planner.ok) return planner;
    const action = parseAction(planner.result);
    return action
      ? { ok: true, result: action }
      : {
          ok: false,
          error: {
            code: 'computer.invalid_plan',
            message: 'AIが安全に実行できる画面操作を選べませんでした。',
          },
        };
  }
}

function actionArgs(
  action: Exclude<PlannedAction, { action: 'done' | 'stop' }>,
): Record<string, unknown> {
  if (action.action === 'click')
    return { x: action.x, y: action.y, expectChange: action.expectChange ?? true };
  if (action.action === 'type')
    return { text: action.text, expectChange: action.expectChange ?? true };
  return {
    keycode: action.keycode,
    modifiers: action.modifiers ?? [],
    expectChange: action.expectChange ?? true,
  };
}

function parseAction(value: unknown): PlannedAction | null {
  const row =
    value && typeof value === 'object' && 'action' in value
      ? (value as Record<string, unknown>)
      : value && typeof value === 'object' && 'plan' in value
        ? ((value as { plan?: unknown }).plan as Record<string, unknown>)
        : null;
  if (!row || typeof row['action'] !== 'string') return null;
  if (row['action'] === 'done' || row['action'] === 'stop')
    return {
      action: row['action'],
      reason: typeof row['reason'] === 'string' ? row['reason'].slice(0, 500) : '',
    };
  if (row['action'] === 'click' && finite(row['x']) && finite(row['y']))
    return {
      action: 'click',
      x: Number(row['x']),
      y: Number(row['y']),
      ...(typeof row['expectChange'] === 'boolean' ? { expectChange: row['expectChange'] } : {}),
    };
  if (row['action'] === 'type' && typeof row['text'] === 'string' && row['text'].length <= 10_000)
    return {
      action: 'type',
      text: row['text'],
      ...(typeof row['expectChange'] === 'boolean' ? { expectChange: row['expectChange'] } : {}),
    };
  if (row['action'] === 'key' && finite(row['keycode'])) {
    const modifiers = Array.isArray(row['modifiers']) ? row['modifiers'] : [];
    if (!modifiers.every((v) => typeof v === 'string' && ['opt', 'cmd', 'shift'].includes(v)))
      return null;
    return {
      action: 'key',
      keycode: Number(row['keycode']),
      modifiers: modifiers as string[],
      ...(typeof row['expectChange'] === 'boolean' ? { expectChange: row['expectChange'] } : {}),
    };
  }
  return null;
}

function finite(value: unknown): boolean {
  return typeof value === 'number' && Number.isFinite(value);
}
