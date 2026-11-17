import { WorkPreviewResult } from '@genie/contracts';

/**
 * 案の結果を、端末が確かめた事実だけで伝える。最初の段落が声で読まれる（短く、パスや表は読ませない）。
 * 確認が一つでも落ちたら「合格」と言わない。直していない文があれば必ず言う。
 */
export function formatWorkPreviewArtifact(kind: string, results: readonly unknown[]) {
  if (kind !== 'work.preview') return null;
  if (results.length !== 1) throw new Error('書類の案の結果が一致しません');
  const r = WorkPreviewResult.parse(results[0]);
  const docs = r.edits.filter((e) => !e.file.toLowerCase().endsWith('.xlsx'));
  const failed = r.checks.filter((c) => !c.ok);
  const spoken = [
    `「${r.folder.split('/').filter(Boolean).at(-1) ?? r.folder}」の書類で、${r.change.label}を${r.change.from}から${r.change.to}にした案を作りました。`,
    docs.length ? `提案書やスライドの${docs.length}か所も合わせました。` : '提案書やスライドに合わせる箇所はありませんでした。',
    failed.length
      ? `ただし、確認で${failed.length}項目が合いませんでした（${failed.map((c) => c.name).join('、')}）。`
      : `確認${r.checks.length}項目はすべて合格です。`,
    r.needsReview.length ? `${r.needsReview.length}か所は、どの数か決められず直していません。` : '',
    '原本は変えていません。',
  ].join('');
  const cell = (t: string) => t.replace(/\|/g, '\\|').replace(/\n/g, ' ') || '—';
  return {
    title: `書類の案（${r.change.label} ${r.change.to}）`,
    markdown: [
      spoken,
      '',
      '| ファイル | 前 | 後 | 理由 |',
      '| --- | --- | --- | --- |',
      ...r.edits.map((e) => `| ${cell(e.file)} | ${cell(e.before)} | ${cell(e.after)} | ${cell(e.reason)} |`),
      '',
      '確認:',
      '',
      ...r.checks.map((c) => `- ${c.ok ? '合格' : '不合格'}: ${c.name}${c.ok ? '' : `（${c.detail}）`}`),
      ...(r.needsReview.length ? ['', '直していない（確認が要る）:', '', ...r.needsReview.map((m) => `- ${m}`)] : []),
      ...(r.rules ? ['', `以前の直し ${r.rules} 件を守って作りました。`] : []),
      '',
      `案の場所: \`${r.previewDir}\``,
    ].join('\n'),
  };
}
