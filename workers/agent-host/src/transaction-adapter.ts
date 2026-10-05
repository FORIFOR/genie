import type {
  OrderObservation,
  TransactionIntent,
  TransactionKind,
  TransactionMode,
  TransactionQuote,
} from '@genie/contracts';

/** Registered by host configuration. Request arguments never select an arbitrary URL or executable. */
export interface TransactionAdapter {
  readonly provider: string;
  readonly mode: TransactionMode;
  readonly kinds: readonly TransactionKind[];
  prepare(intent: TransactionIntent, signal: AbortSignal): Promise<TransactionQuote>;
  /** Read-only current terms. It must not reserve, pay, or submit an order. */
  inspect(quote: TransactionQuote, signal: AbortSignal): Promise<TransactionQuote>;
  /** Only runtime invokes this after a durable attempt claim. */
  submit(
    quote: TransactionQuote,
    orderKey: string,
    signal: AbortSignal,
    authorizationExpiresAt: number,
  ): Promise<OrderObservation>;
  /** Read-only provider history lookup. A null result never grants permission to resubmit. */
  reconcile(
    quote: TransactionQuote,
    orderKey: string,
    signal: AbortSignal,
  ): Promise<OrderObservation | null>;
}
