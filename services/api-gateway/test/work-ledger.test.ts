/**
 * 仕事の台帳（work-ledger.ts）と、Claude Code のセッションの印（agent-sessions.ts の marksFor）の DB を使わない部分。
 *
 * 見ること:
 *   - 印は種類だけ。同じ待ちが重ねて届いても 1 回。機械の知らせは本人の指示に数えない
 *   - テストで確かめる完了条件は、最後のテストが通ったときだけ満たす。失敗は「満たしていない」
 *   - 自動で確かめられない条件は、本人が確かめたと言うまで「未確認」。満たすまで「終わった」と言わない
 *   - チャット向けの答えに Claude Code の頼みの頭を出さない
 *   - Genie の仕事は、承認・途中の指示を判断として並べる
 */
import { describe, expect, it } from 'vitest';
import type { Task, TaskInstruction } from '@genie/contracts';
import {
  marksFor,
  type AgentSession,
  type HookEvent,
  type MarkKind,
} from '../src/agent-sessions.js';
import {
  composeSessionLedger,
  composeTaskLedger,
  speakLedger,
  splitCriteria,
  type CriterionRow,
} from '../src/work-ledger.js';

const TZ = 'Asia/Tokyo';
// 2026-10-29（木）10:00 JST
const NOW = Date.parse('2026-10-29T01:00:00Z');
const at = (min: number) => new Date(NOW + min * 60_000);

const session = (over: Partial<AgentSession>): AgentSession => ({
  id: 's',
  source: 'claude_code',
  externalSessionId: 'x',
  project: 'genie',
  title: '決済の秘密の仕様を直して',
  state: 'idle',
  waitingReason: null,
  userPolicy: 'watch',
  lastEvent: 'Stop',
  lastActivityAt: at(-1),
  stateSince: at(-1),
  heldBy: null,
  checkState: 'none',
  endedAt: null,
  endReason: null,
  createdAt: at(-60),
  ...over,
});

const prev = (over: Partial<Parameters<typeof marksFor>[1] & object> = {}) => ({
  state: 'working' as const,
  waitingReason: null,
  checkState: 'none' as const,
  title: '直して',
  ...over,
});
const ev = (event: string, over: Partial<HookEvent> = {}): HookEvent => ({
  event,
  sessionId: 'x',
  ...over,
});

describe('session marks', () => {
  it('tells the first request from later instructions, and skips machine prompts', () => {
    expect(
      marksFor(
        ev('UserPromptSubmit', { prompt: '直して' }),
        null,
        { state: 'working', waitingReason: null },
        null,
      ),
    ).toEqual(['request']);
    expect(
      marksFor(
        ev('UserPromptSubmit', { prompt: 'やっぱり B で' }),
        prev(),
        { state: 'working', waitingReason: null },
        null,
      ),
    ).toEqual(['instruction']);
    expect(
      marksFor(
        ev('UserPromptSubmit', { prompt: '<task-notification>\n<id>1</id>' }),
        prev(),
        { state: 'working', waitingReason: null },
        null,
      ),
    ).toEqual([]);
  });

  it('marks a wait once, however many times it is repeated', () => {
    const waiting = { state: 'waiting_user' as const, waitingReason: 'permission' };
    expect(marksFor(ev('PermissionRequest'), prev(), waiting, null)).toEqual([
      'waiting_permission',
    ]);
    expect(
      marksFor(
        ev('Notification'),
        prev({ state: 'waiting_user', waitingReason: 'permission' }),
        waiting,
        null,
      ),
    ).toEqual([]);
  });

  it('marks a change once until it is checked, and every test run', () => {
    const working = { state: 'working' as const, waitingReason: null };
    expect(marksFor(ev('PostToolUse', { toolName: 'Edit' }), prev(), working, 'changed')).toEqual([
      'changed',
    ]);
    expect(
      marksFor(
        ev('PostToolUse', { toolName: 'Write' }),
        prev({ checkState: 'changed' }),
        working,
        'changed',
      ),
    ).toEqual([]);
    expect(
      marksFor(
        ev('PostToolUse', { toolName: 'Edit' }),
        prev({ checkState: 'passed' }),
        working,
        'changed',
      ),
    ).toEqual(['changed']);
    expect(
      marksFor(
        ev('PostToolUse', { toolName: 'Bash', command: 'pnpm test' }),
        prev(),
        working,
        'passed',
      ),
    ).toEqual(['test_passed']);
    expect(
      marksFor(
        ev('PostToolUseFailure', { toolName: 'Bash', command: 'npx vitest run' }),
        prev(),
        working,
        'failed',
      ),
    ).toEqual(['test_failed']);
    expect(
      marksFor(ev('PostToolUse', { toolName: 'Bash', command: 'ls' }), prev(), working, null),
    ).toEqual([]);
  });

  it('marks the end of a response only when it was working', () => {
    const idle = { state: 'idle' as const, waitingReason: null };
    expect(marksFor(ev('Stop'), prev(), idle, null)).toEqual(['turn_ended']);
    expect(marksFor(ev('Stop'), prev({ state: 'idle' }), idle, null)).toEqual([]);
    expect(
      marksFor(
        ev('SessionEnd'),
        prev({ state: 'idle' }),
        { state: 'ended', waitingReason: null },
        null,
      ),
    ).toEqual(['ended']);
  });
});

const tests = (text = 'テストが通る'): CriterionRow => ({
  id: 'c1',
  text,
  kind: 'tests',
  metAt: null,
});
const manual = (text: string, metAt: Date | null = null): CriterionRow => ({
  id: `m-${text}`,
  text,
  kind: 'manual',
  metAt,
});

const ledgerOf = (
  s: Partial<AgentSession>,
  marks: { kind: MarkKind; at: Date }[],
  criteria: CriterionRow[],
  holdSubject: string | null = null,
) =>
  composeSessionLedger({
    session: session(s),
    marks,
    criteria,
    holdSubject,
    now: NOW,
    tz: TZ,
  });

describe('a Claude Code session ledger', () => {
  it('meets a tests criterion only when the last test passed', () => {
    const passed = ledgerOf(
      { checkState: 'passed' },
      [{ kind: 'test_passed', at: at(-5) }],
      [tests()],
    );
    expect(passed.criteria[0]).toMatchObject({
      state: 'met',
      how: '10/29 9:55 にテストが通りました',
    });
    expect(passed.next).toBe('完了条件はすべて満たしています。');

    const failed = ledgerOf(
      { checkState: 'failed' },
      [{ kind: 'test_failed', at: at(-5) }],
      [tests()],
    );
    expect(failed.criteria[0]?.state).toBe('unmet');
    expect(failed.next).toBe(
      '「テストが通る」を満たしていません（10/29 9:55 のテストが失敗しています）。',
    );

    // 変えたあとテストしていなければ、前に通っていても満たしたとは言わない
    const changed = ledgerOf(
      { checkState: 'changed' },
      [
        { kind: 'test_passed', at: at(-20) },
        { kind: 'changed', at: at(-5) },
      ],
      [tests()],
    );
    expect(changed.criteria[0]).toMatchObject({
      state: 'unchecked',
      how: '変えたあと、まだテストを走らせていません',
    });
  });

  it('does not call it finished while a criterion it cannot check is unconfirmed', () => {
    const l = ledgerOf(
      { checkState: 'passed' },
      [{ kind: 'test_passed', at: at(-5) }],
      [tests(), manual('LINE に届く')],
    );
    expect(l.criteria.map((c) => c.state)).toEqual(['met', 'unchecked']);
    expect(l.next).toBe(
      '「LINE に届く」は自動では確かめられません。確かめたら「genieの完了条件は確かめた」と言ってください。',
    );
    const confirmed = ledgerOf(
      { checkState: 'passed' },
      [{ kind: 'test_passed', at: at(-5) }],
      [tests(), manual('LINE に届く', at(-1))],
    );
    expect(confirmed.next).toBe('完了条件はすべて満たしています。');
  });

  it('says what is needed next by the state first', () => {
    expect(
      ledgerOf({ state: 'waiting_user', waitingReason: 'permission' }, [], [tests()]).next,
    ).toBe(
      '承認を待っています。Claude Code にはターミナルで答えてください（Genie からは押しません）。',
    );
    expect(ledgerOf({ heldBy: 'h', userPolicy: 'paused_by_user' }, [], [], 'デザイン').next).toBe(
      '保留中なので進めません。進めるときは「デザインの保留を解除して」と言ってください。',
    );
    expect(ledgerOf({}, [], []).next).toBe(
      '完了条件がまだありません。「genieの完了条件は〇〇」と言えば、それに照らして確かめます。',
    );
  });

  it('keeps the request head off the spoken answer', () => {
    const l = ledgerOf(
      { checkState: 'passed' },
      [
        { kind: 'request', at: at(-30) },
        { kind: 'changed', at: at(-20) },
        { kind: 'test_passed', at: at(-5) },
        { kind: 'turn_ended', at: at(-4) },
      ],
      [tests()],
    );
    expect(l.request).toBe('決済の秘密の仕様を直して');
    const spoken = speakLedger(l, TZ);
    expect(spoken).not.toContain('決済');
    expect(spoken.split('\n')).toEqual([
      'Claude Code（genie）: 変えたあと、テストが通っています。',
      '完了条件:',
      '・済「テストが通る」（10/29 9:55 にテストが通りました）',
      '最近の経過: 10/29 9:30 頼まれました、10/29 9:40 ファイルを変えました、10/29 9:55 テストが通りました、10/29 9:56 応答を終えました',
      '次: 完了条件はすべて満たしています。',
    ]);
  });
});

describe('a Genie task ledger', () => {
  const task = (over: Partial<Task>): Task =>
    ({
      id: '00000000-0000-7000-8000-000000000001',
      tenant_id: '00000000-0000-7000-8000-000000000002',
      created_by: '00000000-0000-7000-8000-000000000003',
      conversation_id: null,
      kind: 'generic',
      title: '請求書の整理',
      status: 'COMPLETED',
      input: { message: '先月の請求書をフォルダに分けて' },
      result_artifact_id: null,
      error: null,
      created_at: at(-60).toISOString(),
      started_at: at(-59).toISOString(),
      completed_at: at(-10).toISOString(),
      updated_at: at(-10).toISOString(),
      ...over,
    }) as Task;
  const instruction = (
    text: string,
    status: TaskInstruction['status'],
    min: number,
  ): TaskInstruction => ({
    task_id: '00000000-0000-7000-8000-000000000001' as never,
    request_id: '00000000-0000-7000-8000-000000000009',
    text,
    status,
    applied_step_index: status === 'APPLIED' ? 1 : null,
    created_at: at(min).toISOString(),
    resolved_at: null,
  });

  it('lists the request, the user decisions in order, and the outputs', () => {
    const l = composeTaskLedger({
      task: task({}),
      instructions: [instruction('PDF だけにして', 'APPLIED', -40)],
      approvals: [
        { summary: 'フォルダを作る', status: 'APPROVED', createdAt: at(-50), decidedAt: at(-45) },
      ],
      artifacts: [{ id: 'a1', title: '整理の記録' }],
      criteria: [],
      tz: TZ,
    });
    expect(l.request).toBe('先月の請求書をフォルダに分けて');
    expect(l.decisions.map((d) => d.text)).toEqual([
      '「フォルダを作る」: 承認しました',
      '途中の指示「PDF だけにして」: 反映しました',
    ]);
    expect(l.verification).toBe('終わりました。成果物が 1 件あります');
    expect(l.next).toBe('終わりました。');
  });

  it('does not say a finished task is done while its criteria are unconfirmed', () => {
    const l = composeTaskLedger({
      task: task({}),
      instructions: [],
      approvals: [],
      artifacts: [],
      criteria: [manual('経理に共有する')],
      tz: TZ,
    });
    expect(l.criteria[0]?.state).toBe('unchecked');
    expect(l.next).toBe(
      '「経理に共有する」は自動では確かめられません。確かめたら「請求書の整理の完了条件は確かめた」と言ってください。',
    );
  });
});

describe('criteria words', () => {
  it('splits a spoken list into criteria', () => {
    expect(splitCriteria('テストが通ること、LINE に届くこと。')).toEqual([
      'テストが通る',
      'LINE に届く',
    ]);
    expect(splitCriteria('PR が作られていること')).toEqual(['PR が作られている']);
  });
});
