/**
 * 端末が受ける step を、扱えるものへ振り分ける。正本 §4.4。
 *
 * **扱えないものを引き受けない。**引き受けて黙って何もしないと、
 * cloud 側は走っていると思って待ち続ける。
 */
import type { HostStep, StepOutcome } from './connector-steps.js';
import type { StepRunner } from './step-loop.js';

export class CompositeRunner implements StepRunner {
  readonly #runners: readonly StepRunner[];
  /** 1 つ終わるごとに呼ぶ（何を・何秒で・結果の種類。引数や結果の中身は渡さない）。 */
  readonly #onFinished: ((toolId: string, outcome: StepOutcome, ms: number) => void) | undefined;

  constructor(
    runners: readonly StepRunner[],
    onFinished?: (toolId: string, outcome: StepOutcome, ms: number) => void,
  ) {
    this.#runners = runners;
    this.#onFinished = onFinished;
  }

  handles(toolId: string): boolean {
    return this.#runners.some((runner) => runner.handles(toolId));
  }

  async run(step: HostStep, signal?: AbortSignal): Promise<StepOutcome> {
    const runner = this.#runners.find((r) => r.handles(step.toolId));
    if (!runner) {
      return {
        ok: false,
        error: { code: 'host.unsupported_step', message: 'この端末はこの操作に対応していません。' },
      };
    }
    const started = Date.now();
    const outcome = await runner.run(step, signal);
    this.#onFinished?.(step.toolId, outcome, Date.now() - started);
    return outcome;
  }
}
