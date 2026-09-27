import { describe, expect, it } from 'vitest';
import { ApprovalDetail, ApprovalImpact } from '@genie/contracts';
import { approvalSummaryFor, planTask } from '../src/plan.js';

describe('computer.action plan', () => {
  it('plans read-only observation without confirmation', () => {
    const plan = planTask('computer.action', { action: 'observe' });
    expect(plan.steps).toEqual([
      expect.objectContaining({
        toolId: 'computer.observe',
        risk: 'READ',
        surface: 'local',
        requiresConfirmation: false,
      }),
    ]);
  });

  it('requires confirmation for mutating input', () => {
    const plan = planTask('computer.action', {
      action: 'click',
      x: 120,
      y: 240,
      expectChange: true,
    });
    expect(plan.steps[0]).toMatchObject({
      toolId: 'computer.click',
      risk: 'EXTERNAL_COMMIT',
      surface: 'local',
      requiresConfirmation: true,
      args: { x: 120, y: 240, expectChange: true },
    });
  });

  it('plans a bounded autonomous run behind one explicit approval', () => {
    const plan = planTask('computer.run', { goal: '設定画面を開く' });
    expect(plan.steps[0]).toMatchObject({
      toolId: 'computer.run',
      risk: 'EXTERNAL_COMMIT',
      surface: 'local',
      requiresConfirmation: true,
      args: { goal: '設定画面を開く', successCriteria: '設定画面を開く' },
    });
  });

  /*
   * 承認カードが唯一の人の関門になる。**承認のあとは 1 操作ごとに訊かない**ので、
   * カードがそれを言わなければ、読んだ人は「あとで 1 つずつ訊かれる」と思って押す。
   */
  it('says on the approval card that operations run unconfirmed within the limits', () => {
    const card = approvalSummaryFor(planTask('computer.run', { goal: '設定画面を開く' }).steps[0]!);
    expect(card.summary).toBe('対象の窓1つを、1操作ごとの確認なしで最大12操作・5分まで操作します');
    expect(card.summary.length).toBeLessThanOrEqual(200);
    expect(card.details).toEqual([
      { label: '目的', value: '設定画面を開く' },
      // 許可は 20 分続き、続きの依頼では選択画面を出さずに前の窓を使う。「開始時に決める」とだけは言わない。
      {
        label: '範囲',
        value: expect.stringMatching(/^対象の窓1つだけ.*20分以内の続きの依頼では前に選んだ窓のまま/),
      },
      {
        label: '確認',
        value: expect.stringContaining('1操作ごとには確認しません（最大12操作・5分）'),
      },
      { label: '影響', value: expect.stringContaining('取り消せないことがあります') },
      // 送信先は承認の時点ではサーバに分からない。断定せず、外部なら外へ出ることを言う。
      { label: '画像の送信先', value: expect.stringContaining('外部のモデルなら') },
    ]);
    for (const detail of card.details) ApprovalDetail.parse(detail);
    expect(ApprovalImpact.parse(card.impact)).toEqual({
      primary_action_label: '画面の操作を始める',
      affected_count: null,
      scope: 'external',
      reversible: false,
      recovery_note: null,
    });
  });

  it('keeps tool names and the old per-operation promise off the approval card', () => {
    const plan = planTask('computer.run', {
      goal: '請求書を開く',
      successCriteria: '請求書の画面が表示されている',
    });
    const card = approvalSummaryFor(plan.steps[0]!);
    expect(card.details).toContainEqual({
      label: '完了の条件',
      value: '請求書の画面が表示されている',
    });
    const text = [card.summary, ...card.details.flatMap((d) => [d.label, d.value])].join('\n');
    expect(text).not.toMatch(/computer\.run|successCriteria|\bgoal\b/);
    expect(text).not.toContain('操作ごとに確認します');
    // 実行中の進捗の文。開始前の約束（確認・送信先）を持ち込まない。
    expect(plan.steps[0]!.message).toBe('対象の窓を画像で確かめながら操作しています');
  });

  it('rejects unknown computer actions', () => {
    expect(() => planTask('computer.action', { action: 'shell' })).toThrow(
      'computer.action needs observe, click, type, or key',
    );
  });
});
