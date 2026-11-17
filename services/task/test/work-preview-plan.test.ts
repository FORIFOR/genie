import { describe, expect, it } from 'vitest';
import { isKnownTaskKind, isMeteredStep, planTask } from '../src/plan.js';
import { formatWorkPreviewArtifact } from '../src/work-preview-artifact.js';

const result = (checks: { name: string; ok: boolean; detail: string }[], needsReview: string[] = []) => ({
  folder: '/Users/u/Documents/A社', previewDir: '/Users/u/Documents/A社/Genie案/案1_業務用端末の数量を120に',
  change: { label: '業務用端末の数量', from: 100, to: 120 },
  edits: [
    { file: 'q.xlsx', where: '/Sheet1/B2', before: '100', after: '120', reason: '依頼された変更' },
    { file: 'p.docx', where: '/body/p[1]', before: '端末を100台', after: '端末を120台', reason: '業務用端末の数量 に合わせた' },
    { file: 's.pptx', where: '/slide[1]/shape[1]', before: '総額 130万円', after: '総額 154万円', reason: '合計の金額 に合わせた' },
  ],
  checks, needsReview, rules: 0, screenshots: [],
});

describe('work preview task', () => {
  it('runs one local, reversible, unmetered step', () => {
    expect(isKnownTaskKind('work.preview')).toBe(true);
    const step = planTask('work.preview', { to: 120, subject: '端末' }).steps[0]!;
    expect(step).toMatchObject({ toolId: 'work.preview', surface: 'local', risk: 'REVERSIBLE_WRITE', args: { to: 120, subject: '端末' } });
    expect(isMeteredStep(step)).toBe(false);
    expect(() => planTask('work.preview', {})).toThrow();
    expect(() => planTask('work.preview', { to: '120' })).toThrow();
  });

  it('says "all passed" only when every check passed, and always mentions untouched mentions', () => {
    const good = formatWorkPreviewArtifact('work.preview', [result([{ name: '形式', ok: true, detail: '' }, { name: '指定外を変えていない', ok: true, detail: '' }])])!;
    const spoken = good.markdown.split('\n')[0]!;
    expect(spoken).toBe('「A社」の書類で、業務用端末の数量を100から120にした案を作りました。提案書やスライドの2か所も合わせました。確認2項目はすべて合格です。原本は変えていません。');
    expect(spoken).not.toContain('/Users');

    const bad = formatWorkPreviewArtifact('work.preview', [result([{ name: '関係する箇所がすべて新しい値', ok: false, detail: 'p.docx' }], ['p.docx: 100台'])])!;
    expect(bad.markdown.split('\n')[0]).toContain('確認で1項目が合いませんでした');
    expect(bad.markdown.split('\n')[0]).toContain('1か所は、どの数か決められず直していません');
    expect(bad.markdown).not.toContain('すべて合格');
    expect(formatWorkPreviewArtifact('office.edit', [])).toBeNull();
  });
});
