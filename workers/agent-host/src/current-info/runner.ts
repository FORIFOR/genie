/**
 * `info.lookup` を端末で走らせる。モデルは使わない。
 *
 * 成果物の本文は InfoEnvelope の JSON（mime: application/vnd.genie.info+json）。
 * 取得に失敗したら**失敗として返す**。古い値や推測で埋めない。
 */
import type { HostStep, StepOutcome } from '../connector-steps.js';
import type { StepRunner } from '../step-loop.js';
import type { InfoEnvelope } from './envelope.js';
import { infoFetch, type InfoFetch } from './hosts.js';
import { lookupNews } from './news.js';
import { defaultRegion } from './preferences.js';
import { lookupWeather } from './weather.js';

export interface CurrentInfoRunnerOptions {
  readonly fetch?: InfoFetch;
  readonly region?: () => string;
  readonly now?: () => Date;
}

function text(args: Record<string, unknown>, key: string): string | null {
  const value = args[key];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export class CurrentInfoRunner implements StepRunner {
  readonly #fetch: InfoFetch;
  readonly #region: () => string;
  readonly #now: () => Date;

  constructor(options: CurrentInfoRunnerOptions = {}) {
    this.#fetch = options.fetch ?? infoFetch();
    this.#region = options.region ?? (() => defaultRegion());
    this.#now = options.now ?? (() => new Date());
  }

  handles(toolId: string): boolean {
    return toolId === 'info.lookup';
  }

  async run(step: HostStep): Promise<StepOutcome> {
    const kind = text(step.args, 'kind');
    let envelope: InfoEnvelope;
    try {
      if (kind === 'weather') {
        envelope = await lookupWeather(
          { when: text(step.args, 'when') ?? 'today', place: text(step.args, 'place') },
          this.#fetch,
          this.#region(),
          this.#now,
        );
      } else if (kind === 'news') {
        envelope = await lookupNews({ topic: text(step.args, 'topic') }, this.#fetch, this.#now);
      } else {
        return { ok: false, error: { code: 'info.unsupported', message: 'この情報はまだ取得できません。' } };
      }
    } catch {
      return {
        ok: false,
        error: {
          code: 'info.unavailable',
          message: kind === 'weather' ? '天気予報を取得できませんでした。' : 'ニュースを取得できませんでした。',
        },
      };
    }
    const title = text(step.args, 'question') ?? (kind === 'weather' ? '天気' : 'ニュース');
    return {
      ok: true,
      result: { kind: envelope.kind, artifact: { title, markdown: JSON.stringify(envelope) } },
    };
  }
}
