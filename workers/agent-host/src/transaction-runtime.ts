import {
  canonicalSha256,
  evaluatePaperTrade,
  tradingDayOf,
  type TradingLimits,
  TransactionPrepareArgs,
  TransactionReconcileArgs,
  TransactionSubmitArgs,
  TransactionValidationError,
  validateTransactionQuote,
  validateTransactionSubmitArgs,
  type TransactionQuote,
  type TransactionResult,
} from '@genie/contracts';
import type { HostStep, StepOutcome } from './connector-steps.js';
import type { TransactionAdapter } from './transaction-adapter.js';
import { TransactionJournal, type TransactionAttempt } from './transaction-journal.js';
import { TransactionFailure, validateApproval, validateObservation } from './transaction-policy.js';
export { TransactionFailure } from './transaction-policy.js';

export interface TransactionRuntimeConfig {
  readonly adapters: readonly TransactionAdapter[];
  /** Dedicated private persistent directory, independent of screenshots and task IDs. */
  readonly journalDir: string;
  readonly now?: () => Date;
  readonly timeoutMs?: number;
  /** 模擬取引（デイトレード）の歯止め。省けば既定の上限。 */
  readonly tradingLimits?: TradingLimits;
}

/** 取引の作法で止めた。理由は具体的に言う（どの上限か、いくらか）。 */
class TradingLimitFailure extends Error {
  readonly code = 'trading_limit';
}

const TOOLS = new Set(['transaction.prepare', 'transaction.submit', 'transaction.reconcile']);
function check(signal: AbortSignal): void {
  if (signal.aborted) throw new TransactionFailure('cancelled');
}
async function wait<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const aborted = () => reject(new TransactionFailure('cancelled'));
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', aborted));
    if (signal.aborted) aborted();
    else signal.addEventListener('abort', aborted, { once: true });
  });
}
function identity(quote: TransactionQuote): TransactionReconcileArgs {
  return {
    provider: quote.provider,
    mode: quote.mode,
    account: quote.account,
    orderKey: quote.orderKey,
  };
}
function unknown(attempt: TransactionAttempt): StepOutcome {
  return {
    ok: false,
    result: result(attempt),
    error: {
      code: 'transaction.result_unknown',
      message: '注文結果を確認できていません。再注文せず、同じ注文の履歴を照会してください。',
    },
  };
}
function result(attempt: TransactionAttempt): TransactionResult {
  return { ...identity(attempt.args.quote), quoteHash: attempt.args.quoteHash, status: 'unknown' };
}

/** No live provider is bundled. Registration is a host-side trust boundary, not a model argument. */
export class TransactionRuntime {
  readonly #adapters = new Map<string, TransactionAdapter>();
  readonly #journal: TransactionJournal;
  readonly #now: () => number;
  readonly #timeout: number;
  readonly #tradingLimits: TradingLimits | undefined;
  /**
   * 株の模擬注文を、その日の約定記録と取引の規則に照らす。
   * 見積もりの時と、確定の直前の 2 回。確定までの間に別の注文が約定していることがある。
   */
  async #checkTrading(quote: TransactionQuote): Promise<void> {
    const stock = quote.stock;
    if (quote.kind !== 'stock_paper' || !stock) return;
    const now = new Date(this.#now());
    const decision = evaluatePaperTrade(
      {
        symbol: stock.symbol,
        side: stock.side,
        quantity: stock.quantity,
        priceMinor: stock.limitPriceMinor ?? Math.ceil(quote.totals.subtotalMinor / stock.quantity),
      },
      tradingDayOf(await this.#journal.stockFills(), now),
      now,
      { mode: quote.mode, ...(this.#tradingLimits ? { limits: this.#tradingLimits } : {}) },
    );
    if (!decision.allowed)
      throw new TradingLimitFailure(
        `${decision.blocks.map((block) => block.message).join(' ')} 注文は送っていません。`,
      );
  }

  constructor(config: TransactionRuntimeConfig) {
    this.#journal = new TransactionJournal(config.journalDir);
    this.#now = () => (config.now?.() ?? new Date()).getTime();
    this.#timeout = config.timeoutMs ?? 60_000;
    this.#tradingLimits = config.tradingLimits;
    if (!Number.isSafeInteger(this.#timeout) || this.#timeout < 1 || this.#timeout > 300_000)
      throw new TransactionFailure('invalid_config');
    for (const adapter of config.adapters) {
      const key = `${adapter.mode}:${adapter.provider}`;
      if (
        !adapter.provider ||
        !['simulation', 'live'].includes(adapter.mode) ||
        this.#adapters.has(key) ||
        !adapter.kinds.length ||
        adapter.kinds.some(
          (kind) =>
            !['delivery', 'stock_paper'].includes(kind) ||
            (kind === 'stock_paper' && adapter.mode !== 'simulation'),
        )
      )
        throw new TransactionFailure('invalid_config');
      this.#adapters.set(key, adapter);
    }
  }
  handles(toolId: string): boolean {
    return TOOLS.has(toolId);
  }
  #adapter(scope: { provider: string; mode: string; kind?: string }): TransactionAdapter {
    const adapter = this.#adapters.get(`${scope.mode}:${scope.provider}`);
    if (!adapter || (scope.kind && !adapter.kinds.includes(scope.kind as TransactionQuote['kind'])))
      throw new TransactionFailure('unsupported_provider');
    return adapter;
  }
  async run(step: HostStep, parent?: AbortSignal): Promise<StepOutcome> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeout);
    const signal = parent ? AbortSignal.any([parent, controller.signal]) : controller.signal;
    try {
      check(signal);
      if (step.toolId === 'transaction.prepare') {
        const parsed = TransactionPrepareArgs.safeParse(step.args);
        if (!parsed.success) throw new TransactionFailure('invalid_args');
        const intent = parsed.data.intent;
        const adapter = this.#adapter(intent);
        const quote = validateTransactionQuote(
          await wait(adapter.prepare(structuredClone(intent), signal), signal),
          intent,
          this.#now(),
        );
        check(signal);
        await this.#checkTrading(quote);
        const quoteHash = await canonicalSha256(quote);
        return { ok: true, result: { quote, quoteHash, submitArgs: { intent, quote, quoteHash } } };
      }
      if (step.toolId === 'transaction.reconcile') {
        const parsed = TransactionReconcileArgs.safeParse(step.args);
        if (!parsed.success) throw new TransactionFailure('invalid_args');
        const adapter = this.#adapter(parsed.data);
        const attempt = await this.#journal.find(parsed.data);
        if (!attempt) throw new TransactionFailure('no_attempt');
        return await this.#reconcile(attempt, adapter, signal);
      }
      if (step.toolId !== 'transaction.submit') throw new TransactionFailure('unsupported_tool');
      // Parse first so the complete exact argument object is bound, never just a
      // title, total, request ID, or planner-provided approval marker.
      const shape = TransactionSubmitArgs.safeParse(step.args);
      if (!shape.success) throw new TransactionFailure('invalid_args');
      const args = shape.data;
      const adapter = this.#adapter(args.quote);
      const argsHash = await validateApproval(step.approval, args, this.#now());
      const previous = await this.#journal.find(identity(args.quote));
      if (previous) {
        if (previous.argsHash !== argsHash) throw new TransactionFailure('order_key_conflict');
        return await this.#reconcile(previous, adapter, signal);
      }
      await validateTransactionSubmitArgs(args, this.#now());
      const fresh = validateTransactionQuote(
        await wait(adapter.inspect(structuredClone(args.quote), signal), signal),
        args.intent,
        this.#now(),
      );
      if ((await canonicalSha256(fresh)) !== args.quoteHash)
        throw new TransactionFailure('quote_changed');
      check(signal);
      await validateApproval(step.approval, args, this.#now());
      validateTransactionQuote(args.quote, args.intent, this.#now());
      await this.#checkTrading(args.quote);
      const attempt: TransactionAttempt = {
        version: 1,
        args,
        argsHash,
        taskId: step.id,
        approvalId: step.approval!.approvalId,
        attemptedAt: new Date(this.#now()).toISOString(),
      };
      const claimed = await this.#journal.claim(attempt);
      if (!claimed) {
        const winner = await this.#journal.find(identity(args.quote));
        if (!winner || winner.argsHash !== argsHash)
          throw new TransactionFailure('order_key_conflict');
        return await this.#reconcile(winner, adapter, signal);
      }
      // From this point even cancellation or a crash is a possibly-sent order.
      // No code path releases the claim or calls submit again for this identity.
      try {
        check(signal);
        await validateApproval(step.approval, args, this.#now());
        validateTransactionQuote(args.quote, args.intent, this.#now());
        const expiresAt = Math.min(
          Date.parse(step.approval!.expiresAt),
          Date.parse(args.quote.expiresAt),
        );
        const deliverySignal = AbortSignal.any([
          signal,
          AbortSignal.timeout(Math.min(300_000, Math.max(1, Math.floor(expiresAt - this.#now())))),
        ]);
        const observed = validateObservation(
          await wait(
            adapter.submit(
              structuredClone(args.quote),
              args.quote.orderKey,
              deliverySignal,
              expiresAt,
            ),
            deliverySignal,
          ),
          args.quote,
          args.quoteHash,
          this.#now(),
          Date.parse(attempt.attemptedAt),
        );
        await this.#journal.record(identity(args.quote), observed);
        return {
          ok: true,
          result: { ...result(attempt), status: observed.status, observation: observed },
        };
      } catch {
        return unknown(attempt);
      }
    } catch (error) {
      if (error instanceof TradingLimitFailure)
        return { ok: false, error: { code: 'transaction.trading_limit', message: error.message } };
      const code =
        error instanceof TransactionFailure || error instanceof TransactionValidationError
          ? error.code
          : 'provider_or_journal_failed';
      return {
        ok: false,
        error: {
          code: `transaction.${code}`,
          message:
            messages[code] ?? '注文を開始できませんでした。接続と注文内容を確認してください。',
        },
      };
    } finally {
      clearTimeout(timer);
    }
  }
  async #reconcile(
    attempt: TransactionAttempt,
    adapter: TransactionAdapter,
    signal: AbortSignal,
  ): Promise<StepOutcome> {
    try {
      check(signal);
      const quote = attempt.args.quote;
      const raw = await wait(
        adapter.reconcile(structuredClone(quote), quote.orderKey, signal),
        signal,
      );
      if (raw === null) return unknown(attempt);
      const observed = validateObservation(
        raw,
        quote,
        attempt.args.quoteHash,
        this.#now(),
        Date.parse(attempt.attemptedAt),
      );
      await this.#journal.record(identity(quote), observed);
      return {
        ok: true,
        result: { ...result(attempt), status: observed.status, observation: observed },
      };
    } catch {
      return unknown(attempt);
    }
  }
}

const messages: Record<string, string> = {
  unsupported_provider:
    'この注文先・実行モードにはまだ接続していません。模擬注文を本番注文として実行することはできません。',
  invalid_args: '注文条件が不完全または未対応です。推測で補わず停止しました。',
  invalid_quote: '明細と合計を照合できませんでした。注文は送っていません。',
  expired_quote: '見積の期限が切れています。最新の内容を取得して確認してください。',
  quote_changed: '注文内容が確認時から変わりました。新しい内容の確認が必要です。',
  quote_hash_mismatch: '確認する注文版が一致しません。注文は送っていません。',
  budget_exceeded: '手数料を含む合計が指定した注文予算を超えています。注文は送っていません。',
  approval_required: 'この注文内容に対する有効な承認が必要です。',
  approval_mismatch: '承認された内容と実行する注文が一致しません。注文は送っていません。',
  order_key_conflict:
    'この注文番号には別の確定試行が記録されています。再注文せず履歴を確認してください。',
  no_attempt:
    'この注文の確定試行は記録されていません。照会から注文を新規送信することはありません。',
  cancelled: '注文確定の前に停止しました。',
};
