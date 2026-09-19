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
  complete(requestId: string, hostId: string, result: unknown): Promise<void>;
  fail(requestId: string, hostId: string, error: { code: string; message: string }): Promise<void>;
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

      const outcome = await this.#options.runner.run(step, this.#abort.signal);
      if (outcome.ok) {
        await this.#options.transport.complete(step.id, hostId, outcome.result ?? null);
      } else {
        await this.#options.transport.fail(
          step.id,
          hostId,
          outcome.error ?? { code: 'host.failed', message: '端末で実行できませんでした。' },
        );
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
      this.#current = null;
      this.#abort = null;
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
