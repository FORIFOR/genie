import { mkdtemp, mkdir, realpath, stat, symlink, rm, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { OrcaAdapter, OrcaError, execOrca, type OrcaCommand } from '../src/coding/orca-adapter.js';

describe('OrcaAdapter', () => {
  let root: string;
  let project: string;
  let outside: string;
  const calls: { args: readonly string[]; cwd: string }[] = [];
  const run: OrcaCommand = async (_executable, args, cwd) => {
    calls.push({ args, cwd });
    if (args[0] === 'terminal' && args[1] === 'create')
      return { ok: true, result: { terminal: { handle: 'terminal-1' } } };
    if (args[0] === 'terminal' && args[1] === 'wait')
      return { ok: true, result: { wait: { satisfied: true, status: 'running' } } };
    if (args[0] === 'terminal' && args[1] === 'send')
      return { ok: true, result: { send: { accepted: true } } };
    if (args[0] === 'status')
      return { ok: true, result: { runtime: { reachable: true, state: 'ready' } } };
    if (args[0] === 'search') return { ok: true, result: { kind: 'results', hits: [] } };
    return { ok: true };
  };

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'genie-orca-root-'));
    outside = await mkdtemp(join(tmpdir(), 'genie-orca-out-'));
    project = join(root, 'project');
    await mkdir(project);
    root = await realpath(root);
    project = await realpath(project);
    calls.length = 0;
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });

  const adapter = () => new OrcaAdapter({ executable: '/opt/orca/bin/orca', roots: [root], run });

  it('retains an Orca wait receipt even when its process exits 1', async () => {
    const executable = join(root, 'fake-orca');
    await writeFile(
      executable,
      '#!/bin/sh\nprintf \'%s\\n\' \'{"ok":true,"result":{"wait":{"satisfied":false,"status":"running","blockedReason":"agent-trust-workspace"}}}\'\nexit 1\n',
    );
    await chmod(executable, 0o700);
    await expect(execOrca(executable, ['terminal', 'wait'], root)).resolves.toMatchObject({
      result: { wait: { blockedReason: 'agent-trust-workspace' } },
    });
    await expect(execOrca(executable, ['status'], root)).rejects.toMatchObject({
      code: 'command_failed',
    });
  });

  it('queries status, registers a real workspace, and searches scoped sessions', async () => {
    const client = adapter();
    expect(await client.status()).toEqual({ reachable: true, state: 'ready' });
    await client.register(project);
    expect(await client.search(project, 'claude', 'auth fix')).toEqual({
      kind: 'results',
      sessions: [],
    });
    expect(calls.map((call) => call.args)).toEqual([
      ['status'],
      ['repo', 'add', '--path', project],
      ['search', '--query', 'auth fix', '--agent', 'claude', '--path', project, '--limit', '20'],
    ]);
    expect(calls[1]?.cwd).toBe(project);
  });

  it('launches with the ordinary CLI and sends the prompt separately', async () => {
    const result = await adapter().launch(project, 'codex', 'Implement a parser');
    expect(result).toEqual({ terminal: 'terminal-1' });
    expect(calls.map((call) => call.args)).toEqual([
      [
        'terminal',
        'create',
        '--worktree',
        `path:${project}`,
        '--command',
        'codex --sandbox workspace-write --ask-for-approval on-request',
      ],
      [
        'terminal',
        'wait',
        '--terminal',
        'terminal-1',
        '--for',
        'tui-idle',
        '--timeout-ms',
        '20000',
      ],
      [
        'terminal',
        'send',
        '--terminal',
        'terminal-1',
        '--text',
        'Implement a parser',
        '--enter',
        '--wait-submit',
        '5',
      ],
    ]);
  });

  it('detects a connected writable agent in the exact project', async () => {
    const client = new OrcaAdapter({
      executable: '/opt/orca/bin/orca',
      roots: [root],
      run: async () => ({
        result: {
          terminals: [
            {
              handle: 'active',
              agentIdentity: 'codex',
              worktreePath: project,
              connected: true,
              writable: true,
            },
            {
              handle: 'other',
              agentIdentity: 'claude',
              worktreePath: outside,
              connected: true,
              writable: true,
            },
          ],
        },
      }),
    });
    expect(await client.activeAgents(project)).toEqual(['active']);
  });

  it('retains the opened terminal when prompt delivery is uncertain', async () => {
    const client = new OrcaAdapter({
      executable: '/opt/orca/bin/orca',
      roots: [root],
      run: async (bin, args, cwd) => {
        if (args[1] === 'send') throw new OrcaError('command_failed', 'unknown');
        return run(bin, args, cwd);
      },
    });
    await expect(client.launch(project, 'codex', 'Do work')).rejects.toMatchObject({
      code: 'delivery_unconfirmed',
      terminal: 'terminal-1',
    });
  });

  it('closes a terminal when the agent never reaches an idle prompt', async () => {
    const client = new OrcaAdapter({
      executable: '/opt/orca/bin/orca',
      roots: [root],
      run: async (bin, args, cwd) => {
        if (args[1] === 'wait') {
          calls.push({ args, cwd });
          throw new OrcaError('command_failed', 'not ready');
        }
        return run(bin, args, cwd);
      },
    });
    await expect(client.launch(project, 'claude', 'Do work')).rejects.toMatchObject({
      code: 'command_failed',
    });
    expect(calls.at(-1)?.args).toEqual(['terminal', 'close', '--terminal', 'terminal-1']);
    expect(calls.some((call) => call.args[1] === 'send')).toBe(false);
  });

  it('keeps the terminal open and returns its handle for a folder trust prompt', async () => {
    const client = new OrcaAdapter({
      executable: '/opt/orca/bin/orca',
      roots: [root],
      run: async (bin, args, cwd) => {
        if (args[1] === 'wait') {
          calls.push({ args, cwd });
          return {
            ok: true,
            result: {
              wait: {
                satisfied: false,
                status: 'running',
                blockedReason: 'agent-trust-workspace',
              },
            },
          };
        }
        return run(bin, args, cwd);
      },
    });
    await expect(client.launch(project, 'codex', 'Do work')).rejects.toMatchObject({
      code: 'workspace_trust_required',
      terminal: 'terminal-1',
    });
    expect(calls.some((call) => call.args[1] === 'close')).toBe(false);
    expect(calls.some((call) => call.args[1] === 'send')).toBe(false);
  });

  it('creates a new project only under an allowed root and initializes Git first', async () => {
    const initialized: string[] = [];
    const client = new OrcaAdapter({
      executable: '/opt/orca/bin/orca',
      roots: [root],
      run,
      initGit: async (path) => {
        initialized.push(path);
      },
    });
    const result = await client.create(root, 'new-app');
    expect(result.path).toBe(join(root, 'new-app'));
    expect(initialized).toEqual([result.path]);
    expect(calls[0]?.args).toEqual(['repo', 'add', '--path', result.path]);
    await expect(client.create(outside, 'bad')).rejects.toMatchObject({ code: 'path_denied' });
    await expect(client.create(root, '../escape')).rejects.toMatchObject({ code: 'path_denied' });
  });

  it('initializes a real Git repository before Orca registration', async () => {
    const result = await adapter().create(root, 'real-git');
    expect((await stat(join(result.path, '.git'))).isDirectory()).toBe(true);
    expect(calls[0]?.args).toEqual(['repo', 'add', '--path', result.path]);
    await expect(adapter().create(root, 'real-git')).rejects.toThrow();
  });

  it('resumes with the provider CLI flags without bypass flags', async () => {
    const id = '123e4567-e89b-42d3-a456-426614174000';
    await adapter().resume(project, 'claude', id);
    expect(calls[0]?.args).toEqual([
      'terminal',
      'create',
      '--worktree',
      `path:${project}`,
      '--command',
      `claude --permission-mode manual --resume ${id}`,
    ]);
    expect(calls[1]?.args).toEqual([
      'terminal',
      'wait',
      '--terminal',
      'terminal-1',
      '--for',
      'tui-idle',
      '--timeout-ms',
      '20000',
    ]);
  });

  it('returns only same-project session metadata, never transcript evidence', async () => {
    const id = '123e4567-e89b-42d3-a456-426614174000';
    const client = new OrcaAdapter({
      executable: '/opt/orca/bin/orca',
      roots: [root],
      run: async () => ({
        ok: true,
        result: {
          kind: 'results',
          hits: [
            {
              agent: 'codex',
              cwd: project,
              sessionId: id,
              updatedAt: '2026-11-17T00:00:00Z',
              messageCount: 2,
              evidence: 'private transcript',
              resumeCommand: 'unsafe command',
            },
            {
              agent: 'codex',
              cwd: outside,
              sessionId: id,
              updatedAt: '2026-11-17T00:00:00Z',
              messageCount: 3,
            },
          ],
        },
      }),
    });
    expect(await client.search(project, 'codex', 'auth')).toEqual({
      kind: 'results',
      sessions: [
        {
          agent: 'codex',
          cwd: project,
          sessionId: id,
          updatedAt: '2026-11-17T00:00:00Z',
          messageCount: 2,
        },
      ],
    });
  });

  it('rejects symlinks outside the configured roots and malformed resume ids', async () => {
    const link = join(root, 'escape');
    await symlink(outside, link);
    await expect(adapter().register(link)).rejects.toMatchObject({ code: 'path_denied' });
    await expect(adapter().resume(project, 'codex', 'x; rm -rf /')).rejects.toBeInstanceOf(
      OrcaError,
    );
    expect(calls).toEqual([]);
  });
});
