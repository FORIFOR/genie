import { createHash } from 'node:crypto';
import {
  VisionFailure,
  assertScope,
  decisionOf,
  frameOf,
  requireApproval,
  verdictOf,
  type VisionFrame,
  type GroundedAction,
} from './computer-vision-policy.js';

// Structural types keep the loop independent of providers, native UI, and the cloud.
export interface VisionStep {
  id: string;
  toolId: string;
  args: Record<string, unknown>;
  approval: unknown;
}
export interface VisionOutcome {
  ok: boolean;
  result?: unknown;
  error?: { code: string; message: string };
}
export interface VisionModel {
  run(
    step: Omit<VisionStep, 'approval'> & { approval: null },
    signal?: AbortSignal,
  ): Promise<VisionOutcome>;
}
export interface VisionDevice {
  /** Must atomically refuse a previously started request, including after a host restart. */
  claim(requestId: string): Promise<void>;
  /** Local consent precedes capture/egress. The selected window becomes the immutable scope. */
  begin(goal: string, recipient: string, signal: AbortSignal): Promise<VisionFrame>;
  capture(scope: VisionFrame, signal: AbortSignal): Promise<VisionFrame>;
  /** Freshness, window and local per-action approval are rechecked natively before input. */
  apply(
    frame: VisionFrame,
    action: GroundedAction,
    signal: AbortSignal,
    expiresAt: number,
  ): Promise<void>;
  close(): Promise<void>;
}
export interface VisionConfig {
  enabled: boolean;
  model: VisionModel;
  selectModel: () => Promise<string | null>;
  allowExternalPixels: boolean;
  device: () => VisionDevice;
  maxActions?: number;
  timeoutMs?: number;
  now?: () => number;
}
interface AuditRow {
  sequence: number;
  event: string;
  before: string;
  after?: string;
  verified?: boolean;
}
const TOOLS = { plan: 'llm.plan_computer_action', verify: 'llm.verify_computer_action' };

/** No metadata-only fallback. Neither model `done` nor a changed pointer proves success. */
export class ComputerVisionRuntime {
  #busy = false;
  readonly #max: number;
  readonly #timeout: number;
  readonly #now: () => number;
  constructor(readonly config: VisionConfig) {
    this.#max = config.maxActions ?? 12;
    this.#timeout = config.timeoutMs ?? 300_000;
    this.#now = config.now ?? Date.now;
    if (
      !Number.isInteger(this.#max) ||
      this.#max < 1 ||
      this.#max > 12 ||
      !Number.isInteger(this.#timeout) ||
      this.#timeout < 1000 ||
      this.#timeout > 600_000
    )
      throw new VisionFailure('invalid_limits');
  }
  handles(toolId: string): boolean {
    return toolId === 'computer.run';
  }

  async run(step: VisionStep, parent?: AbortSignal): Promise<VisionOutcome> {
    if (!this.handles(step.toolId) || !this.config.enabled) return failure('disabled');
    if (this.#busy) return failure('busy');
    this.#busy = true;
    const controller = new AbortController();
    const signal = parent ? AbortSignal.any([parent, controller.signal]) : controller.signal;
    const timer = setTimeout(() => controller.abort(new VisionFailure('timeout')), this.#timeout);
    const audit: AuditRow[] = [];
    let device: VisionDevice | undefined;
    try {
      check(signal);
      requireApproval(step.approval, 'computer.run', this.#now());
      const goal = step.args['goal'];
      const criteria = step.args['successCriteria'] ?? goal;
      if (
        typeof goal !== 'string' ||
        !goal.trim() ||
        goal.length > 2000 ||
        typeof criteria !== 'string' ||
        !criteria.trim() ||
        criteria.length > 2000
      )
        throw new VisionFailure('invalid_goal');
      const kind = await wait(this.config.selectModel(), signal);
      // A CLI with broad Read permissions is not automatically granted screenshot access.
      if (!kind || !['local', 'openai_api', 'anthropic_api', 'gemini_api', 'codex'].includes(kind))
        throw new VisionFailure('vision_model_unavailable');
      if (kind !== 'local' && !this.config.allowExternalPixels)
        throw new VisionFailure('egress_consent_required');
      device = this.config.device();
      await wait(device.claim(step.id), signal);
      const initial = frameOf(await wait(device.begin(goal, kind, signal), signal), this.#now());
      let current = initial;
      let count = 0;
      let replans = 0;
      let calls = 0;
      let lastAttempt = '';
      const model = async (
        toolId: string,
        frames: VisionFrame[],
        args: Record<string, unknown>,
      ) => {
        check(signal);
        requireApproval(step.approval, 'computer.run', this.#now());
        if (++calls > 30) throw new VisionFailure('model_call_limit');
        // Only references cross into the LLM runner. Pixel reading uses existing VisualContext rules.
        const result = await wait(
          this.config.model.run(
            {
              id: `${step.id}:vision:${calls}`,
              toolId,
              approval: null,
              args: {
                ...args,
                goal,
                successCriteria: criteria,
                vision_model_kind: kind,
                images: frames.map((f, i) => ({
                  id: f.id,
                  kind: 'screenshot',
                  label: frames.length === 2 ? (i === 0 ? 'BEFORE' : 'AFTER') : 'CURRENT',
                })),
                frames: frames.map((f) => ({ id: f.id, width: f.width, height: f.height })),
                observation: frames.at(-1),
                history: audit.slice(-4),
              },
            },
            signal,
          ),
          signal,
        );
        if (!result.ok) throw new VisionFailure(result.error?.code ?? 'model_failed');
        return result.result;
      };
      const capture = async () => {
        check(signal);
        const fresh = frameOf(await wait(device!.capture(initial, signal), signal), this.#now());
        assertScope(fresh, initial);
        return fresh;
      };
      while (true) {
        check(signal);
        const proposed = decisionOf(
          await model(TOOLS.plan, [current], { turn: count, maxActions: this.#max }),
          current,
        );
        if (proposed.action === 'stop') throw new VisionFailure('planner_stopped');
        if (proposed.action === 'done') {
          const latest = await capture();
          const verified = verdictOf(
            await model(TOOLS.verify, [latest], { phase: 'goal' }),
            latest,
          );
          audit.push({
            sequence: count,
            event: 'goal_verification',
            before: latest.sha256,
            verified: verified === 'satisfied',
          });
          if (verified === 'satisfied')
            return {
              ok: true,
              result: {
                completed: true,
                verification: 'visual',
                actions: count,
                modelCalls: calls,
                audit,
              },
            };
          if (++replans > 2) throw new VisionFailure('goal_not_verified');
          current = latest;
          continue;
        }
        if (count >= this.#max) throw new VisionFailure('action_limit');
        // No stale model result may mutate the desktop after cancellation or approval expiry.
        check(signal);
        requireApproval(step.approval, 'computer.run', this.#now());
        if (this.#now() - current.capturedAt > 60_000) {
          if (++replans > 2) throw new VisionFailure('stale_frame');
          current = await capture();
          continue;
        }
        const signature = createHash('sha256')
          .update(
            JSON.stringify({
              frame: current.sha256,
              action: proposed.action,
              target: proposed.target,
              text: proposed.text,
              key: proposed.key,
            }),
          )
          .digest('hex');
        if (signature === lastAttempt) throw new VisionFailure('repeated_action');
        lastAttempt = signature;
        try {
          await wait(
            device.apply(
              current,
              proposed,
              signal,
              Date.parse((step.approval as { expiresAt: string }).expiresAt),
            ),
            signal,
          );
        } catch (error) {
          // Only a definite pre-input stale-frame refusal can retry without ambiguity.
          if (error instanceof VisionFailure && error.code === 'stale_frame' && ++replans <= 2) {
            current = await capture();
            continue;
          }
          throw error;
        }
        count++;
        const after = await capture();
        const verified = verdictOf(
          await model(TOOLS.verify, [current, after], {
            phase: 'action',
            expectation: proposed.expectation,
            action: proposed.action,
          }),
          after,
        );
        audit.push({
          sequence: count,
          event: proposed.action,
          before: current.sha256,
          after: after.sha256,
          verified: verified === 'satisfied',
        });
        if (verified !== 'satisfied' && ++replans > 2)
          throw new VisionFailure('action_not_verified');
        current = after;
      }
    } catch (error) {
      const code = signal.aborted
        ? controller.signal.aborted
          ? 'timeout'
          : 'cancelled'
        : error instanceof VisionFailure
          ? error.code
          : 'failed';
      return { ...failure(code), result: { completed: false, audit } };
    } finally {
      clearTimeout(timer);
      // The production helper is killed on AbortSignal; it cannot keep typing after stop.
      controller.abort();
      if (device) await device.close().catch(() => undefined);
      this.#busy = false;
    }
  }
}

function failure(code: string): VisionOutcome {
  return {
    ok: false,
    error: {
      code: `computer.vision.${code}`,
      message:
        '画面操作を停止しました。完了は確認されていません。権限・対象画面・モデル設定を確認してください。',
    },
  };
}
function check(signal: AbortSignal): void {
  if (signal.aborted) throw new VisionFailure('cancelled');
}
async function wait<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  check(signal);
  return new Promise<T>((resolve, reject) => {
    const abort = () => {
      cleanup();
      reject(new VisionFailure('cancelled'));
    };
    const cleanup = () => signal.removeEventListener('abort', abort);
    signal.addEventListener('abort', abort, { once: true });
    promise.then(
      (v) => {
        cleanup();
        resolve(v);
      },
      (e) => {
        cleanup();
        reject(e);
      },
    );
    if (signal.aborted) abort();
  });
}
