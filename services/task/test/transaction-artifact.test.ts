import { describe, expect, it } from 'vitest';
import { formatTransactionArtifact } from '../src/transaction-artifact.js';
import { paperStockFixture, transactionFixture } from './transaction-fixture.js';

describe('human-readable transaction artifacts', () => {
  it('writes the confirmed order, status, terms and time without raw internal JSON', async () => {
    const f = await transactionFixture();
    const artifact = formatTransactionArtifact('transaction.order', { intent: f.intent }, [
      f.prepared,
      f.result,
    ])!;
    for (const line of [
      'シミュレーションの確認票',
      '注文番号: receipt-1',
      '注文受付（配達完了ではありません）',
      '注文先: delivery-sim',
      '注文アカウント: test-account',
      '配送先: テストの配送先 / home',
      '支払方法（参照ID）: test-card',
      '希望時刻: できるだけ早く',
      '確認時刻: 2026-10-01 10:00:00 UTC',
      'カレー',
      '辛口',
      '| 2 | JPY 1000 | JPY 2000 |',
      '注文合計（税・手数料・チップ込み）: JPY 2350',
      '税 JPY 200 / 手数料 JPY 100 / チップ JPY 50',
    ])
      expect(artifact.markdown).toContain(line);
    expect(artifact.markdown).not.toMatch(/quoteHash|submitArgs|step 1:|"totalMinor"/);
    expect(artifact.title).toContain('配達・約定完了ではありません');
  });
  it('shows stock account, full order terms and actual fills without claiming a real trade', async () => {
    const f = await paperStockFixture();
    const artifact = formatTransactionArtifact('transaction.order', { intent: f.intent }, [
      f.prepared,
      f.result,
    ])!;
    for (const line of [
      '実際の注文・決済・株取引は行っていません',
      '模擬口座: paper-account',
      '支払方法（参照ID）: paper-cash',
      '受付状態: 約定確認済み',
      '売買: 買い 2株',
      '注文種別: 指値 JPY 5000',
      '有効期間: DAY',
      '確認した注文合計: JPY 10100',
      '| paper-fill | 2株 | JPY 4990 |',
    ])
      expect(artifact.markdown).toContain(line);
    expect(artifact.markdown).not.toContain('配送先');
  });
  it('formats a read-only reconciliation from observed data without inventing a destination label or fee breakdown', async () => {
    const f = await transactionFixture();
    const artifact = formatTransactionArtifact('transaction.reconcile', f.intent, [f.result])!;
    expect(artifact.markdown).toContain('配送先: home');
    expect(artifact.markdown).not.toContain('テストの配送先');
    expect(artifact.markdown).not.toContain('見積もりの内訳');
    expect(artifact.markdown).toContain('JPY 2350');
  });
  it('does not turn unconfirmed or mismatched outcomes into a receipt', async () => {
    const f = await transactionFixture();
    for (const result of [
      { ...f.result, status: 'unknown', observation: undefined },
      {
        ...f.result,
        observation: {
          ...f.result.observation,
          details: { ...f.result.observation.details, paymentMethodRef: 'another-card' },
        },
      },
    ]) {
      expect(() =>
        formatTransactionArtifact('transaction.order', { intent: f.intent }, [f.prepared, result]),
      ).toThrow();
    }
  });
  it('does not accept embedded artifact prose as transaction evidence and leaves other kinds alone', async () => {
    const f = await transactionFixture();
    const artifact = formatTransactionArtifact('transaction.order', { intent: f.intent }, [
      f.prepared,
      { ...f.result, artifact: { title: 'delivered!', markdown: 'a fabricated delivery claim' } },
    ])!;
    expect(artifact.markdown).not.toContain('fabricated');
    expect(formatTransactionArtifact('echo', {}, [{ echoed: 'hello' }])).toBeNull();
  });
  it('escapes provider-controlled labels and preserves unsupported currency minor units', async () => {
    const f = await transactionFixture();
    const result = {
      ...f.result,
      observation: {
        ...f.result.observation,
        details: {
          ...f.result.observation.details,
          currency: 'KWD',
          items: [{ ...f.quote.items[0]!, label: '[pay](https://bad.invalid)<script>|' }],
        },
      },
    };
    const artifact = formatTransactionArtifact('transaction.reconcile', f.intent, [result])!;
    expect(artifact.markdown).toContain('KWD 2350 minor units');
    expect(artifact.markdown).toContain('\\[pay\\]\\(https://bad\\.invalid\\)&lt;script&gt;\\|');
    expect(artifact.markdown).not.toContain('<script>');
  });
});
