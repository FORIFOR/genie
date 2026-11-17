/**
 * 仕事の見通し（work-desk.ts・work-holds.ts）と、Claude Code の確かめ（agent-sessions.ts）の DB を使わない部分。
 *
 * 見ること:
 *   - 返事が要るものを先に言い、推した状態（止まっているかも・分からない）は推したと言う
 *   - 応答を終えただけのセッションを「確かめ済み」と言わない（変えたあとテストが通ったときだけ）
 *   - 何も届かなくなったセッションを「終わった」と数えない
 *   - 保留は「進めません」と言う。Claude Code の頼みの頭は出さない
 *   - 「来週まで」「11/5 まで」「金曜まで」を日付にする
 *   - Edit のあとはテストが通るまで changed。テストの失敗は failed
 */
import { describe, expect, it } from 'vitest';
import type { TaskListItem } from '@genie/contracts';
import {
  STALL_AFTER_MS,
  UNKNOWN_AFTER_MS,
  checkFor,
  isTestCommand,
  type AgentSession,
} from '../src/agent-sessions.js';
import { STATUS, composeOverview } from '../src/work-desk.js';
import { holdUntil, matchesHold } from '../src/work-holds.js';

const TZ = 'Asia/Tokyo';
// 2026-10-29（木）10:00 JST
const NOW = Date.parse('2026-10-29T01:00:00Z');

const session = (over: Partial<AgentSession>): AgentSession => ({
  id: 's',
  source: 'claude_code',
  externalSessionId: 'x',
  project: 'genie',
  title: '決済の秘密の仕様を直して',
  state: 'working',
  waitingReason: null,
  userPolicy: 'watch',
  lastEvent: 'PostToolUse',
  lastActivityAt: new Date(NOW - 60_000),
  stateSince: new Date(NOW - 60_000),
  heldBy: null,
  checkState: 'none',
  endedAt: null,
  endReason: null,
  createdAt: new Date(NOW - 3600_000),
  ...over,
});

const task = (over: Partial<TaskListItem>): TaskListItem =>
  ({
    id: '00000000-0000-7000-8000-000000000001',
    tenant_id: '00000000-0000-7000-8000-000000000002',
    created_by: '00000000-0000-7000-8000-000000000003',
    conversation_id: null,
    kind: 'generic',
    title: '請求書の整理',
    status: 'RUNNING',
    input: {},
    result_artifact_id: null,
    error: null,
    created_at: new Date(NOW - 600_000).toISOString(),
    started_at: null,
    completed_at: null,
    updated_at: new Date(NOW - 60_000).toISOString(),
    current_step: null,
    ...over,
  }) as TaskListItem;

const overview = (input: Partial<Parameters<typeof composeOverview>[0]>) =>
  composeOverview({
    tasks: [],
    sessions: [],
    holds: [],
    schedules: [],
    followups: [],
    now: NOW,
    tz: TZ,
    ...input,
  });

describe('the work overview', () => {
  // 締切の近い「やること」も、確かめてほしいものとして先に出す
  it('puts deadlines that have passed or are close among what needs the user', () => {
    const o = overview({
      deadlines: ['やること「見積書を出す」は今日が締切です'],
      tasks: [task({})],
    });
    const lines = o.text.split('\n');
    expect(lines[0]).toBe('いま確かめてほしいのは 1 件です。');
    expect(lines[1]).toBe('・やること「見積書を出す」は今日が締切です');
    expect(o.counts.needsUser).toBe(1);
  });

  it('says what needs the user first, then what is moving', () => {
    const o = overview({
      sessions: [
        session({ id: 'a', project: 'api' }),
        session({
          id: 'b',
          state: 'waiting_user',
          waitingReason: 'permission',
          stateSince: new Date(NOW - 12 * 60_000),
        }),
      ],
      tasks: [task({ status: 'WAITING_APPROVAL', title: '旅程の予約' }), task({})],
    });
    const lines = o.text.split('\n');
    expect(lines[0]).toBe('いま確かめてほしいのは 2 件です。');
    expect(lines[1]).toBe('・Claude Code（genie）が承認を待っています（12 分前から）');
    expect(lines[2]).toBe('・「旅程の予約」があなたの承認を待っています');
    expect(lines[3]).toBe('動いているもの（2 件）: Claude Code（api）、「請求書の整理」');
    expect(o.counts).toMatchObject({ needsUser: 2, running: 2 });
    // Claude Code の頼みの頭は出さない（チャットを通るため）
    expect(o.text).not.toContain('決済');
  });

  it('marks a quiet session as a guess, and a silent one as unknown rather than finished', () => {
    const o = overview({
      sessions: [
        session({ id: 'a', lastActivityAt: new Date(NOW - STALL_AFTER_MS - 60_000) }),
        session({
          id: 'b',
          project: 'api',
          lastActivityAt: new Date(NOW - UNKNOWN_AFTER_MS - 60_000),
        }),
      ],
    });
    expect(o.text).toContain(
      'Claude Code（genie）は 16 分動きがありません（止まっているかもしれません。推測です）',
    );
    expect(o.text).toContain(
      'いまの状態が分からないもの: Claude Code（api）（終わったとは数えていません）',
    );
    expect(o.counts).toMatchObject({ running: 0, doneToday: 0, suspected: 1 });
  });

  it('only calls a finished response checked when tests passed after the change', () => {
    const idle = (checkState: AgentSession['checkState'], project: string) =>
      session({ id: project, project, state: 'idle', checkState });
    const o = overview({
      sessions: [idle('passed', 'a'), idle('changed', 'b'), idle('none', 'c'), idle('failed', 'd')],
    });
    expect(o.text).toContain('Claude Code（a）（テストが通っています）');
    expect(o.text).toContain('Claude Code（b）（変更をまだテストで確かめていません）');
    expect(o.text).toContain('Claude Code（c）（応答を終えました）');
    // 最後のテストが失敗したものは「終わった」ではなく、確かめてほしいもの
    expect(o.attention).toEqual([
      'Claude Code（d）は応答を終えましたが、最後のテストが失敗しています',
    ]);
  });

  it('lists holds as things it will not move, and a held session is not reported as waiting', () => {
    const o = overview({
      sessions: [
        session({
          state: 'waiting_user',
          waitingReason: 'permission',
          heldBy: 'h',
          userPolicy: 'paused_by_user',
        }),
      ],
      holds: [
        {
          id: 'h',
          subject: 'デザイン',
          reason: null,
          untilDate: '2026-11-02',
          createdAt: new Date(NOW),
        },
      ],
    });
    expect(o.counts.needsUser).toBe(0);
    expect(o.text).toContain('保留中（進めません）: デザイン（11/2（月）まで）');
  });

  it('says plainly when nothing is going on', () => {
    expect(overview({}).text).toBe('いま動いている仕事も、待っているものもありません。');
  });

  it('hears the usual ways of asking', () => {
    for (const asked of [
      '今の作業どうなってる？',
      'いまの仕事の状況を教えて',
      '今日の作業を教えて',
      '止まってる仕事は？',
      'タスクの進捗',
      '保留中のものは？',
    ])
      expect(STATUS.test(asked), asked).toBe(true);
    expect(STATUS.test('今日の天気を教えて')).toBe(false);
  });
});

describe('hold dates', () => {
  // 2026-10-29 は木曜
  it('reads relative and absolute dates in the user time zone', () => {
    expect(holdUntil('来週', NOW, TZ)).toBe('2026-11-02');
    expect(holdUntil('再来週', NOW, TZ)).toBe('2026-11-09');
    expect(holdUntil('明日', NOW, TZ)).toBe('2026-10-30');
    expect(holdUntil('11/5', NOW, TZ)).toBe('2026-11-05');
    expect(holdUntil('11月5日', NOW, TZ)).toBe('2026-11-05');
    expect(holdUntil('1/10', NOW, TZ)).toBe('2027-01-10');
    expect(holdUntil('金曜', NOW, TZ)).toBe('2026-10-30');
    expect(holdUntil('木曜', NOW, TZ)).toBe('2026-11-05');
    expect(holdUntil('来週の水曜', NOW, TZ)).toBe('2026-11-04');
    expect(holdUntil('来週水曜', NOW, TZ)).toBe('2026-11-04');
    expect(holdUntil('今週末', NOW, TZ)).toBe('2026-10-31');
    expect(holdUntil('来月', NOW, TZ)).toBe('2026-11-01');
    expect(holdUntil('そのうち', NOW, TZ)).toBeUndefined();
  });

  it('matches a hold by name without caring about case', () => {
    expect(matchesHold('Genie', ['genie-ios'])).toBe(true);
    expect(matchesHold('デザイン', ['実装を進めて'])).toBe(false);
  });
});

describe('checking finished work', () => {
  const post = (toolName: string, command?: string, failed = false) => ({
    event: failed ? 'PostToolUseFailure' : 'PostToolUse',
    sessionId: 'x',
    toolName,
    ...(command ? { command } : {}),
  });

  it('marks a change as unchecked until a test passes, and remembers a failing test', () => {
    expect(checkFor(post('Edit'), 'none')).toBe('changed');
    expect(checkFor(post('Write'), 'passed')).toBe('changed');
    expect(checkFor(post('Bash', 'pnpm -s --filter api test'), 'changed')).toBe('passed');
    expect(checkFor(post('Bash', 'npx vitest run', true), 'changed')).toBe('failed');
    // テスト以外のコマンドや読むだけの道具では変えない
    expect(checkFor(post('Bash', 'ls -la'), 'changed')).toBeNull();
    expect(checkFor(post('Read'), 'changed')).toBeNull();
    // 失敗した Edit は変更に数えない
    expect(checkFor(post('Edit', undefined, true), 'none')).toBeNull();
  });

  it('knows common test commands', () => {
    for (const c of [
      'swift test --filter X',
      'cd services/api && npx vitest run test/a.test.ts',
      'pytest -q',
      './scripts/verify-all.sh',
      'go test ./...',
      'node --test scripts/tests',
    ])
      expect(isTestCommand(c), c).toBe(true);
    for (const c of ['git status', 'cat test.txt', 'echo latest'])
      expect(isTestCommand(c), c).toBe(false);
  });
});
