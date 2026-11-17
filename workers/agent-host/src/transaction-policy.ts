import {
  canonicalJson,
  canonicalSha256,
  OrderObservation,
  type TransactionQuote,
  type TransactionSubmitArgs,
} from '@genie/contracts';
import type { ApprovalProof } from '@genie/service-connectors';

export class TransactionFailure extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

export async function validateApproval(
  approval: ApprovalProof | null,
  args: TransactionSubmitArgs,
  now: number,
): Promise<string> {
  const hash = await canonicalSha256(args);
  const proof = approval as (ApprovalProof & { inputsHash?: string }) | null;
  if (
    !proof ||
    proof.operationId !== 'transaction.submit' ||
    proof.decision !== 'APPROVED' ||
    !proof.approvalId ||
    !proof.decidedBy ||
    !Number.isFinite(Date.parse(proof.decidedAt)) ||
    Date.parse(proof.decidedAt) > now ||
    !Number.isFinite(Date.parse(proof.expiresAt)) ||
    Date.parse(proof.expiresAt) <= now ||
    Date.parse(proof.expiresAt) <= Date.parse(proof.decidedAt)
  )
    throw new TransactionFailure('approval_required');
  if (proof.inputsHash !== hash) throw new TransactionFailure('approval_mismatch');
  return hash;
}

export function validateObservation(
  raw: unknown,
  quote: TransactionQuote,
  quoteHash: string,
  now: number,
  attemptedAt: number,
): OrderObservation {
  const parsed = OrderObservation.safeParse(raw);
  if (!parsed.success) throw new TransactionFailure('observation_mismatch');
  const observed = parsed.data;
  if (
    ['provider', 'mode', 'account', 'orderKey'].some(
      (key) => observed[key as 'provider'] !== quote[key as 'provider'],
    ) ||
    observed.quoteHash !== quoteHash ||
    Date.parse(observed.observedAt) > now + 1000 ||
    Date.parse(observed.observedAt) < attemptedAt ||
    observed.details.currency !== quote.currency ||
    observed.details.totalMinor !== quote.totals.totalMinor ||
    observed.details.destinationId !== quote.destination.id ||
    observed.details.paymentMethodRef !== quote.paymentMethodRef ||
    observed.details.requestedTime !== quote.requestedTime ||
    canonicalJson(observed.details.stock ?? null) !== canonicalJson(quote.stock ?? null) ||
    canonicalJson(observed.details.items) !== canonicalJson(quote.items)
  )
    throw new TransactionFailure('observation_mismatch');
  const statuses =
    quote.kind === 'delivery'
      ? [
          'accepted',
          'preparing',
          'out_for_delivery',
          'delivered',
          'rejected',
          'cancelled',
          'expired',
        ]
      : ['accepted', 'partially_filled', 'filled', 'rejected', 'cancelled', 'expired'];
  if (!statuses.includes(observed.status)) throw new TransactionFailure('observation_mismatch');
  const fills = observed.fills ?? [];
  if (quote.kind === 'delivery' && fills.length)
    throw new TransactionFailure('observation_mismatch');
  if (quote.stock) {
    const quantity = fills.reduce((sum, fill) => sum + fill.quantity, 0);
    if (
      new Set(fills.map((fill) => fill.executionId)).size !== fills.length ||
      quantity > quote.stock.quantity ||
      (observed.status === 'partially_filled' &&
        (quantity <= 0 || quantity >= quote.stock.quantity)) ||
      (observed.status === 'filled' && quantity !== quote.stock.quantity) ||
      (['accepted', 'rejected'].includes(observed.status) && quantity !== 0) ||
      (quote.stock.orderType === 'LIMIT' &&
        fills.some((fill) =>
          quote.stock!.side === 'BUY'
            ? fill.priceMinor > quote.stock!.limitPriceMinor!
            : fill.priceMinor < quote.stock!.limitPriceMinor!,
        ))
    )
      throw new TransactionFailure('observation_mismatch');
  }
  return observed;
}

/** A later read must not undo a known terminal state or forget/change an execution. */
export function validateObservationProgress(
  previous: OrderObservation,
  next: OrderObservation,
): void {
  const terminal = ['delivered', 'filled', 'rejected', 'cancelled', 'expired'];
  const ranks: Record<string, number> = {
    accepted: 0,
    preparing: 1,
    out_for_delivery: 2,
    partially_filled: 1,
  };
  if (
    previous.providerOrderId !== next.providerOrderId ||
    previous.quoteHash !== next.quoteHash ||
    Date.parse(next.observedAt) < Date.parse(previous.observedAt) ||
    (terminal.includes(previous.status) && next.status !== previous.status) ||
    (ranks[next.status] !== undefined && (ranks[previous.status] ?? 0) > ranks[next.status]!) ||
    canonicalJson(previous.details) !== canonicalJson(next.details)
  )
    throw new TransactionFailure('observation_regressed');
  const nextFills = new Map((next.fills ?? []).map((fill) => [fill.executionId, fill]));
  if (
    (previous.fills ?? []).some(
      (fill) => canonicalJson(nextFills.get(fill.executionId) ?? null) !== canonicalJson(fill),
    ) ||
    (terminal.includes(previous.status) &&
      (previous.fills ?? []).length !== (next.fills ?? []).length)
  )
    throw new TransactionFailure('observation_regressed');
}
