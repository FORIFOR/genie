import { describe, expect, it } from 'vitest';
import {
  isKnownTaskKind,
  isMeteredStep,
  planTask,
  requiresSingleAttempt,
  withInstructions,
} from '../src/plan.js';
import { formatOfficeArtifact } from '../src/office-artifact.js';

describe('editing a Word or Excel file', () => {
  it('runs one local step that writes a copy and is never retried automatically', () => {
    expect(isKnownTaskKind('office.edit')).toBe(true);
    const plan = planTask('office.edit', { path: '~/a.docx', instruction: '敬語に直して' });
    expect(plan.steps).toHaveLength(1);
    const step = plan.steps[0]!;
    expect(step).toMatchObject({
      toolId: 'office.edit',
      surface: 'local',
      risk: 'REVERSIBLE_WRITE',
    });
    expect(isMeteredStep(step)).toBe(true);
    expect(requiresSingleAttempt(step)).toBe(false);
    expect(() => planTask('office.edit', { path: '~/a.docx' })).toThrow();
    // A follow-up instruction is appended to the instruction itself.
    expect(withInstructions(step, ['数字は半角で']).args['instruction']).toContain('数字は半角で');
  });

  it('reports what was written where, from the device result, never from model prose', () => {
    const artifact = formatOfficeArtifact('office.edit', [
      {
        format: 'xlsx',
        source: '/Users/me/Documents/売上.xlsx',
        output: '/Users/me/Documents/売上（Genie編集）.xlsx',
        summary: '合計を足した',
        changes: [{ where: '売上!B5', before: '', after: '=SUM(B2:B4)' }],
        skipped: ['シートの分からない変更を書いていません'],
      },
    ])!;
    expect(artifact.title).toBe('売上.xlsx の編集');
    expect(artifact.markdown).toContain('**原本は変えていません。**');
    expect(artifact.markdown).toContain('`/Users/me/Documents/売上（Genie編集）.xlsx`');
    expect(artifact.markdown).toContain('| 売上!B5 | — | =SUM(B2:B4) |');
    expect(artifact.markdown).toContain('書かなかった変更');
    expect(artifact.markdown).toContain('開いたときに計算されます');
    expect(formatOfficeArtifact('research', [])).toBeNull();
    expect(() => formatOfficeArtifact('office.edit', [{ output: 'x' }])).toThrow();
  });

  it('says plainly when no file was made', () => {
    const artifact = formatOfficeArtifact('office.edit', [
      {
        format: 'docx',
        source: '/Users/me/a.docx',
        output: null,
        summary: '',
        changes: [],
        skipped: [],
      },
    ])!;
    expect(artifact.markdown).toContain('**ファイルは作っていません。**');
  });
});
