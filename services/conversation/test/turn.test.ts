/**
 * Lane → 仕事の種類。HTTP とチャネルが同じ答えを得ること（Phase 0、チャネル連携）。
 * DB を使う一連の流れは api-gateway の結合テスト（conversations-*）が見る。
 */
import { describe, expect, it } from 'vitest';
import { agentKindFor } from '@genie/service-task';
import { laneToIntent, taskRequestForLane } from '../src/turn.js';

describe('taskRequestForLane', () => {
  it('turns a chat into a General Assistant task with only the given context', () => {
    const request = taskRequestForLane({ text: '今日の予定は？', lane: 'chat' });
    expect(request).toEqual({
      kind: agentKindFor('com.astra.general', 'assistant'),
      input: { question: '今日の予定は？', message: '今日の予定は？' },
    });
  });

  it('carries work context and its size only when there is some', () => {
    const request = taskRequestForLane({
      text: 'A社の件どうなってる？',
      lane: 'chat',
      workContext: '<work_context>…</work_context>',
      contextStats: { selected: 1, available: 9 } as never,
    });
    expect(request?.input).toMatchObject({
      context: '<work_context>…</work_context>',
      context_meta: { selected: 1, available: 9 },
    });
  });

  it('asks only for a draft when replying in context (never sends)', () => {
    const request = taskRequestForLane({
      text: 'これ返して',
      lane: 'chat',
      replyDraft: { meta: { target: {} } as never, instruction: '丁寧に返信案を書く' },
    });
    expect(request?.input).toMatchObject({ instruction: '丁寧に返信案を書く' });
    expect(request?.kind).toBe(agentKindFor('com.astra.general', 'assistant'));
  });

  it('turns research into a research task', () => {
    expect(taskRequestForLane({ text: '競合を調べて', lane: 'research' })).toEqual({
      kind: 'research',
      input: { question: '競合を調べて' },
    });
  });

  it('does not invent work for lanes it cannot run yet', () => {
    for (const lane of ['edit', 'dictate', 'specialist-agent', 'meeting']) {
      expect(taskRequestForLane({ text: '見積を送信して', lane }), lane).toBeNull();
    }
  });

  it('sends a plain action to screen control, which asks for approval before acting', () => {
    expect(taskRequestForLane({ text: '見積を送信して', lane: 'action' })).toEqual({
      kind: 'computer.run',
      input: { goal: '見積を送信して', title: '見積を送信して' },
    });
  });

  it('routes rule-matched requests before the lane default', () => {
    expect(
      taskRequestForLane({ text: 'オークリーのサングラスを公式サイトで見せて', lane: 'chat' })?.kind,
    ).toBe('browser.open_official');
    expect(
      taskRequestForLane({
        text: '東京の天気を教えて',
        lane: 'chat',
        info: { kind: 'weather', place: '東京' } as never,
      })?.kind,
    ).toBe('info.lookup');
  });
});

describe('laneToIntent', () => {
  it('never exposes internal lane names', () => {
    expect(laneToIntent('specialist-agent')).toBe('delegating');
    expect(laneToIntent('chat')).toBe('talking');
    expect(laneToIntent('unknown')).toBe('talking');
  });
});
