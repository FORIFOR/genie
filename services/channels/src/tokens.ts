/**
 * 連携コードと、チャットのボタンに載せる承認の印。
 *
 * どちらも**推測できず、使い回せない**ことが要る。
 *   - 連携コード: 10 分・1 回だけ。DB にはハッシュだけを置く
 *   - 承認の印: 誰の・どの承認の・どちらの答えかを HMAC で縛り、期限を持たせる。
 *     ボタンを別の人が押しても、連携の照合で弾く（印だけでは承認できない）
 */
import { createHash, createHmac, randomInt } from 'node:crypto';
import { constantTimeEqual } from './slack.js';

/** 読み違えやすい字（0/O、1/I/L）を除いた 31 字。 */
const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
export const LINK_CODE_LENGTH = 8;
export const LINK_CODE_TTL_MS = 10 * 60 * 1000;

export function newLinkCode(): string {
  let code = '';
  for (let i = 0; i < LINK_CODE_LENGTH; i += 1)
    code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return code;
}

/** 入力の揺れ（小文字・空白・ハイフン）を吸収してから比べる。 */
export function normalizeLinkCode(input: string): string | null {
  const code = input.toUpperCase().replace(/[\s-]/g, '');
  return code.length === LINK_CODE_LENGTH && [...code].every((c) => CODE_ALPHABET.includes(c))
    ? code
    : null;
}

export function hashLinkCode(code: string): string {
  return createHash('sha256').update(`genie-channel-link:${code}`).digest('hex');
}

/** 「連携 ABCD2345」「link ABCD2345」。それ以外の発話は連携の試みとして扱わない。 */
export function linkCodeIn(text: string): string | null {
  const match = /^\s*(?:連携|れんけい|link)\s*[:：]?\s*([A-Za-z0-9-]{8,12})\s*$/i.exec(text);
  return match ? normalizeLinkCode(match[1]!) : null;
}

export interface ApprovalAction {
  readonly approvalId: string;
  readonly taskId: string;
  readonly linkId: string;
  readonly decision: 'APPROVED' | 'REJECTED';
  /** ms */
  readonly expiresAt: number;
}

/**
 * ボタンの値。LINE の postback data は 300 字までなので短く詰める。
 *   `a1.<approvalId>.<taskId>.<linkId>.<A|R>.<expires(36進)>.<sig>`
 */
export function signApprovalAction(secret: string, action: ApprovalAction): string {
  const body = [
    'a1',
    action.approvalId,
    action.taskId,
    action.linkId,
    action.decision === 'APPROVED' ? 'A' : 'R',
    action.expiresAt.toString(36),
  ].join('.');
  return `${body}.${sign(secret, body)}`;
}

export type ApprovalActionCheck =
  | { readonly ok: true; readonly action: ApprovalAction }
  | { readonly ok: false; readonly reason: 'malformed' | 'bad_signature' | 'expired' };

export function verifyApprovalAction(
  secret: string,
  value: string,
  now = Date.now(),
): ApprovalActionCheck {
  const parts = value.split('.');
  if (parts.length !== 7 || parts[0] !== 'a1') return { ok: false, reason: 'malformed' };
  const [, approvalId, taskId, linkId, decision, expires, signature] = parts as [
    string,
    string,
    string,
    string,
    string,
    string,
    string,
  ];
  const uuid = /^[0-9a-f-]{36}$/i;
  if (
    ![approvalId, taskId, linkId].every((id) => uuid.test(id)) ||
    (decision !== 'A' && decision !== 'R')
  ) {
    return { ok: false, reason: 'malformed' };
  }
  if (!constantTimeEqual(sign(secret, parts.slice(0, 6).join('.')), signature)) {
    return { ok: false, reason: 'bad_signature' };
  }
  const expiresAt = parseInt(expires, 36);
  if (!Number.isFinite(expiresAt) || expiresAt <= now) return { ok: false, reason: 'expired' };
  return {
    ok: true,
    action: {
      approvalId,
      taskId,
      linkId,
      decision: decision === 'A' ? 'APPROVED' : 'REJECTED',
      expiresAt,
    },
  };
}

/** 128 bit に切り詰めた HMAC-SHA256（base64url 22 字）。 */
function sign(secret: string, body: string): string {
  return createHmac('sha256', secret).update(body).digest().subarray(0, 16).toString('base64url');
}
