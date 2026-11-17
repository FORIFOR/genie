import { describe, expect, it } from 'vitest';
import { ApprovalDetail, ApprovalImpact } from '@genie/contracts';
import {
  approvalSummaryFor,
  planTask,
  requiresSingleAttempt,
  transactionResultTitle,
  withInstructions,
  withTransactionQuote,
} from '../src/plan.js';
import { paperStockFixture, transactionFixture } from './transaction-fixture.js';

describe('fixed transaction plan and approval', () => {
  it.each(['paymentMethodRef', 'requestedTime', 'stock'])(
    'rejects changed receipt field %s',
    async (field) => {
      const { step, result } = await transactionFixture();
      expect(() =>
        transactionResultTitle(step, {
          ...result,
          observation: {
            ...result.observation,
            details: { ...result.observation.details, [field]: 'different' },
          },
        }),
      ).toThrow('受付結果が一致しません');
    },
  );
  it('matches the complete stock terms instead of accepting only matching shares and total', async () => {
    const { step, result } = await paperStockFixture();
    expect(transactionResultTitle(step, result)).toBe('シミュレーション: 約定を確認しました');
    for (const change of [
      { side: 'SELL' },
      { limitPriceMinor: 6000 },
      { timeInForce: 'GTC' },
      { market: 'OTHER' },
    ]) {
      expect(() =>
        transactionResultTitle(step, {
          ...result,
          observation: {
            ...result.observation,
            details: {
              ...result.observation.details,
              stock: { ...result.observation.details.stock, ...change },
            },
          },
        }),
      ).toThrow('株式条件');
    }
  });
  it('prepares first and always confirms the exact financial submission without retry', async () => {
    const { plan, step, submitArgs } = await transactionFixture();
    expect(plan.steps[0]).toMatchObject({
      toolId: 'transaction.prepare',
      risk: 'READ',
      surface: 'local',
    });
    expect(step).toMatchObject({
      toolId: 'transaction.submit',
      risk: 'FINANCIAL',
      surface: 'local',
      requiresConfirmation: true,
      args: submitArgs,
    });
    expect(requiresSingleAttempt(step)).toBe(true);
    expect(planTask('transaction.reconcile', submitArgs.intent).steps[0]).toMatchObject({
      toolId: 'transaction.reconcile',
      risk: 'READ',
    });
  });
  it('refuses an absent quote, substituted intent, mismatched quote, or modified instructions', async () => {
    const { plan, prepared, step } = await transactionFixture();
    expect(() => withTransactionQuote(plan.steps[1]!, plan.steps, [])).toThrow();
    expect(() =>
      withTransactionQuote(plan.steps[1]!, plan.steps, [
        { ...prepared, quote: { ...prepared.quote, quoteId: 'different' } },
      ]),
    ).toThrow();
    expect(() =>
      withTransactionQuote(plan.steps[1]!, plan.steps, [
        {
          ...prepared,
          submitArgs: {
            ...prepared.submitArgs,
            intent: { ...prepared.submitArgs.intent, account: 'someone-else' },
          },
        },
      ]),
    ).toThrow();
    expect(() => withInstructions(step, ['数量を増やして'])).toThrow('新しい見積もり');
  });
  it('shows identity, every term, currency, all fees, total, expiry and simulation explicitly', async () => {
    const { step } = await transactionFixture();
    const card = approvalSummaryFor(step);
    const text = JSON.stringify(card);
    for (const required of [
      'delivery-sim',
      'test-account',
      'テストの配送先',
      'home',
      'test-card',
      'できるだけ早く',
      'カレー',
      '× 2',
      '辛口',
      'JPY 2350',
      '税 JPY 200',
      '手数料 JPY 100',
      'チップ JPY 50',
      'シミュレーション',
      '1回だけ',
    ])
      expect(text).toContain(required);
    for (const detail of card.details) ApprovalDetail.parse(detail);
    ApprovalImpact.parse(card.impact);
    expect(card.details.length).toBeLessThanOrEqual(20);
  });
  it('never truncates terms to fit the approval card or guesses unknown currency units', async () => {
    const { step, quote } = await transactionFixture();
    const card = approvalSummaryFor({
      ...step,
      args: { ...step.args, quote: { ...quote, currency: 'KWD' } },
    });
    expect(JSON.stringify(card)).toContain('KWD 2350 minor units');
    expect(() =>
      approvalSummaryFor({
        ...step,
        args: {
          ...step.args,
          quote: { ...quote, items: [{ ...quote.items[0], options: ['x'.repeat(2100)] }] },
        },
      }),
    ).toThrow('上限');
  });
  it('records acceptance without claiming delivery and refuses unknown, mismatched or rejected results', async () => {
    const { step, result } = await transactionFixture();
    expect(transactionResultTitle(step, result)).toBe(
      'シミュレーション: 注文を受け付けました（配達・約定完了ではありません）',
    );
    expect(() =>
      transactionResultTitle(step, { ...result, status: 'unknown', observation: undefined }),
    ).toThrow('再注文せず');
    expect(() => transactionResultTitle(step, { ...result, account: 'wrong' })).toThrow();
    expect(() =>
      transactionResultTitle(step, {
        ...result,
        observation: {
          ...result.observation,
          details: { ...result.observation.details, totalMinor: 1 },
        },
      }),
    ).toThrow('金額');
    expect(() =>
      transactionResultTitle(step, {
        ...result,
        status: 'filled',
        observation: { ...result.observation, status: 'filled' },
      }),
    ).toThrow();
    expect(() =>
      transactionResultTitle(step, {
        ...result,
        status: 'rejected',
        observation: { ...result.observation, status: 'rejected' },
      }),
    ).toThrow('受け付けられません');
  });
});
