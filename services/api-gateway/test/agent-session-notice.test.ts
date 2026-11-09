/**
 * 見守りの知らせの文（noticeFor）。別の PC のセッションは、その PC の名前を入れ、そこのターミナルを指す。
 */
import { describe, expect, it } from 'vitest';
import type { AgentSession } from '../src/agent-sessions.js';
import { noticeFor } from '../src/agent-session-watch.js';

const at = new Date('2026-11-09T10:00:00Z');
const session = (over: Partial<AgentSession> = {}): AgentSession => ({
  id: 's',
  source: 'claude_code',
  externalSessionId: 'e',
  project: 'genie',
  title: null,
  state: 'idle',
  waitingReason: null,
  userPolicy: 'watch',
  lastEvent: 'Stop',
  lastActivityAt: at,
  stateSince: at,
  heldBy: null,
  checkState: 'none',
  endedAt: null,
  endReason: null,
  createdAt: at,
  ...over,
});
const later = at.getTime() + 2 * 60_000;
const turn = { asked: true, changed: true, testPassed: true, testFailed: false };

describe('知らせの文', () => {
  it('この Mac のセッションは、いままでどおり Mac のターミナルを指す', () => {
    expect(noticeFor(session(), later, turn)?.chat).toBe(
      '✅ Claude Code（genie）が作業を終えました（変更あり・テストは通っています）。結果を Mac のターミナルで確かめてください。',
    );
  });

  it('別の PC のセッションは、その PC の名前を入れる', () => {
    expect(noticeFor(session(), later, turn, 'MacBook Air')?.chat).toBe(
      '✅ Claude Code（genie・MacBook Air）が作業を終えました（変更あり・テストは通っています）。結果を MacBook Air のターミナルで確かめてください。',
    );
    expect(
      noticeFor(
        session({ state: 'waiting_user', waitingReason: 'input', project: null }),
        later,
        null,
        'MacBook Air',
      )?.chat,
    ).toBe(
      '🔔 Claude Code（MacBook Air）があなたの返事を待っています。MacBook Air のターミナルで確かめてください。',
    );
  });
});
