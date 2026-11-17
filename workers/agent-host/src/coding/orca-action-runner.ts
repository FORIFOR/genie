import { isOrcaMutation, canonicalSha256 } from '@genie/contracts';
import { isAbsolute } from 'node:path';
import type { HostStep, StepOutcome } from '../connector-steps.js';
import type { StepRunner } from '../step-loop.js';
import { OrcaAdapter, OrcaError } from './orca-adapter.js';
import { findOrca } from './orca-status-runner.js';
import { ClaudeCodeCli, ClaudeCodeError } from '../claude-code.js';
import { CodexCli, CodexError } from '../codex.js';

type OrcaPort = Pick<
  OrcaAdapter,
  'create' | 'register' | 'launch' | 'resume' | 'search' | 'activeAgents'
>;

export type QuotaProbe = (
  agent: 'claude' | 'codex',
  signal?: AbortSignal,
) => Promise<'available' | 'rate_limited' | 'unavailable'>;

/** A read-only, no-tools request through the agent's own signed-in CLI. */
export const probeCodingQuota: QuotaProbe = async (agent, signal) => {
  try {
    const prompt = 'Return only this JSON object: {"ok":true}';
    if (agent === 'claude')
      await new ClaudeCodeCli().ask(prompt, { allowedTools: [], ...(signal ? { signal } : {}) });
    else await new CodexCli().ask(prompt, signal ? { signal } : {});
    return 'available';
  } catch (error) {
    if (
      (error instanceof ClaudeCodeError || error instanceof CodexError) &&
      error.reason === 'rate_limited'
    )
      return 'rate_limited';
    return 'unavailable';
  }
};

export class OrcaActionRunner implements StepRunner {
  constructor(
    private readonly hostId: string,
    private readonly port?: OrcaPort,
    private readonly quotaProbe: QuotaProbe = probeCodingQuota,
  ) {}

  handles(toolId: string): boolean {
    return isOrcaMutation(toolId);
  }

  async run(step: HostStep, signal?: AbortSignal): Promise<StepOutcome> {
    try {
      if (step.args['host_id'] !== this.hostId)
        throw new OrcaError('path_denied', '対象端末が異なります。');
      const proof = step.approval;
      if (
        !proof ||
        proof.operationId !== step.toolId ||
        proof.decision !== 'APPROVED' ||
        proof.inputsHash !== (await canonicalSha256(step.args)) ||
        Date.parse(proof.expiresAt) <= Date.now() ||
        !proof.decidedBy
      ) {
        throw new OrcaError('command_failed', 'この操作への承認がありません。');
      }
      const port = this.port ?? (await this.#port());
      const path = step.args['path'];
      const agent = step.args['agent'];
      const result = async (): Promise<unknown> => {
        switch (step.toolId) {
          case 'coding.orca.create': {
            const root = step.args['root'],
              name = step.args['name'];
            if (typeof root !== 'string' || typeof name !== 'string')
              throw new OrcaError('path_denied', '保存先が無効です。');
            const created = await port.create(root, name, signal);
            return { state: 'registered', path: created.path };
          }
          case 'coding.orca.register': {
            if (typeof path !== 'string')
              throw new OrcaError('path_denied', '作業場所が無効です。');
            await port.register(path, signal);
            return { state: 'registered', path };
          }
          case 'coding.orca.launch': {
            const fallback = step.args['fallback_agent'];
            if (
              typeof path !== 'string' ||
              (agent !== 'claude' && agent !== 'codex') ||
              typeof step.args['prompt'] !== 'string' ||
              (fallback !== undefined &&
                ((fallback !== 'claude' && fallback !== 'codex') || fallback === agent))
            )
              throw new OrcaError('command_failed', '起動条件が無効です。');
            if ((await port.activeAgents(path, signal)).length)
              throw new OrcaError(
                'command_failed',
                'このプロジェクトでは既にエージェントが動いています。',
              );
            let selected: 'claude' | 'codex' = agent as 'claude' | 'codex';
            if (fallback) {
              const primary = await this.quotaProbe(agent, signal);
              if (primary === 'rate_limited') {
                const alternate = await this.quotaProbe(fallback as 'claude' | 'codex', signal);
                if (alternate !== 'available')
                  throw new OrcaError(
                    'command_failed',
                    alternate === 'rate_limited'
                      ? '選んだエージェントと代替エージェントの両方が利用上限に達しています。'
                      : '代替エージェントの利用状態を確認できません。指示は送っていません。',
                  );
                selected = fallback as 'claude' | 'codex';
              } else if (primary === 'unavailable') {
                throw new OrcaError(
                  'command_failed',
                  '選んだエージェントの利用状態を確認できません。指示は送っていません。',
                );
              }
            }
            const launched = await port.launch(path, selected, step.args['prompt'], signal);
            return {
              state: 'launched',
              terminal: launched.terminal,
              agent: selected,
              path,
              ...(selected !== agent ? { failover: { from: agent, reason: 'rate_limited' } } : {}),
            };
          }
          case 'coding.orca.resume': {
            const query = step.args['query'],
              sessionId = step.args['session_id'];
            if (
              typeof path !== 'string' ||
              (agent !== 'claude' && agent !== 'codex') ||
              typeof query !== 'string' ||
              typeof sessionId !== 'string'
            )
              throw new OrcaError('command_failed', '再開条件が無効です。');
            const discovered = await port.search(path, agent, query, signal);
            if (
              discovered.kind !== 'results' ||
              !discovered.sessions.some((item) => item.sessionId === sessionId)
            )
              throw new OrcaError(
                'command_failed',
                'このプロジェクトのセッションを確認できません。',
              );
            if ((await port.activeAgents(path, signal)).length)
              throw new OrcaError(
                'command_failed',
                'このプロジェクトでは既にエージェントが動いています。',
              );
            const resumed = await port.resume(path, agent, sessionId, signal);
            return { state: 'resumed', terminal: resumed.terminal, agent, path, sessionId };
          }
          default:
            throw new OrcaError('command_failed', '未対応の操作です。');
        }
      };
      return { ok: true, result: await result() };
    } catch (error) {
      return {
        ok: false,
        error: {
          code: `orca.${error instanceof OrcaError ? error.code : 'command_failed'}`,
          message: error instanceof OrcaError ? error.message : 'Orca の操作に失敗しました。',
        },
        ...(error instanceof OrcaError && error.terminal
          ? {
              result: {
                state:
                  error.code === 'workspace_trust_required'
                    ? 'workspace_trust_required'
                    : 'delivery_unconfirmed',
                terminal: error.terminal,
              },
            }
          : {}),
      };
    }
  }

  async #port(): Promise<OrcaPort> {
    const executable = await findOrca();
    if (!executable) throw new OrcaError('not_installed', 'Orca CLI が見つかりません。');
    let roots: unknown;
    try {
      roots = JSON.parse(process.env['ASTRA_ORCA_WORKSPACE_ROOTS'] ?? 'null');
    } catch {
      throw new OrcaError('path_denied', '許可済みの作業場所の設定が無効です。');
    }
    if (
      !Array.isArray(roots) ||
      !roots.length ||
      !roots.every((item) => typeof item === 'string' && isAbsolute(item))
    )
      throw new OrcaError('path_denied', '許可済みの作業場所を設定してください。');
    return new OrcaAdapter({ executable, roots: roots as string[] });
  }
}
