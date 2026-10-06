/**
 * `brief.compose`: 今日のまとめ（読み取り専用）。端末で組み立て、成果物は genie.brief/v1 の JSON。
 */
import { BriefArgs } from '@genie/contracts';
import type { HostStep, StepOutcome } from '../connector-steps.js';
import { infoFetch, type InfoFetch } from '../current-info/hosts.js';
import { defaultRegion } from '../current-info/preferences.js';
import { composeBrief } from './compose.js';

export interface BriefRuntimeDeps {
  readonly get?: InfoFetch;
  readonly region?: () => string;
  readonly now?: () => Date;
}

export class BriefRuntime {
  readonly #deps: BriefRuntimeDeps;
  constructor(deps: BriefRuntimeDeps = {}) {
    this.#deps = deps;
  }

  handles(toolId: string): boolean {
    return toolId === 'brief.compose';
  }

  async run(step: HostStep): Promise<StepOutcome> {
    const parsed = BriefArgs.safeParse(step.args);
    if (!parsed.success)
      return {
        ok: false,
        error: {
          code: 'brief.invalid_args',
          message: '今日のまとめの材料を読み取れませんでした。',
        },
      };
    const envelope = await composeBrief(parsed.data, {
      get: this.#deps.get ?? infoFetch(),
      region: (this.#deps.region ?? defaultRegion)(),
      ...(this.#deps.now ? { now: this.#deps.now } : {}),
    });
    return {
      ok: true,
      result: {
        kind: 'brief',
        artifact: { title: '今日のまとめ', markdown: JSON.stringify(envelope) },
      },
    };
  }
}
