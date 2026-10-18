import {
  CHECKOUT_SERVICES,
  CheckoutHandoffResult,
  CheckoutOpenArgs,
  CheckoutPrepareArgs,
} from '@genie/contracts/checkout-assistance';

/** No LLM prose may upgrade a navigation request into checkout/order completion. */
export function formatCheckoutArtifact(
  kind: string,
  input: Record<string, unknown>,
  results: readonly unknown[],
) {
  if (kind === 'account.registration.prepare') {
    if (
      Object.keys(input).length !== 1 ||
      input['service'] !== 'mcdelivery_jp' ||
      results.length !== 2
    )
      throw new Error('会員登録の準備結果が一致しません');
    const navigation = CheckoutHandoffResult.parse(results[0]);
    const preparation = results[1] as Record<string, unknown> | null;
    const registration = preparation?.['registration'] as Record<string, unknown> | null;
    if (
      navigation.service !== 'mcdelivery_jp' ||
      navigation.navigation !== 'requested' ||
      preparation?.['completed'] !== false ||
      preparation?.['status'] !== 'awaiting_user_registration' ||
      typeof registration?.['credentialRef'] !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        registration['credentialRef'],
      )
    )
      throw new Error('登録フォームへの入力準備を確認できません');
    return {
      title: '会員登録の入力準備（本人の操作待ち）',
      markdown: [
        '確認したメールアドレスと、新しく生成したパスワードを登録フォームに入力しました。パスワードはこのMacのKeychainに保存しました。',
        '会員登録はまだ完了していません。公式サイトで利用規約と個人情報保護方針を確認し、同意・登録・本人確認を済ませてください。',
        'パスワードを入力したブラウザの撮影と自動操作は停止しています。登録画面を閉じ、ブラウザを終了・再起動してからGenieで続けてください。',
        '[マックデリバリーの公式サイト](https://www.mcdonalds.co.jp/mcdelivery/)',
      ].join('\n\n'),
    };
  }
  if (kind === 'checkout.prepare') {
    const args = CheckoutPrepareArgs.parse(input);
    if (results.length !== 2) throw new Error('注文準備の結果が一致しません');
    const navigation = CheckoutHandoffResult.parse(results[0]);
    const verified = results[1] as Record<string, unknown> | null;
    if (
      navigation.service !== args.service ||
      navigation.navigation !== 'requested' ||
      !verified ||
      verified['completed'] !== true ||
      verified['verification'] !== 'visual' ||
      !Array.isArray(verified['audit']) ||
      !verified['audit'].some((row: unknown) => {
        if (!row || typeof row !== 'object') return false;
        const evidence = row as Record<string, unknown>;
        return (
          evidence['event'] === 'goal_verification' &&
          evidence['verified'] === true &&
          typeof evidence['before'] === 'string' &&
          /^[a-f0-9]{64}$/.test(evidence['before'])
        );
      })
    )
      throw new Error('カートの準備完了を画面から確認できません');
    const service = CHECKOUT_SERVICES[args.service];
    return {
      title: `${service.label}：カートの確認（未注文）`,
      markdown: [
        `${service.label}のカートと確認画面を確認しました。注文・支払いはまだ行っていません。`,
        `ご依頼：${args.itemsText}`,
        `希望時刻：${args.requestedTime === 'asap' ? 'できるだけ早く' : args.requestedTime}`,
        `指定した上限：${args.maxTotalMinor}円（税・手数料込み。実際の請求金額ではありません）`,
        '商品・数量・配送先・支払方法・合計は公式の確認画面で見直せます。',
        '注文確定の実サービス連携はまだ未接続です。この準備結果を注文受付として扱うことはできません。',
        '',
        `[${service.label}の公式注文画面](${service.url})`,
      ].join('\n'),
    };
  }
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
