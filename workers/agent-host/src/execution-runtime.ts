import { createHash } from 'node:crypto';
import type { HostStep, StepOutcome } from './connector-steps.js';
import type { StepRunner } from './step-loop.js';
import { requireApproval } from './computer-vision-policy.js';
import { FileExecutionStore, type ExecutionStore } from './execution-store.js';
import {
  intentOf,
  object,
  previewDetails,
  receiptArtifact,
  selectExecutionRoute,
  type ExecutionCapability,
  type ExecutionIntent,
  type PreparedExecution,
  type ExecutionReceipt,
} from './execution-policy.js';

export interface ExecutionAdapter {
  readonly id: string;
  /** A READ-ONLY readiness check for this exact operation. Never mutate to test a capability. */
  probe(intent: ExecutionIntent, signal?: AbortSignal): Promise<ExecutionCapability | null>;
  /** Must independently read/verify the result. A provider's write response is not verification. */
  execute(
    intent: ExecutionIntent,
    proof: NonNullable<HostStep['approval']>,
    requestId: string,
    signal?: AbortSignal,
  ): Promise<{ verified: boolean; evidence?: string }>;
}
export interface ExecutionRuntimeConfig {
  readonly model: StepRunner;
  readonly deviceId?: string;
  readonly adapters: readonly ExecutionAdapter[];
  readonly store?: ExecutionStore;
  readonly now?: () => number;
}
const canonical = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(canonical)
    : object(value)
      ? Object.fromEntries(
          Object.entries(value as Record<string, unknown>)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([k, v]) => [k, canonical(v)]),
        )
      : value;
const digest = (value: unknown) =>
  createHash('sha256')
    .update(JSON.stringify(canonical(value)))
    .digest('hex');
const SUMMARY = {
  'mail.draft': '下書きを作成し、保存先の内容を確認しました（未送信）。',
  'calendar.create': '予定を作成し、カレンダーから内容を確認しました（招待なし）。',
  'text.insert': '入力欄の内容を確認しました。保存・送信は未確認です。',
  'computer.run': '指定した画面の表示を確認しました。保存・送信は未確認です。',
} as const;

/** Prepare -> immutable local plan -> exact task approval -> execute once -> readback receipt. */
export class ExecutionRuntime implements StepRunner {
  readonly #store: ExecutionStore;
  readonly #now: () => number;
  #busy = false;
  constructor(readonly config: ExecutionRuntimeConfig) {
    this.#store = config.store ?? new FileExecutionStore();
    this.#now = config.now ?? Date.now;
    if (new Set(config.adapters.map((a) => a.id)).size !== config.adapters.length)
      throw new Error('Duplicate execution adapter IDs');
  }
  handles(toolId: string): boolean {
    return ['execution.prepare', 'execution.apply', 'execution.report'].includes(toolId);
  }
  async run(step: HostStep, signal?: AbortSignal): Promise<StepOutcome> {
    if (!this.handles(step.toolId)) return failed('unsupported');
    if (this.#busy) return failed('busy');
    this.#busy = true;
    let wrote = false;
    try {
      signal?.throwIfAborted();
      if (step.toolId === 'execution.report') {
        const raw = object(step.args['prepared']);
        // Report has no IO and cannot issue a verified receipt, even for forged input.
        const status = raw?.['status'] === 'needs_input' ? 'needs_input' : 'unavailable';
        return {
          ok: true,
          result: receiptArtifact({
            version: 1,
            status,
            route: null,
            level: null,
            summary:
              status === 'needs_input'
                ? '実行する内容を特定できませんでした。宛先・本文や開始と終了時刻を明記して、改めて依頼してください。'
                : 'この依頼を実行し、結果まで確認できる接続がありません。接続設定を確認してください。',
            checkedAt: null,
            evidence: null,
          }),
        };
      }
      if (step.toolId === 'execution.prepare') return await this.prepare(step, signal);
      requireApproval(step.approval, 'execution.apply', this.#now());
      const submitted = object(step.args['prepared']);
      if (!submitted || typeof submitted['id'] !== 'string') return failed('invalid_plan');
      const prepared = await this.#store.load(submitted['id']);
      // The task's displayed proposal must be exactly the immutable device proposal.
      if (
        digest(prepared) !== digest(submitted) ||
        prepared.status !== 'ready' ||
        !prepared.intent ||
        !prepared.capability ||
        !Number.isFinite(prepared.expiresAt) ||
        prepared.expiresAt <= this.#now()
      )
        return failed('expired_or_changed');
      const adapter = this.config.adapters.find((a) => a.id === prepared.capability!.id);
      if (!adapter) return failed('route_unavailable');
      const current = await adapter.probe(prepared.intent, signal);
      if (!current || digest(current) !== digest(prepared.capability))
        return failed('route_changed');
      signal?.throwIfAborted();
      requireApproval(step.approval, 'execution.apply', this.#now());
      await this.#store.claim(prepared.id);
      // A failure after this point is ambiguous. Never fall back or repeat the write.
      wrote = true;
      const outcome = await adapter.execute(prepared.intent, step.approval!, step.id, signal);
      signal?.throwIfAborted();
      const verified =
        outcome.verified &&
        typeof outcome.evidence === 'string' &&
        /^[a-f0-9]{64}$/.test(outcome.evidence);
      const receipt: ExecutionReceipt = {
        version: 1,
        status: verified ? 'verified' : 'unverified',
        route: current.route,
        level: verified ? current.verification : null,
        summary: verified
          ? SUMMARY[prepared.intent.operation]
          : '操作後の内容を確認できませんでした。二重実行を防ぐため再試行していません。',
        checkedAt: verified ? new Date(this.#now()).toISOString() : null,
        evidence: verified ? outcome.evidence! : null,
      };
      return { ok: true, result: receiptArtifact(receipt) };
    } catch {
      if (signal?.aborted) return failed('cancelled');
      if (wrote)
        return {
          ok: true,
          result: receiptArtifact({
            version: 1,
            status: 'unverified',
            route: null,
            level: null,
            summary:
              '操作の結果を確認できませんでした。変更が残っている可能性があります。自動再実行はしていません。',
            checkedAt: null,
            evidence: null,
          }),
        };
      return failed('not_started');
    } finally {
      this.#busy = false;
    }
  }
  private async prepare(step: HostStep, signal?: AbortSignal): Promise<StepOutcome> {
    const goal = step.args['goal'];
    if (typeof goal !== 'string' || !goal.trim() || goal.length > 8000)
      return failed('invalid_goal');
    const proposed = await this.config.model.run(
      {
        id: `${step.id}:intent`,
        toolId: 'llm.execution_intent',
        args: { goal, now: new Date(this.#now()).toISOString() },
        approval: null,
      },
      signal,
    );
    if (!proposed.ok) return proposed;
    signal?.throwIfAborted();
    const intent = intentOf(proposed.result, goal);
    const capabilities: ExecutionCapability[] = [];
    if (intent) {
      // Only probe adapters for the exact operation. Exceptions are unavailability, not permission grants.
      for (const adapter of this.config.adapters) {
        signal?.throwIfAborted();
        const capability = await adapter.probe(intent, signal).catch(() => null);
        if (capability && capability.id === adapter.id) capabilities.push(capability);
      }
    }
    const capability = intent ? selectExecutionRoute(intent, capabilities) : null;
    const status = !intent ? 'needs_input' : !capability ? 'unavailable' : 'ready';
    const value: Omit<PreparedExecution, 'id'> = {
      version: 1,
      status,
      goal,
      intent,
      capability,
      ...(this.config.deviceId ? { deviceId: this.config.deviceId } : {}),
      message:
        status === 'ready'
          ? '実行内容と確認方法を確認してください。'
          : status === 'needs_input'
            ? '宛先・本文、または開始・終了など必要な条件を明記してください。'
            : '結果を確認できる接続がありません。',
      expiresAt: this.#now() + 15 * 60_000,
      details: intent && capability ? previewDetails(intent, capability) : [],
    };
    return { ok: true, result: await this.#store.save(value) };
  }
}
function failed(reason: string): StepOutcome {
  return {
    ok: false,
    error: {
      code: `execution.${reason}`,
      message:
        reason === 'cancelled'
          ? '停止しました。すでに実行した変更は取り消していません。'
          : '実行条件や承認を確認できないため開始しませんでした。接続を確認し、新しい依頼としてやり直してください。',
    },
  };
}
export { digest as executionDigest };
