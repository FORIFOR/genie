/**
 * 端末が仕事を取りに来る側。正本 §4.4。
 *
 * **押し付けられない。**サーバから端末へ繋ぎに行く道は作らない。
 * それを作ると、端末を外から叩ける口になる。
 *
 * ここが守ること:
 *   - 一度に 1 件だけ。並べて走らせない（外部への操作が重なる）
 *   - 取ったものは、成功でも失敗でも**必ず返す**。返さないと仕事が宙に浮く
 *   - 扱えない step は「扱えない」と返す。**黙って成功にしない**
 */
import type { HostStep, StepOutcome } from './connector-steps.js';

export interface StepTransport {
  /** 次の 1 件を取る。無ければ null。 */
  claim(hostId: string): Promise<HostStep | null>;
  /** Fresh server authority; production transport supports this for every tool. */
  executionAllowed?(requestId: string, hostId: string, signal?: AbortSignal): Promise<boolean>;
  complete(requestId: string, hostId: string, result: unknown): Promise<void>;
  fail(
    requestId: string,
    hostId: string,
    error: { code: string; message: string },
    result?: unknown,
  ): Promise<void>;
}

export interface StepRunner {
  handles(toolId: string): boolean;
  run(step: HostStep, signal?: AbortSignal): Promise<StepOutcome>;
}

export interface StepLoopOptions {
  readonly transport: StepTransport;
  readonly runner: StepRunner;
  /** 何も無いときに次を見るまでの間隔。 */
  readonly idleMs?: number;
  readonly authorityPollMs?: number;
  readonly authorityTimeoutMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly onError?: (error: Error) => void;
}

export const DEFAULT_IDLE_MS = 2_000;

export class HostStepLoop {
  readonly #options: StepLoopOptions;
  #running = false;
  #stopping = false;
  /** いま走らせている 1 件。**2 件目を取りに行かないための記録。** */
  #current: string | null = null;
  #claiming = false;
  #abort: AbortController | null = null;

  constructor(options: StepLoopOptions) {
    this.#options = options;
  }

  get busyWith(): string | null {
    return this.#current;
  }

  /** 1 周だけ回す。取るものが無ければ false。 */
  async tick(hostId: string): Promise<boolean> {
    if (this.#current !== null || this.#claiming || this.#stopping) return false;
    this.#claiming = true;
    let step: HostStep | null;
    try {
      step = await this.#options.transport.claim(hostId);
    } finally {
      this.#claiming = false;
    }
    if (!step) return false;
    this.#current = step.id;
    this.#abort = new AbortController();
    const abort = this.#abort;
    let stopAuthority = (): void => {};
    if (this.#stopping) this.#abort.abort();
    try {
      if (!this.#options.runner.handles(step.toolId)) {
        /*
         * 取ってしまったが扱えない。**放置しない。**
         * 放置すると、cloud 側は端末が走らせていると思って待ち続ける。
         */
        await this.#options.transport.fail(step.id, hostId, {
          code: 'host.unsupported_step',
          message: 'この端末はこの操作に対応していません。',
        });
        return true;
      }

      const checkAuthority = this.#options.transport.executionAllowed;
      // Old/custom transports may still execute legacy tools. A financial submit
      // requires revocation support and cannot silently downgrade to that path.
      if (!checkAuthority && step.toolId === 'transaction.submit') {
        await this.#options.transport.fail(step.id, hostId, {
          code: 'host.authority_unavailable',
          message: '実行許可の確認に対応していないため停止しました。',
        });
        return true;
      }
      if (checkAuthority) {
        const check = async (): Promise<boolean> => {
          const signal = AbortSignal.any([
            abort.signal,
            AbortSignal.timeout(this.#options.authorityTimeoutMs ?? 3_000),
          ]);
          // A transport may be waiting for a shared token refresh before it gets
          // to fetch. Bound that wait too; merely passing fetch a signal is late.
          return new Promise<boolean>((resolve, reject) => {
            const stopped = (): void => {
              signal.removeEventListener('abort', stopped);
              reject(signal.reason);
            };
            if (signal.aborted) {
              stopped();
              return;
            }
            signal.addEventListener('abort', stopped, { once: true });
            Promise.resolve()
              .then(() => {
                signal.throwIfAborted();
                return checkAuthority.call(this.#options.transport, step.id, hostId, signal);
              })
              .then(
                (value) => {
                  signal.removeEventListener('abort', stopped);
                  resolve(value);
                },
                (error) => {
                  signal.removeEventListener('abort', stopped);
                  reject(error);
                },
              );
          });
        };
        if (!(await check())) abort.abort(new Error('task execution was revoked'));
        if (!abort.signal.aborted) {
          let stopped = false;
          let timer: ReturnType<typeof setTimeout> | undefined;
          const poll = async (): Promise<void> => {
            try {
              if (!(await check()) && !stopped)
                abort.abort(new Error('task execution was revoked'));
            } catch (error) {
              // A lost authority connection is not permission to keep entering input.
              if (!stopped) abort.abort(error);
            }
            if (!stopped && !abort.signal.aborted) schedule();
          };
          const schedule = (): void => {
            timer = setTimeout(() => {
              void poll();
            }, this.#options.authorityPollMs ?? 500);
          };
          stopAuthority = () => {
            stopped = true;
            if (timer) clearTimeout(timer);
          };
          schedule();
        }
      }
      if (abort.signal.aborted) {
        await this.#options.transport.fail(step.id, hostId, {
          code: 'host.cancelled',
          message: '実行前に停止しました。',
        });
        return true;
      }
      const outcome = await this.#options.runner.run(step, abort.signal);
      stopAuthority();
      /*
       * 結果を返す。**返すことの失敗を、仕事の失敗にしない。**
       * 以前は complete が通信の一時的な失敗（再起動の直後の `fetch failed`）で落ちると、下の catch で
       * fail を送り、うまくいった仕事が失敗になっていた。一時的な失敗はやり直し、それでも返せなければ
       * 何も送らない（受け渡しは期限切れになり、cloud 側は待ち直せる）。
       */
      try {
        if (outcome.ok) {
          await this.#report(() =>
            this.#options.transport.complete(step.id, hostId, outcome.result ?? null),
          );
        } else {
          await this.#report(() =>
            this.#options.transport.fail(
              step.id,
              hostId,
              outcome.error ?? { code: 'host.failed', message: '端末で実行できませんでした。' },
              // Keep reconciliation identity even when an order outcome is unknown.
              // It remains a failure; recording it must not turn it into a new submit.
              step.toolId.startsWith('transaction.') ? outcome.result : undefined,
            ),
          );
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.#options.onError?.(new Error(`the result could not be reported: ${message}`));
      }
      return true;
    } catch (error) {
      /*
       * 走らせている最中に落ちた。**成功として返さない。**
       * 返せなければ受け渡しは期限切れになり、cloud 側は待ち直せる。
       */
      const message = error instanceof Error ? error.message : String(error);
      this.#options.onError?.(error instanceof Error ? error : new Error(message));
      await this.#options.transport
        .fail(step.id, hostId, {
          code: 'host.failed',
          message: '端末で実行できませんでした。',
        })
        .catch(() => undefined);
      return true;
    } finally {
      stopAuthority();
      this.#current = null;
      this.#abort = null;
    }
  }

  /** 報告を送る。通信の一時的な失敗（接続できない・切れた・502/503/504）だけ、間を空けて 5 回までやり直す。 */
  async #report(send: () => Promise<void>): Promise<void> {
    const waits = [250, 500, 1_000, 2_000, 4_000];
    const sleep =
      this.#options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    for (let attempt = 0; ; attempt++) {
      try {
        await send();
        return;
      } catch (error) {
        if (attempt >= waits.length || !isTransient(error)) throw error;
        await sleep(waits[attempt]!);
      }
    }
  }

  /** 止めるまで回し続ける。 */
  async start(hostId: string): Promise<void> {
    if (this.#running) return;
    this.#running = true;
    this.#stopping = false;
    const idleMs = this.#options.idleMs ?? DEFAULT_IDLE_MS;
    const sleep = this.#options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));

    let failures = 0;
    while (!this.#stopping) {
      let did = false;
      try {
        did = await this.tick(hostId);
        failures = 0;
      } catch (error) {
        failures++;
        // Back off unavailable authentication/network instead of polling every two seconds.
        this.#options.onError?.(error instanceof Error ? error : new Error(String(error)));
      }
      // 続けて仕事があるうちは待たない
      if (!did) await sleep(Math.min(60_000, idleMs * 2 ** Math.min(failures, 5)));
    }
    this.#running = false;
  }

  stop(): void {
    this.#stopping = true;
    this.#abort?.abort();
  }
}

/** 通信の一時的な失敗か（やり直してよい）。認証・権限・入力の誤りはやり直さない。 */
export function isTransient(error: unknown): boolean {
  const e = error as { message?: string; code?: string; cause?: { code?: string } } | null;
  const text = `${e?.message ?? ''} ${e?.code ?? ''} ${e?.cause?.code ?? ''}`;
  return /fetch failed|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EPIPE|UND_ERR_SOCKET|\b(502|503|504)\b/.test(
    text,
  );
}
