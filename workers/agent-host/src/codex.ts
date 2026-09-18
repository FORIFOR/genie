/** Use the signed-in Codex CLI itself; never read or copy its credentials. */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCommand, type RunCommand, type ClaudeCodeFailure } from './claude-code.js';

export class CodexError extends Error {
  constructor(readonly reason: ClaudeCodeFailure) {
    super(
      {
        not_installed: 'この端末に Codex が見つかりません。',
        not_signed_in: 'Codex にサインインしてください。',
        rate_limited: 'Codex の利用上限に達しました。',
        crashed: 'Codex が応答しませんでした。',
        timed_out: 'Codex が時間内に返しませんでした。',
        unreadable_output: 'Codex の返事を読み取れませんでした。',
      }[reason],
    );
  }
}

export class CodexCli {
  readonly #run: RunCommand;
  constructor(
    readonly config: {
      command?: string;
      model?: string;
      run?: RunCommand;
      timeoutMs?: number;
    } = {},
  ) {
    if (
      config.timeoutMs !== undefined &&
      (!Number.isInteger(config.timeoutMs) ||
        config.timeoutMs < 1_000 ||
        config.timeoutMs > 600_000)
    )
      throw new Error('Codex timeoutMs must be an integer between 1000 and 600000');
    this.#run = config.run ?? runCommand;
  }
  get command(): string {
    return this.config.command ?? 'codex';
  }

  async probe(): Promise<{ available: boolean; version: string | null; reason: string | null }> {
    const version = await this.#run(this.command, ['--version'], { timeoutMs: 10_000 });
    if (version.code !== 0)
      return { available: false, version: null, reason: new CodexError('not_installed').message };
    const auth = await this.#run(this.command, ['login', 'status'], { timeoutMs: 10_000 });
    return {
      available: auth.code === 0,
      version: version.stdout.trim(),
      reason: auth.code === 0 ? null : new CodexError('not_signed_in').message,
    };
  }

  async ask(
    prompt: string,
    options: { images?: readonly string[]; webSearch?: boolean; signal?: AbortSignal } = {},
  ): Promise<unknown> {
    const directory = await mkdtemp(join(tmpdir(), 'astra-codex-'));
    try {
      const args = [
        'exec',
        '--ignore-user-config',
        '--ephemeral',
        '--sandbox',
        'read-only',
        '--skip-git-repo-check',
        '-C',
        directory,
        '--json',
        '-c',
        'approval_policy="never"',
      ];
      // No repository context, shell, connected apps, plugins or secondary agents.
      for (const feature of [
        'shell_tool',
        'apps',
        'plugins',
        'multi_agent',
        'computer_use',
        'browser_use',
        'browser_use_external',
        'in_app_browser',
        'image_generation',
        'view_image',
        'goals',
      ])
        args.push('-c', `features.${feature}=false`);
      args.push('-c', `web_search="${options.webSearch ? 'live' : 'disabled'}"`);
      if (this.config.model) args.push('--model', this.config.model);
      for (const path of options.images ?? []) args.push('--image', path);
      args.push('-');
      const result = await this.#run(this.command, args, {
        input: prompt,
        timeoutMs: this.config.timeoutMs ?? 120_000,
        ...(options.signal ? { signal: options.signal } : {}),
      });
      if (result.code !== 0) {
        const text = result.stderr + result.stdout;
        throw new CodexError(
          result.code === 124
            ? 'timed_out'
            : result.code === null
              ? 'not_installed'
              : /limit|429/i.test(text)
                ? 'rate_limited'
                : /login|auth|401/i.test(text)
                  ? 'not_signed_in'
                  : 'crashed',
        );
      }
      let answer: string | undefined;
      let completed = false;
      for (const line of result.stdout.split('\n').filter(Boolean)) {
        const event = JSON.parse(line) as { type: string; item?: { type: string; text?: string } };
        if (event.type === 'turn.failed' || event.type === 'error') throw new CodexError('crashed');
        if (event.type === 'turn.completed') completed = true;
        if (event.type === 'item.completed' && event.item?.type === 'agent_message')
          answer = event.item.text;
      }
      if (!completed || !answer) throw new CodexError('unreadable_output');
      const body = /^```(?:json)?\s*([\s\S]*?)```\s*$/.exec(answer.trim())?.[1] ?? answer;
      return JSON.parse(body);
    } catch (error) {
      if (error instanceof SyntaxError) throw new CodexError('unreadable_output');
      throw error;
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
}
