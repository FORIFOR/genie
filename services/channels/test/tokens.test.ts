/**
 * 連携コードと承認の印。**推測できない・使い回せない・書き換えられない**。
 */
import { describe, expect, it } from 'vitest';
import {
  hashLinkCode,
  isAgentApprovalAction,
  linkCodeIn,
  newLinkCode,
  normalizeLinkCode,
  signAgentApprovalAction,
  signApprovalAction,
  verifyAgentApprovalAction,
  verifyApprovalAction,
} from '../src/tokens.js';

const secret = 'x'.repeat(32);
const action = {
  approvalId: '0190a5f0-0000-7000-8000-000000000001',
  taskId: '0190a5f0-0000-7000-8000-000000000002',
  linkId: '0190a5f0-0000-7000-8000-000000000003',
  decision: 'APPROVED' as const,
  expiresAt: 2_000_000_000_000,
};

describe('link codes', () => {
  it('are 8 unambiguous characters and only their hash is kept', () => {
    const code = newLinkCode();
    expect(code).toMatch(/^[2-9A-HJKMNP-Z]{8}$/);
    expect(hashLinkCode(code)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashLinkCode(code)).not.toContain(code);
  });

  it('are read from 「連携 XXXX」 with case, spaces and hyphens forgiven', () => {
    expect(linkCodeIn('連携 abcd-2345')).toBe('ABCD2345');
    expect(linkCodeIn('link: ABCD2345')).toBe('ABCD2345');
    expect(linkCodeIn('連携：ABCD2345')).toBe('ABCD2345');
    // 会話の途中に紛れたコードらしきものは連携にしない
    expect(linkCodeIn('競合を調べて ABCD2345')).toBeNull();
    expect(linkCodeIn('連携 ABCD0123')).toBeNull();
    expect(normalizeLinkCode('abc')).toBeNull();
  });
});

describe('approval action tokens', () => {
  it('round-trip and fit in a LINE postback (300 characters)', () => {
    const value = signApprovalAction(secret, action);
    expect(value.length).toBeLessThan(300);
    expect(verifyApprovalAction(secret, value, 1_000)).toEqual({ ok: true, action });
  });

  it('refuse a changed decision, another key, an expired button and garbage', () => {
    const value = signApprovalAction(secret, action);
    expect(verifyApprovalAction(secret, value.replace('.A.', '.R.'), 1_000)).toEqual({
      ok: false,
      reason: 'bad_signature',
    });
    expect(verifyApprovalAction('y'.repeat(32), value, 1_000)).toEqual({
      ok: false,
      reason: 'bad_signature',
    });
    expect(verifyApprovalAction(secret, value, action.expiresAt)).toEqual({
      ok: false,
      reason: 'expired',
    });
    expect(verifyApprovalAction(secret, 'a1.x', 1_000)).toEqual({ ok: false, reason: 'malformed' });
  });
});

describe('Claude Code approval buttons', () => {
  const secret = 'b'.repeat(40);
  const action = {
    approvalId: '01890000-0000-7000-8000-000000000001',
    linkId: '01890000-0000-7000-8000-000000000002',
    choice: 'instruct' as const,
    expiresAt: 2_000_000_000_000,
  };

  it('signs the approval, the link and the choice, and fits a LINE postback', () => {
    const value = signAgentApprovalAction(secret, action);
    expect(value.length).toBeLessThanOrEqual(300);
    expect(isAgentApprovalAction(value)).toBe(true);
    expect(verifyAgentApprovalAction(secret, value, 1_000)).toEqual({ ok: true, action });
  });

  it('refuses a changed choice, another key, an old button and the task-approval format', () => {
    const value = signAgentApprovalAction(secret, action);
    expect(verifyAgentApprovalAction(secret, value.replace('.I.', '.A.'), 1_000)).toEqual({
      ok: false,
      reason: 'bad_signature',
    });
    expect(verifyAgentApprovalAction('c'.repeat(40), value, 1_000).ok).toBe(false);
    expect(verifyAgentApprovalAction(secret, value, action.expiresAt)).toEqual({
      ok: false,
      reason: 'expired',
    });
    expect(verifyAgentApprovalAction(secret, 'a1.x.y.z.A.1.sig', 1_000)).toEqual({
      ok: false,
      reason: 'malformed',
    });
  });
});
