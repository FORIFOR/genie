/**
 * ボードのリンク。LIFF の ID があれば LINE の中で開くリンク、無ければ公開の先頭の直のリンク。
 */
import { describe, expect, it } from 'vitest';
import { boardUrlFor } from '../src/routes/board.js';

const token = 'T'.repeat(32);

describe('board links', () => {
  it('opens inside LINE when a LIFF app is set', () => {
    expect(
      boardUrlFor({ publicUrl: 'https://genie.test', liffId: '2012248503-vYDHQHFo' })(token),
    ).toBe(`https://liff.line.me/2012248503-vYDHQHFo/${token}`);
  });

  it('falls back to the public link, and to none without one', () => {
    expect(boardUrlFor({ publicUrl: 'https://genie.test', liffId: null })(token)).toBe(
      `https://genie.test/v1/channels/board/${token}`,
    );
    // 形の違う ID は使わない
    expect(boardUrlFor({ publicUrl: 'https://genie.test', liffId: 'x/../y' })(token)).toBe(
      `https://genie.test/v1/channels/board/${token}`,
    );
    expect(boardUrlFor({ publicUrl: null, liffId: null })(token)).toBeNull();
  });
});
