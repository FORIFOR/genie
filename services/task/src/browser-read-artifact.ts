import { BrowserReadResult } from '@genie/contracts';

/**
 * 読んだかどうかは端末が返した事実から言う。読めなかったのに答えを作らせない。
 * 答えはページの本文から端末のモデルが書いたもの。どのページを、どの状態で読んだかを添える。
 */
export function formatBrowserReadArtifact(kind: string, results: readonly unknown[]) {
  if (kind !== 'browser.read') return null;
  if (results.length !== 1) throw new Error('ページを読んだ結果が一致しません');
  const result = BrowserReadResult.parse(results[0]);
  const page = result.finalUrl ?? result.url;
  const label = (result.title || new URL(page).hostname).replace(/[[\]]/g, '');
  return {
    title: result.title ? `ページを読んだ結果: ${result.title.slice(0, 60)}` : 'ページを読んだ結果',
    markdown:
      result.read && result.answer
        ? [
            result.answer,
            '',
            `[${label}](${page})`,
            '',
            'Genie 専用のブラウザ（ログインしていない状態）で見えた本文から答えています。',
          ].join('\n')
        : `申し訳ありません。${result.problem ?? 'ページを読めませんでした。'}`,
  };
}
