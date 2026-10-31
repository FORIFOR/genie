/**
 * エージェントの共通の窓口（src/agent-adapters.ts）と発見（src/agent-discovery.ts）の読み取り。
 * Codex は実物がまだ無いので、形は写しで見ている（実機では未確認）。
 */
import { describe, expect, it } from 'vitest';
import { chmod, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ClaudeCodeAdapter,
  parseClaudeResult,
  parseCodexResult,
  RunClock,
} from '../src/agent-adapters.js';
import { eventsFor, parseCodexRollout } from '../src/agent-discovery.js';
import { artifactPath, failureSignature } from '../src/agent-jobs.js';

const done = (stdout: string, over: Partial<Parameters<typeof parseClaudeResult>[0]> = {}) => ({
  stdout,
  exitCode: 0,
  timedOut: false,
  missing: false,
  ...over,
});
const claude = (over: Record<string, unknown>) =>
  JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
    session_id: 's',
    num_turns: 2,
    total_cost_usd: 0.1,
    permission_denials: [],
    ...over,
  });

describe('parseClaudeResult', () => {
  it('reads the outcome, cost and turns of the real result shape', () => {
    expect(parseClaudeResult(done(claude({})))).toMatchObject({
      outcome: 'success',
      sessionId: 's',
      costUsd: 0.1,
      turns: 2,
      permissionDenied: false,
    });
    expect(
      parseClaudeResult(done(claude({ permission_denials: [{ tool_name: 'Bash' }] })))
        .permissionDenied,
    ).toBe(true);
  });

  it('tells limits, passing trouble, errors and crashes apart', () => {
    const outcome = (d: ReturnType<typeof done>) => parseClaudeResult(d).outcome;
    expect(outcome(done(claude({ subtype: 'error_max_turns', is_error: true })))).toBe(
      'limit_turns',
    );
    expect(outcome(done(claude({ subtype: 'error_max_budget_usd', is_error: true })))).toBe(
      'limit_cost',
    );
    expect(
      outcome(
        done(
          claude({
            subtype: 'error_during_execution',
            is_error: true,
            result: 'API Error: 529 overloaded',
          }),
        ),
      ),
    ).toBe('transient');
    expect(
      outcome(done(claude({ subtype: 'error_during_execution', is_error: true, result: 'boom' }))),
    ).toBe('error');
    expect(outcome(done('not json', { exitCode: 1 }))).toBe('crashed');
    expect(outcome(done('', { timedOut: true, exitCode: null }))).toBe('limit_time');
    expect(outcome(done('', { missing: true, exitCode: null }))).toBe('unavailable');
  });
});

describe('parseCodexResult', () => {
  const lines = (...events: object[]) => events.map((e) => JSON.stringify(e)).join('\n');

  it('never invents a cost', () => {
    const result = parseCodexResult(
      done(
        lines(
          { type: 'thread.started', thread_id: 't1' },
          { type: 'turn.completed', usage: { input_tokens: 9 } },
        ),
      ),
    );
    expect(result).toMatchObject({ outcome: 'success', sessionId: 't1', turns: 1, costUsd: null });
  });

  it('tells failures apart', () => {
    expect(
      parseCodexResult(done(lines({ type: 'turn.failed', error: { message: 'rate limit' } })))
        .outcome,
    ).toBe('transient');
    expect(parseCodexResult(done(lines({ type: 'error', message: 'bad' }))).outcome).toBe('error');
    expect(parseCodexResult(done('', { exitCode: 1 })).outcome).toBe('crashed');
  });
});

describe('finding Codex sessions', () => {
  const head = [
    {
      type: 'session_meta',
      payload: { id: 'cx-1', cwd: '/Users/taro/p', instructions: 'secret-ish' },
    },
    { type: 'event_msg', payload: { type: 'user_message', message: 'テストを直して' } },
  ]
    .map((l) => JSON.stringify(l))
    .join('\n');
  const tail = (...kinds: string[]) =>
    `{"cut off line\n${kinds.map((type) => JSON.stringify({ type: 'event_msg', payload: { type } })).join('\n')}`;

  it('reads only the session, folder, first request and state', () => {
    expect(parseCodexRollout(head, tail('task_started', 'exec_command_begin'))).toEqual({
      sessionId: 'cx-1',
      cwd: '/Users/taro/p',
      prompt: 'テストを直して',
      state: 'working',
    });
    expect(parseCodexRollout(head, tail('exec_approval_request'))?.state).toBe('waiting_user');
    expect(parseCodexRollout(head, tail('task_started', 'task_complete'))?.state).toBe('idle');
    expect(parseCodexRollout('{"type":"other"}', '')).toBeNull();
  });

  it('turns the state into the same events hooks send', () => {
    const found = parseCodexRollout(head, tail('task_complete'))!;
    expect(eventsFor(found, true).map((e) => e.event)).toEqual([
      'SessionStart',
      'UserPromptSubmit',
      'Stop',
    ]);
    expect(eventsFor(found, false).map((e) => e.event)).toEqual(['Stop']);
  });
});

describe('RunClock with a real process', () => {
  const sleeper = async () => {
    const dir = await mkdtemp(join(tmpdir(), 'run-clock-'));
    const bin = join(dir, 'fake-agent');
    await writeFile(
      bin,
      '#!/bin/sh\nsleep 0.6\necho \'{"type":"result","subtype":"success","is_error":false,"session_id":"s"}\'\n',
    );
    await chmod(bin, 0o755);
    return { adapter: new ClaudeCodeAdapter({ bin }), cwd: dir };
  };
  const base = { prompt: 'x', sessionId: 's', resumeSessionId: null, maxTurns: 1, maxCostUsd: 1 };

  it('kills the process at the limit', async () => {
    const { adapter, cwd } = await sleeper();
    const result = await adapter.run({ ...base, cwd, clock: new RunClock(100) });
    expect(result.outcome).toBe('limit_time');
  });

  it('does not count the time it is paused', async () => {
    const { adapter, cwd } = await sleeper();
    const clock = new RunClock(100);
    const run = adapter.run({ ...base, cwd, clock });
    clock.pause();
    expect((await run).outcome).toBe('success');
    expect(clock.pausedMs).toBeGreaterThan(400);
  });
});

describe('small rules', () => {
  it('keeps artifacts inside the project', () => {
    expect(artifactPath('/p', 'dist/a.txt')).toBe('/p/dist/a.txt');
    expect(artifactPath('/p', '../x')).toBeNull();
    expect(artifactPath('/p', '/etc/passwd')).toBeNull();
    expect(artifactPath('/p', '.')).toBeNull();
  });

  it('treats runs that differ only in numbers as the same failure', () => {
    expect(failureSignature(['tests', 'failed in 12ms at 10:01'])).toBe(
      failureSignature(['tests', 'failed in 98ms at 10:44']),
    );
    expect(failureSignature(['tests', 'a is wrong'])).not.toBe(
      failureSignature(['tests', 'b is wrong']),
    );
  });
});
