/**
 * ほかの AI に頼んだ仕事の見守り（agent-sessions.ts）の決まりごと。DB を使わない部分。
 *
 * 見ること:
 *   - 「応答を終えた（Stop）」を「仕事が終わった」にしない（idle で、ended ではない）
 *   - 承認・入力の待ちは waiting_user（Dock では needs_user）
 *   - 最後の文が本人への問いで終えた応答（Stop）も、返事を待っている（waiting_user・input）
 *   - 本人が止めたものは、静かでも「止まっているかも」と言わない
 *   - 名前に残すのは頼みの頭だけで、鍵らしい文字列は伏せる。フォルダは名前だけ
 */
import { describe, expect, it } from 'vitest';
import {
  STALL_AFTER_MS,
  asksUser,
  attentionFor,
  projectName,
  titleFrom,
  transitionFor,
  type AgentSession,
} from '../src/agent-sessions.js';

const session = (over: Partial<AgentSession>): AgentSession => ({
  id: 's',
  source: 'claude_code',
  externalSessionId: 'x',
  project: null,
  title: null,
  state: 'working',
  waitingReason: null,
  userPolicy: 'watch',
  heldBy: null,
  checkState: 'none',
  lastEvent: 'PostToolUse',
  lastActivityAt: new Date(0),
  stateSince: new Date(0),
  endedAt: null,
  endReason: null,
  createdAt: new Date(0),
  ...over,
});

describe('agent session events', () => {
  it('treats Stop as the end of a response, not the end of the work', () => {
    expect(transitionFor({ event: 'Stop', sessionId: 'x' })).toMatchObject({
      state: 'idle',
      turnEnded: true,
    });
    expect(transitionFor({ event: 'Stop', sessionId: 'x' })?.ended).toBeUndefined();
    expect(
      transitionFor({ event: 'SessionEnd', sessionId: 'x', reason: 'prompt_input_exit' }),
    ).toMatchObject({ state: 'ended', ended: { reason: 'prompt_input_exit' } });
  });

  it('treats a response that ends by asking the user as waiting for their answer', () => {
    expect(
      transitionFor({
        event: 'Stop',
        sessionId: 'x',
        lastMessage: '直しました。\n\nどちらの案で進めますか？',
      }),
    ).toMatchObject({ state: 'waiting_user', waitingReason: 'input', turnEnded: true });
    expect(
      transitionFor({ event: 'Stop', sessionId: 'x', lastMessage: '直して、テストも通りました。' }),
    ).toMatchObject({ state: 'idle', turnEnded: true });
  });

  it('tells a question to the user apart from a report', () => {
    for (const asking of [
      'どちらにしますか？',
      '進めてよいですか',
      'LINE で試したら「確かめて」と送ってください。\n\n**どれを先にやるか教えてください。**',
      'Which option should I take?',
      '直しました。\n\n- A 案\n- B 案\n\n使う案を選んでください。',
    ])
      expect(asksUser(asking), asking).toBe(true);
    for (const report of [
      '直しました。テストは通っています。',
      '例えば「明日は？」と聞けば答えます。\n\nコミットは 1 つで、push はしていません。',
      '```\nwhat?\n```\n\n終わりました。',
      '',
      undefined,
    ])
      expect(asksUser(report), String(report)).toBe(false);
  });

  it('marks approvals and questions as waiting for the user', () => {
    expect(transitionFor({ event: 'PermissionRequest', sessionId: 'x' })).toMatchObject({
      state: 'waiting_user',
      waitingReason: 'permission',
    });
    expect(
      transitionFor({
        event: 'Notification',
        sessionId: 'x',
        message: 'Claude needs your permission to use Bash',
      }),
    ).toMatchObject({ state: 'waiting_user', waitingReason: 'permission' });
    expect(
      transitionFor({
        event: 'Notification',
        sessionId: 'x',
        notificationType: 'elicitation_dialog',
      }),
    ).toMatchObject({ state: 'waiting_user', waitingReason: 'input' });
    // 応答を終えたあとの「入力を待っています」は返事待ちではない（Stop と同じ idle のまま。2026-10-29 の実物）
    expect(
      transitionFor({
        event: 'Notification',
        sessionId: 'x',
        notificationType: 'idle_prompt',
        message: 'Claude is waiting for your input',
      }),
    ).toBeNull();
    // 何の知らせか分からないものでは状態を変えない
    expect(transitionFor({ event: 'Notification', sessionId: 'x', message: 'hello' })).toBeNull();
    expect(transitionFor({ event: 'ConfigChange', sessionId: 'x' })).toBeNull();
  });

  it('lets tool events count as activity that cannot undo a Stop', () => {
    expect(transitionFor({ event: 'PostToolUse', sessionId: 'x' })).toMatchObject({
      state: 'working',
      activityOnly: true,
    });
    expect(transitionFor({ event: 'UserPromptSubmit', sessionId: 'x' })?.activityOnly).toBe(
      undefined,
    );
  });
});

describe('agent session attention', () => {
  const now = STALL_AFTER_MS * 10;
  it('suspects a stall only when working and quiet past the threshold', () => {
    expect(attentionFor(session({ lastActivityAt: new Date(now - 60_000) }), now)).toBe('working');
    expect(attentionFor(session({ lastActivityAt: new Date(now - STALL_AFTER_MS - 1) }), now)).toBe(
      'stalled_suspected',
    );
    // 待っている・応答を終えたものは、どれだけ静かでも止まっているとは言わない
    expect(attentionFor(session({ state: 'idle' }), now)).toBe('idle');
    expect(attentionFor(session({ state: 'waiting_user' }), now)).toBe('needs_user');
    expect(attentionFor(session({ state: 'error' }), now)).toBe('needs_user');
  });

  it('never reports a session the user paused as stalled or needing them', () => {
    expect(attentionFor(session({ userPolicy: 'paused_by_user' }), now)).toBe('paused');
    expect(
      attentionFor(session({ userPolicy: 'paused_by_user', state: 'waiting_user' }), now),
    ).toBe('paused');
    expect(attentionFor(session({ userPolicy: 'paused_by_user', state: 'ended' }), now)).toBe(
      'ended',
    );
  });
});

describe('what is kept', () => {
  it('keeps the first line of a request, short, with key-like strings hidden', () => {
    expect(titleFrom('\n  ログイン画面を直して\n詳細は…')).toBe('ログイン画面を直して');
    expect(titleFrom('キーは sk-ant-abcdefghijklmnop です')).toBe('キーは … です');
    expect(titleFrom(`token ${'a'.repeat(40)} を使って`)).toBe('token … を使って');
    expect(titleFrom('あ'.repeat(200))).toHaveLength(80);
    expect(titleFrom('   ')).toBeNull();
    // 機械の知らせ（バックグラウンドの作業が終わった通知）は頼みではない
    expect(
      titleFrom(
        '<task-notification>\n<task-id>x</task-id>\n<summary>Agent finished</summary>\n</task-notification>',
      ),
    ).toBeNull();
    // 文の頭がタグなだけの頼みは名前にする
    expect(titleFrom('<b>太字</b>を直して')).toBe('<b>太字</b>を直して');
    expect(titleFrom(undefined)).toBeNull();
  });

  it('keeps only the folder name, not the full path', () => {
    expect(projectName('/Users/someone/Projects/genie')).toBe('genie');
    expect(projectName('/Users/someone/Projects/genie/')).toBe('genie');
    expect(projectName(undefined)).toBeNull();
  });
});
