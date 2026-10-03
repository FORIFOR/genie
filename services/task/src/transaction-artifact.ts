/** Human-readable receipts, composed only from validated transaction observations. No model calls. */
import {
  OrderObservation,
  TransactionReconcileArgs,
  TransactionSubmitArgs,
} from '@genie/contracts';
import {
  planTask,
  transactionMoney,
  transactionResultTitle,
  withTransactionQuote,
} from './plan.js';

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('取引の確認結果がありません');
  return value as Record<string, unknown>;
}

/** Provider labels stay literal text instead of becoming links, HTML, or headings. */
function text(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/[\\`*_{}\[\]()#+.!|]/g, '\\$&')
    .replace(/[\r\n]+/g, ' ');
}

function timestamp(value: string): string {
  return value.replace('T', ' ').replace(/(?:\.000)?Z$/, ' UTC');
}

export function formatTransactionArtifact(
  kind: string,
  input: Record<string, unknown>,
  results: readonly unknown[],
): { title: string; markdown: string } | null {
  if (kind !== 'transaction.order' && kind !== 'transaction.reconcile') return null;
  const plan = planTask(kind, input);
  const step =
    kind === 'transaction.order'
      ? withTransactionQuote(plan.steps[1]!, plan.steps, results)
      : { ...plan.steps[0]!, args: TransactionReconcileArgs.parse(plan.steps[0]!.args) };
  const quote = kind === 'transaction.order' ? TransactionSubmitArgs.parse(step.args).quote : null;
  const result = record(results.at(-1));
  const observation = OrderObservation.parse(result['observation']);
  const title = transactionResultTitle(step, result);
  if (!title) throw new Error('取引の確認結果がありません');
  const details = observation.details;
  const stock = details.stock;
  if (
    stock
      ? observation.mode !== 'simulation' || details.requestedTime !== undefined
      : details.requestedTime === undefined
  )
    throw new Error('取引の種類と確認内容が一致しません');
  const statuses: Record<OrderObservation['status'], string> = {
    accepted: stock ? '注文受付（約定完了ではありません）' : '注文受付（配達完了ではありません）',
    preparing: '準備中（配達未完了）',
    out_for_delivery: '配達中（配達未完了）',
    delivered: '配達完了',
    partially_filled: '一部約定（全数量の約定ではありません）',
    filled: '約定確認済み',
    rejected: '受付拒否',
    cancelled: '注文取消を確認済み',
    expired: '注文期限切れ',
  };
  const money = (value: number) => transactionMoney(details.currency, value);
  const lines = [
    `# ${title}`,
    '',
    ...(observation.mode === 'simulation'
      ? ['**シミュレーションの確認票です。実際の注文・決済・株取引は行っていません。**', '']
      : []),
    `- 注文番号: ${text(observation.providerOrderId)}`,
    `- 受付状態: ${statuses[observation.status]}`,
    `- 注文先: ${text(observation.provider)}`,
    `- ${stock ? '模擬口座' : '注文アカウント'}: ${text(observation.account)}`,
    `- ${stock ? '対象口座ID' : '配送先'}: ${quote ? `${text(quote.destination.label)} / ` : ''}${text(details.destinationId)}`,
    `- 支払方法（参照ID）: ${text(details.paymentMethodRef)}`,
    ...(details.requestedTime
      ? [
          `- 希望時刻: ${details.requestedTime === 'asap' ? 'できるだけ早く' : timestamp(details.requestedTime)}`,
        ]
      : []),
    `- 確認時刻: ${timestamp(observation.observedAt)}`,
    '',
    '## 商品・数量',
    '',
    '| 商品 | 数量 | 単価 | 小計 |',
    '| --- | ---: | ---: | ---: |',
    ...details.items.map(
      (item) =>
        `| ${text(item.label)} (${text(item.id)})${item.options.length ? ` / ${item.options.map(text).join('、')}` : ''} | ${item.quantity} | ${money(item.unitMinor)} | ${money(item.lineMinor)} |`,
    ),
    '',
    `**${stock ? '確認した注文合計' : '注文合計（税・手数料・チップ込み）'}: ${money(details.totalMinor)}**`,
  ];
  if (quote)
    lines.push(
      '',
      `見積もりの内訳: 商品 ${money(quote.totals.subtotalMinor)} / 税 ${money(quote.totals.taxMinor)} / 手数料 ${money(quote.totals.feeMinor)} / チップ ${money(quote.totals.tipMinor)}`,
    );
  if (stock) {
    lines.push(
      '',
      '## 株式の注文条件',
      '',
      `- 銘柄 / 市場: ${text(stock.symbol)} / ${text(stock.market)}`,
      `- 売買: ${stock.side === 'BUY' ? '買い' : '売り'} ${stock.quantity}株`,
      `- 注文種別: ${stock.orderType === 'LIMIT' ? `指値 ${money(stock.limitPriceMinor!)}` : '成行'}`,
      `- 有効期間: ${stock.timeInForce}`,
    );
    const fills = observation.fills ?? [];
    if (fills.length)
      lines.push(
        '',
        '## 確認できた約定',
        '',
        '| 約定番号 | 数量 | 約定単価 |',
        '| --- | ---: | ---: |',
        ...fills.map(
          (fill) =>
            `| ${text(fill.executionId)} | ${fill.quantity}株 | ${money(fill.priceMinor)} |`,
        ),
      );
    else lines.push('', '約定の明細はまだ確認できていません。');
  }
  lines.push(
    '',
    `照会用の注文キー: ${text(observation.orderKey)}`,
    '',
    'これは記載した確認時刻の状態です。最新の状態は注文状況の照会で確認できます。',
  );
  return { title, markdown: `${lines.join('\n')}\n` };
}
