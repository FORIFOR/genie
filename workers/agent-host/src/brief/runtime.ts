/**
 * `brief.compose`: 今日のまとめ（読み取り専用）。端末で組み立て、成果物は genie.brief/v1 の JSON。
 */
import { BriefArgs } from '@genie/contracts';
import type { ConnectorRuntime, HostStep, StepOutcome } from '../connector-steps.js';
import { infoFetch, type InfoFetch } from '../current-info/hosts.js';
import { defaultRegion } from '../current-info/preferences.js';
import { composeBrief } from './compose.js';
import { readBriefGoogleCalendar } from './calendar.js';
import { mailCheckText, readBriefMail } from './mail.js';

export interface BriefRuntimeDeps {
  readonly get?: InfoFetch;
  readonly region?: () => string;
  readonly now?: () => Date;
  readonly connectors?: ConnectorRuntime;
  /** Google カレンダーを読めたか（件数・理由の種類だけ）。 */
  readonly onCalendarRead?: (outcome: { read: boolean; events?: number; reason?: string }) => void;
}

export class BriefRuntime {
  readonly #deps: BriefRuntimeDeps;
  constructor(deps: BriefRuntimeDeps = {}) {
    this.#deps = deps;
  }

  handles(toolId: string): boolean {
    return toolId === 'brief.compose' || toolId === 'mail.check';
  }

  async run(step: HostStep): Promise<StepOutcome> {
    if (step.toolId === 'mail.check') {
      const section = await readBriefMail(this.#deps.connectors, this.#deps.now);
      return {
        ok: true,
        result: {
          kind: 'mail',
          artifact: { title: 'メールの確認', markdown: mailCheckText(section) },
        },
      };
    }
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
      mail: () => readBriefMail(this.#deps.connectors, this.#deps.now),
      cloudCalendar: (window, offset) =>
        readBriefGoogleCalendar(this.#deps.connectors, window, offset, this.#deps.onCalendarRead),
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
