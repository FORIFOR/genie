import { BrowserOpenResult } from '@genie/contracts';

/** 開いたかどうかは端末が返した事実から言う。モデルの文で「開きました」と言わせない。 */
export function formatBrowserArtifact(kind: string, results: readonly unknown[]) {
  if (kind !== 'browser.open_official') return null;
  if (results.length !== 1) throw new Error('公式サイトを開いた結果が一致しません');
  const result = BrowserOpenResult.parse(results[0]);
  const title = `${result.subject} の公式サイト`;
  // 本文はそのまま読み上げられる。言うことだけを短く書く（URL や見出しは読ませない）。
  return {
    title,
    markdown:
      result.opened && result.url
        ? [
            result.shown === true
              ? `かしこまりました。${result.subject}の公式サイトをブラウザで開き、表示されたのを確認しました。`
              : result.shown === false
                ? `${result.subject}の公式サイトを開きましたが、いま前に出ているのは別のページです。ブラウザを確認してください。`
                : `${result.subject}の公式サイトをブラウザで開いています。表示まではまだ確認できていません。`,
            '',
            `[${result.title || result.subject}](${result.url})`,
          ].join('\n')
        : `申し訳ありません。${result.problem ?? `${result.subject}の公式サイトを開けませんでした。`}`,
  };
}
