import { describe, expect, it } from 'vitest';
import { officeEditRequest } from '../src/office-request.js';

describe('a request to edit a Word or Excel file', () => {
  it('is found when it names the file and asks for a change', () => {
    expect(officeEditRequest('~/Documents/週次報告.docx の売上を135万円に直して')).toEqual({
      path: '~/Documents/週次報告.docx',
      instruction: '~/Documents/週次報告.docx の売上を135万円に直して',
    });
    expect(officeEditRequest('「~/Desktop/売上 2026.xlsx」に合計の行を追加して')?.path).toBe(
      '~/Desktop/売上 2026.xlsx',
    );
    expect(officeEditRequest('/Users/me/Documents/見積.xlsx の税込列を式で計算して')?.path).toBe(
      '/Users/me/Documents/見積.xlsx',
    );
  });

  it('is not found without a file location, a change, or when asking how', () => {
    for (const text of [
      'Excel の合計を直して',
      '~/Documents/報告.docx を要約して',
      '~/Documents/報告.docx の直し方を教えて',
      '~/Documents/報告.pdf を直して',
    ])
      expect(officeEditRequest(text), text).toBeNull();
  });
});
