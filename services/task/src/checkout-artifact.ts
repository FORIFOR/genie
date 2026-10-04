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
    // 本文はそのまま読み上げられる。言うべきことだけを短く（見出し・長い確認項目は読ませない）。
    markdown: [
      `かしこまりました。${service.label}の公式サイトをブラウザで開きました。`,
      '**Genieは注文・支払いを行っていません。カートの準備も行っていません。**',
      'ページの表示・ログイン状態・カート・注文履歴は確認していません。',
      '商品を選び、最後の確定はご自身でお願いします。',
      '',
      `[${service.label}の公式注文画面](${service.url})`,
    ].join('\n'),
  };
}
