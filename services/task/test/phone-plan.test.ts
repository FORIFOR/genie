/**
 * Oathra 経由の電話の計画。**外へ出る・取り消せない・お金がかかる**ので、
 * 必ず承認カードを通り、カードには人が読める項目だけが出る。
 */
import { describe, expect, it } from 'vitest';
import { approvalSummaryFor, planTask, requiresSingleAttempt } from '../src/plan.js';

describe('phone.sales plan', () => {
  const plan = planTask('phone.sales', {
    contact_id: 'c-1',
    contact_name: '田中',
    product_id: 'p-1',
    product_name: 'デモ商品',
    request: '資料送付の案内',
    goal: 'materials',
  });

  it('is one confirmed external step that is never retried', () => {
    expect(plan.steps).toHaveLength(1);
    const [step] = plan.steps;
    expect(step).toMatchObject({
      toolId: 'phone.sales',
      risk: 'EXTERNAL_COMMIT',
      surface: 'cloud',
      requiresConfirmation: true,
      args: {
        sales: { contactId: 'c-1', productId: 'p-1', request: '資料送付の案内', goal: 'materials' },
      },
    });
    expect(requiresSingleAttempt(step!)).toBe(true);
  });

  it('shows the person, product and purpose on the approval card, never ids', () => {
    const card = approvalSummaryFor(plan.steps[0]!);
    expect(card.summary).toBe('田中さんに営業の電話をかけます');
    expect(card.details).toEqual([
      { label: '相手', value: '田中' },
      { label: '商品', value: 'デモ商品' },
      { label: '目的', value: '資料を送ってよいか確かめる' },
      { label: '用件', value: '資料送付の案内' },
    ]);
    expect(JSON.stringify(card.details)).not.toContain('c-1');
    expect(card.impact).toMatchObject({
      primary_action_label: '電話をかける',
      scope: 'external',
      reversible: false,
    });
  });

  it('refuses a sales call without a resolved contact', () => {
    expect(() => planTask('phone.sales', { request: '案内', goal: 'introduce' })).toThrow();
  });
});

describe('phone.call plan', () => {
  it('carries the number and message to Oathra and asks first', () => {
    const plan = planTask('phone.call', {
      phone: '090-1234-5678',
      name: '相手',
      instruction: '10時集合と伝える',
    });
    expect(plan.steps[0]).toMatchObject({
      toolId: 'phone.call',
      risk: 'EXTERNAL_COMMIT',
      requiresConfirmation: true,
      args: {
        番号: '090-1234-5678',
        call: { phone: '090-1234-5678', instruction: '10時集合と伝える' },
      },
    });
    expect(() => planTask('phone.call', { phone: '090-1234-5678' })).toThrow();
  });
});

describe('phone.unresolved plan', () => {
  it('is one READ step with the reason, and needs one', () => {
    const plan = planTask('phone.unresolved', {
      notice: '相手が見つかりません',
      words: '高橋さんに営業電話して',
    });
    expect(plan.steps).toEqual([
      expect.objectContaining({
        toolId: 'phone.unresolved',
        risk: 'READ',
        surface: 'cloud',
        args: { notice: '相手が見つかりません', words: '高橋さんに営業電話して' },
      }),
    ]);
    expect(plan.steps[0]!.requiresConfirmation).toBeUndefined();
    expect(() => planTask('phone.unresolved', { words: 'x' })).toThrow();
  });
});
