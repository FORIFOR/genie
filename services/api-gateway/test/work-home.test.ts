/**
 * 仕事のホーム（work-home.ts）の DB を使わない部分。
 *
 * 見ること:
 *   - 確認が必要なもの → 動いているもの → 静かなもの → 終わったもの の順に並べる
 *   - 最後のテストが失敗したセッションは、応答を終えていても「確認が必要」に入る
 *   - Claude Code の頼みの頭はページに出さない（名前はフォルダ名、台帳の request も落とす）
 *   - LIFF の ID があれば計画ボードと同じ入口を /w/ で、無ければ公開の先頭の直のリンク
 *   - 「仕事のホームを開いて」「マイページ」を聞き取り、ほかの話は取らない
 */
import { describe, expect, it } from 'vitest';
import type { TaskListItem } from '@genie/contracts';
import type { AgentSession } from '../src/agent-sessions.js';
import { OPEN_HOME } from '../src/work-desk.js';
import { composeHome, ledgerForPage, workUrlFor } from '../src/work-home.js';
import type { Ledger } from '../src/work-ledger.js';

const NOW = Date.parse('2026-10-29T01:00:00Z');
const at = (min: number) => new Date(NOW + min * 60_000);

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
  lastActivityAt: at(-1),
  stateSince: at(-1),
  heldBy: null,
  checkState: 'none',
  endedAt: null,
  endReason: null,
  createdAt: at(-60),
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
    created_at: at(-30).toISOString(),
    started_at: null,
    completed_at: null,
    updated_at: at(-2).toISOString(),
    current_step: null,
    ...over,
  }) as TaskListItem;

const home = (over: { sessions?: AgentSession[]; tasks?: TaskListItem[] }) =>
  composeHome({
    tasks: over.tasks ?? [],
    sessions: over.sessions ?? [],
    holds: [],
    schedules: [],
    followups: [],
    now: NOW,
    tz: 'Asia/Tokyo',
  });

describe('the work home', () => {
  it('puts what needs the user first, then what is moving, then the quiet and the finished', () => {
    const h = home({
      sessions: [
        session({
          id: 'done',
          project: 'a',
          state: 'idle',
          checkState: 'passed',
          lastActivityAt: at(-3),
        }),
        session({
          id: 'failed',
          project: 'b',
          state: 'idle',
          checkState: 'failed',
          lastActivityAt: at(-50),
        }),
        session({ id: 'quiet', project: 'c', lastActivityAt: at(-20) }),
        session({ id: 'moving', project: 'd' }),
      ],
      tasks: [task({ id: 'approve' as never, title: '旅程の予約', status: 'WAITING_APPROVAL' })],
    });
    expect(h.items.map((i) => [i.name, i.state])).toEqual([
      ['旅程の予約', 'あなたの承認を待っています'],
      ['Claude Code（b）', '応答を終えました・最後のテストが失敗'],
      ['Claude Code（d）', '作業中'],
      ['Claude Code（c）', '止まっているかも（推測）'],
      ['Claude Code（a）', '応答を終えました・テストが通っています'],
    ]);
    expect(h.counts).toEqual({ running: 1, needsUser: 2, doneToday: 1 });
    expect(JSON.stringify(h)).not.toContain('決済');
  });

  it('drops the Claude Code request head from a ledger shown on the page', () => {
    const l = {
      subject: { kind: 'agent_session', id: 's' },
      request: '決済の秘密の仕様を直して',
    } as unknown as Ledger;
    expect(ledgerForPage(l).request).toBeNull();
    const t = {
      subject: { kind: 'task', id: 't' },
      request: '請求書を分けて',
    } as unknown as Ledger;
    expect(ledgerForPage(t).request).toBe('請求書を分けて');
  });

  it('links through the board LIFF entry when there is one', () => {
    const token = 'T'.repeat(32);
    expect(workUrlFor({ publicUrl: 'https://x.example', liffId: '1234-abcd' })(token)).toBe(
      `https://liff.line.me/1234-abcd/w/${token}`,
    );
    expect(workUrlFor({ publicUrl: 'https://x.example', liffId: null })(token)).toBe(
      `https://x.example/v1/channels/work/${token}`,
    );
    expect(workUrlFor({ publicUrl: null, liffId: null })(token)).toBeNull();
  });

  it('hears the ways of asking for the home, and nothing else', () => {
    for (const asked of [
      '仕事のホームを開いて',
      'マイページ',
      'ホームを見せて',
      'タスク一覧を見せて',
      '仕事の一覧を開いて',
    ])
      expect(OPEN_HOME.test(asked), asked).toBe(true);
    for (const other of [
      'ホームページを作って',
      '今の作業どうなってる？',
      'マイページのデザインを直して',
    ])
      expect(OPEN_HOME.test(other), other).toBe(false);
  });
});
