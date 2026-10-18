import { Context } from '@temporalio/activity';

/** Keep a live asynchronous step alive without relaxing its overall timeout or retry policy. */
export async function withActivityHeartbeat<T>(
  operation: () => Promise<T>,
  intervalMs = 10_000,
): Promise<T> {
  const context = Context.current();
  const beat = () => context.heartbeat({ phase: 'executing' });
  beat();
  const timer = setInterval(beat, intervalMs);
  timer.unref();
  try {
    return await operation();
  } finally {
    clearInterval(timer);
  }
}

/**
 * いま走っている activity の取り消し。activity の外（テストや単体の呼び出し）では undefined。
 *
 * Temporal を import しない executor に、取り消しだけを渡すための口。
 */
export function currentActivityCancellation(): AbortSignal | undefined {
  try {
    return Context.current().cancellationSignal;
  } catch {
    return undefined;
  }
}
