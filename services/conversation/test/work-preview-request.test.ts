import { describe, expect, it } from 'vitest';
import { workPreviewRequest } from '../src/work-preview-request.js';

describe('workPreviewRequest', () => {
  it('finds the number, what it counts, and an optional folder', () => {
    expect(workPreviewRequest('端末を120台にしたら、提案書とスライドも合わせた案を作って')).toEqual({ to: 120, subject: '端末' });
    expect(workPreviewRequest('見積りの数量を150にした場合の資料を作って')).toEqual({ to: 150 });
    expect(workPreviewRequest('業務用端末の台数を1,000台に変えたら見積と提案書はどうなる？')).toEqual({ to: 1000, subject: '業務用端末' });
    expect(workPreviewRequest('~/Documents/A社案件 の端末を80台に減らした案件の書類を作って')).toEqual({ to: 80, subject: '端末', folder: '~/Documents/A社案件' });
  });

  it('leaves other requests alone', () => {
    for (const text of [
      '端末を120台にしたい', // 書類の話ではない
      '提案書を作って', // 変える数が無い
      '見積りの数量を変える方法を教えて',
      '~/Documents/見積.xlsx の数量を120にして', // ファイルを名指しした編集は office.edit
      '近くのご飯屋さんを教えて',
    ]) expect(workPreviewRequest(text), text).toBeNull();
  });
});
