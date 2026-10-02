import { CHECKOUT_SERVICES, CheckoutHandoffResult, CheckoutOpenArgs } from '@genie/contracts';

/** No LLM prose may upgrade a navigation request into checkout/order completion. */
export function formatCheckoutArtifact(
  kind: string,
  input: Record<string, unknown>,
  results: readonly unknown[],
) {
  if (kind !== 'checkout.assist') return null;
  const args = CheckoutOpenArgs.parse(input);
  if (results.length !== 1) throw new Error('注文画面への引き継ぎ結果が一致しません');
  const result = CheckoutHandoffResult.parse(results[0]);
  if (result.service !== args.service || result.navigation !== 'requested')
    throw new Error('注文画面への引き継ぎを確認できません');
  const service = CHECKOUT_SERVICES[args.service];
  const title = `${service.label}：注文画面への引き継ぎ（未注文）`;
  return {
    title,
    markdown: [
      `# ${title}`,
      '',
      '**Genieは注文・支払いを行っていません。カートの準備も行っていません。**',
      '',
      '公式サイトをブラウザで開く依頼を送りました。ブラウザを強制的に前面へ出す操作はしていません。',
      'ページの表示・ログイン状態・カート・注文履歴は確認していません。',
      '',
      `[${service.label}の公式注文画面](${service.url})`,
      '',
      'サイト上で、次の内容をご自身で確認してください。',
      '',
      '- ログインまたは必要なお客様情報',
      '- 配送先・受取日時・配達可能な店舗',
      '- 商品・数量・サイズ・生地・トッピング等の選択肢',
      '- 税・配送料等を含む合計と予算',
      '- 支払方法と最終確認の内容',
      '',
      '注文する場合は、最後の確定操作をご自身で行ってください。既に注文した可能性がある場合は、再注文せず公式の注文履歴を確認してください。',
      '',
      'この接続は公式サイトへの引き継ぎだけに対応しています。認証済み画面での自動カート準備・注文確定・受付照合にはまだ対応していません。',
      '',
    ].join('\n'),
  };
}
