import { execFile } from 'node:child_process';
import type { HostStep, StepOutcome } from './connector-steps.js';

export const COMPUTER_TOOLS = [
  'computer.observe',
  'computer.click',
  'computer.type',
  'computer.key',
] as const;

type ComputerTool = (typeof COMPUTER_TOOLS)[number];

export interface ComputerObservation {
  readonly app: string;
  readonly bundleId: string;
  readonly window: string;
  readonly focusedRole: string;
  readonly mouseX: number;
  readonly mouseY: number;
  readonly screens: number;
  readonly accessibilityTrusted: boolean;
}

export interface ComputerRuntimeConfig {
  readonly enabled?: boolean;
  readonly command?: string;
  readonly timeoutMs?: number;
  readonly run?: (
    command: string,
    args: readonly string[],
    timeoutMs: number,
  ) => Promise<{ code: number | null; stdout: string; stderr: string }>;
}

const DEFAULT_TIMEOUT_MS = 10_000;

function defaultRun(
  command: string,
  args: readonly string[],
  timeoutMs: number,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      command,
      [...args],
      { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout, stderr) => {
        resolve({
          code: error
            ? error.killed
              ? 124
              : typeof error.code === 'number'
                ? error.code
                : null
            : 0,
          stdout,
          stderr: (error as { code?: unknown } | null)?.code === 'ENOENT' ? 'ENOENT' : stderr,
        });
      },
    );
  });
}

/**
 * Device-side computer execution boundary.
 *
 * It is intentionally opt-in. Merely connecting an LLM never grants computer control.
 * The cloud can request a typed action, but this runtime validates the action again
 * on-device before invoking the local input helper.
 */
export class ComputerRuntime {
  readonly #config: ComputerRuntimeConfig;
  readonly #run: NonNullable<ComputerRuntimeConfig['run']>;

  constructor(config: ComputerRuntimeConfig = {}) {
    this.#config = config;
    this.#run = config.run ?? defaultRun;
  }

  handles(toolId: string): boolean {
    return Boolean(this.#config.enabled) && (COMPUTER_TOOLS as readonly string[]).includes(toolId);
  }

  async run(step: HostStep, signal?: AbortSignal): Promise<StepOutcome> {
    if (!this.handles(step.toolId)) {
      return {
        ok: false,
        error: { code: 'computer.disabled', message: '画面操作はこの端末で有効になっていません。' },
      };
    }
    if (signal?.aborted) {
      return {
        ok: false,
        error: { code: 'computer.cancelled', message: '画面操作を取り消しました。' },
      };
    }

    const tool = step.toolId as ComputerTool;
    if (tool === 'computer.observe') {
      const observation = await this.#observe();
      return observation
        ? { ok: true, result: observation }
        : {
            ok: false,
            error: { code: 'computer.observe_failed', message: '現在の画面状態を確認できませんでした。' },
          };
    }

    // Mutating actions require an approval proof from the cloud and are rechecked here.
    if (!step.approval) {
      return {
        ok: false,
        error: { code: 'approval.required', message: 'この画面操作には確認が必要です。' },
      };
    }

    const args = this.#arguments(tool, step.args);
    if (!args) {
      return {
        ok: false,
        error: { code: 'computer.invalid_action', message: '安全に実行できない画面操作です。' },
      };
    }

    const before = await this.#observe();
    const result = await this.#run(
      this.#config.command ?? 'uxin',
      args,
      this.#config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    );
    if (result.code !== 0) {
      return {
        ok: false,
        error: {
          code:
            result.code === 124
              ? 'computer.timeout'
              : result.stderr.includes('ENOENT')
                ? 'computer.unavailable'
                : 'computer.failed',
          message: result.code === 124
            ? '画面操作が時間内に完了しませんでした。'
            : result.stderr.includes('ENOENT')
              ? '画面操作ヘルパーが見つかりません。'
              : '画面操作を完了できませんでした。',
        },
      };
    }
    const after = await this.#observe();
    const changed =
      before !== null && after !== null
        ? observationKey(before) !== observationKey(after)
        : null;
    if (step.args['expectChange'] === true && changed === false) {
      return {
        ok: false,
        error: {
          code: 'computer.verification_failed',
          message: '操作後の画面状態に期待した変化を確認できませんでした。',
        },
      };
    }
    return {
      ok: true,
      result: { action: tool, applied: true, before, after, changed },
    };
  }

  async #observe(): Promise<ComputerObservation | null> {
    const result = await this.#run(
      this.#config.command ?? 'uxin',
      ['observe'],
      this.#config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    );
    if (result.code !== 0) return null;
    try {
      const value = JSON.parse(result.stdout.trim()) as Partial<ComputerObservation>;
      if (
        typeof value.app !== 'string' ||
        typeof value.bundleId !== 'string' ||
        typeof value.window !== 'string' ||
        typeof value.focusedRole !== 'string' ||
        typeof value.mouseX !== 'number' ||
        typeof value.mouseY !== 'number' ||
        typeof value.screens !== 'number' ||
        typeof value.accessibilityTrusted !== 'boolean'
      )
        return null;
      return value as ComputerObservation;
    } catch {
      return null;
    }
  }

  #arguments(tool: ComputerTool, args: Record<string, unknown>): string[] | null {
    if (tool === 'computer.click') {
      const x = numberInRange(args['x'], 0, 20_000);
      const y = numberInRange(args['y'], 0, 20_000);
      return x === null || y === null ? null : ['click', String(x), String(y)];
    }
    if (tool === 'computer.type') {
      const text = typeof args['text'] === 'string' ? args['text'] : null;
      return text && text.length <= 10_000 ? ['type', text] : null;
    }
    if (tool === 'computer.key') {
      const keycode = numberInRange(args['keycode'], 0, 255);
      if (keycode === null) return null;
      const raw = Array.isArray(args['modifiers']) ? args['modifiers'] : [];
      const modifiers = raw.filter(
        (v): v is string => typeof v === 'string' && ['opt', 'cmd', 'shift'].includes(v),
      );
      if (modifiers.length !== raw.length) return null;
      return ['key', String(keycode), ...modifiers];
    }
    return null;
  }
}

function numberInRange(value: unknown, min: number, max: number): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max
    ? Math.round(value)
    : null;
}

function observationKey(value: ComputerObservation): string {
  return JSON.stringify([
    value.bundleId,
    value.window,
    value.focusedRole,
    value.mouseX,
    value.mouseY,
  ]);
}
