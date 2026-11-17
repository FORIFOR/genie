import { constants } from 'node:fs';
import { access, realpath } from 'node:fs/promises';
import { delimiter, isAbsolute, join } from 'node:path';
import { homedir } from 'node:os';
import type { HostStep, StepOutcome } from '../connector-steps.js';
import type { StepRunner } from '../step-loop.js';
import { OrcaAdapter, OrcaError, type OrcaReadiness } from './orca-adapter.js';

export async function findOrca(): Promise<string | null> {
  const override = process.env['ASTRA_ORCA_PATH'];
  const candidates = override
    ? isAbsolute(override)
      ? [override]
      : []
    : (process.env['PATH'] ?? '')
        .split(delimiter)
        .filter(isAbsolute)
        .map((dir) => join(dir, 'orca'));
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      return await realpath(candidate);
    } catch {
      /* try the next PATH entry */
    }
  }
  return null;
}

/** Read-only Orca readiness through the existing Temporal → HostStepExecutor path. */
export class OrcaStatusRunner implements StepRunner {
  constructor(
    private readonly hostId: string,
    private readonly probe?: (signal?: AbortSignal) => Promise<OrcaReadiness>,
  ) {}
  handles(toolId: string): boolean {
    return toolId === 'coding.orca.status' || toolId === 'coding.orca.search';
  }

  async run(step: HostStep, signal?: AbortSignal): Promise<StepOutcome> {
    try {
      if (step.args['host_id'] !== this.hostId)
        throw new OrcaError('path_denied', '対象端末が異なります。');
      if (step.toolId === 'coding.orca.status') {
        const status = this.probe ? await this.probe(signal) : await this.#status(signal);
        return { ok: true, result: status };
      }
      const path = step.args['path'];
      const agent = step.args['agent'];
      const query = step.args['query'];
      if (
        typeof path !== 'string' ||
        (agent !== 'claude' && agent !== 'codex') ||
        typeof query !== 'string'
      ) {
        throw new OrcaError('invalid_response', '検索条件が無効です。');
      }
      const executable = await findOrca();
      if (!executable) throw new OrcaError('not_installed', 'Orca CLI が見つかりません。');
      const configured = process.env['ASTRA_ORCA_WORKSPACE_ROOTS'];
      const roots: unknown = configured ? JSON.parse(configured) : null;
      if (
        !Array.isArray(roots) ||
        roots.length === 0 ||
        !roots.every((root) => typeof root === 'string' && isAbsolute(root))
      ) {
        throw new OrcaError('path_denied', 'Orca の許可済み作業場所が設定されていません。');
      }
      return {
        ok: true,
        result: await new OrcaAdapter({ executable, roots: roots as string[] }).search(
          path,
          agent,
          query,
          signal,
        ),
      };
    } catch (error) {
      const code = error instanceof OrcaError ? error.code : 'command_failed';
      return {
        ok: false,
        error: { code: `orca.${code}`, message: 'Orca の状態を確認できませんでした。' },
      };
    }
  }

  async #status(signal?: AbortSignal): Promise<OrcaReadiness> {
    const executable = await findOrca();
    if (!executable) throw new OrcaError('not_installed', 'Orca CLI が見つかりません。');
    return new OrcaAdapter({ executable, roots: [homedir()] }).status(signal);
  }
}
