import { OfficeEditResult } from '@genie/contracts';

/** 何をどこへ書いたかは、端末が返した事実から作る。モデルの文で「保存した」と言わせない。 */
export function formatOfficeArtifact(kind: string, results: readonly unknown[]) {
  if (kind !== 'office.edit') return null;
  if (results.length !== 1) throw new Error('文書の編集結果が一致しません');
  const result = OfficeEditResult.parse(results[0]);
  const name = result.source.split('/').at(-1) ?? result.source;
  const title = `${name} の編集`;
  const cell = (text: string) => text.replace(/\|/g, '\\|').replace(/\n/g, ' ') || '—';
  return {
    title,
    markdown: [
      `# ${title}`,
      '',
      result.output
        ? `**原本は変えていません。**直したものを別のファイルに保存しました: \`${result.output}\``
        : '**ファイルは作っていません。**書くべき変更がありませんでした。原本も変えていません。',
      '',
      ...(result.summary ? [result.summary, ''] : []),
      ...(result.changes.length > 0
        ? [
            '| 場所 | 前 | 後 |',
            '| --- | --- | --- |',
            ...result.changes.map(
              (c) => `| ${cell(c.where)} | ${cell(c.before)} | ${cell(c.after)} |`,
            ),
            '',
          ]
        : []),
      ...(result.skipped.length > 0
        ? ['書かなかった変更:', '', ...result.skipped.map((reason) => `- ${reason}`), '']
        : []),
      ...(result.format === 'xlsx' && result.changes.some((c) => c.after.startsWith('='))
        ? [
            '式の結果は、Excel や Numbers で開いたときに計算されます（プレビューでは空に見えることがあります）。',
            '',
          ]
        : []),
      `元のファイル: \`${result.source}\``,
    ].join('\n'),
  };
}
