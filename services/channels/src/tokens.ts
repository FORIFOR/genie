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

/** Claude Code の承認のボタン（agent-approvals）。承認・拒否・指示を添える・同種を許可。 */
export interface AgentApprovalAction {
  readonly approvalId: string;
  readonly linkId: string;
  /** answer_<何問目>_<何番目> は Claude Code の質問の選択肢（0 から、どちらも 0〜3）。 */
  readonly choice:
    | 'allow'
    | 'deny'
    | 'instruct'
    | 'allow_session'
    | 'allow_project'
    | `answer_${number}_${number}`;
  /** ms */
  readonly expiresAt: number;
}

const CHOICE_CODE = {
  allow: 'A',
  deny: 'R',
  instruct: 'I',
  // 今回を許可して、同種の操作を続けて許可する（このセッション / このプロジェクト）
  allow_session: 'S',
  allow_project: 'P',
} as const;

/** 質問の選択肢は 2 桁の数字（何問目・何番目）。それ以外は 1 文字。 */
const ANSWER = /^answer_([0-3])_([0-3])$/;
const ANSWER_CODE = /^([0-3])([0-3])$/;

function choiceCode(choice: AgentApprovalAction['choice']): string {
  const answer = ANSWER.exec(choice);
  if (answer) return `${answer[1]!}${answer[2]!}`;
  if (choice in CHOICE_CODE) return CHOICE_CODE[choice as keyof typeof CHOICE_CODE];
  throw new Error('unknown choice');
}

/**
 * `c1.<approvalId>.<linkId>.<A|R|I|S|P|質問の 2 桁>.<expires(36進)>.<sig>`
 * （Genie の仕事の承認 a1 とは別の形）。
 */
export function signAgentApprovalAction(secret: string, action: AgentApprovalAction): string {
  const body = [
    'c1',
    action.approvalId,
    action.linkId,
    choiceCode(action.choice),
    action.expiresAt.toString(36),
  ].join('.');
  return `${body}.${sign(secret, body)}`;
}

export function isAgentApprovalAction(value: string): boolean {
  return value.startsWith('c1.');
}

export function verifyAgentApprovalAction(
  secret: string,
  value: string,
  now = Date.now(),
):
  | { readonly ok: true; readonly action: AgentApprovalAction }
  | { readonly ok: false; readonly reason: 'malformed' | 'bad_signature' | 'expired' } {
  const parts = value.split('.');
  if (parts.length !== 6 || parts[0] !== 'c1') return { ok: false, reason: 'malformed' };
  const [, approvalId, linkId, code, expires, signature] = parts as [
    string,
    string,
    string,
    string,
    string,
    string,
  ];
  const uuid = /^[0-9a-f-]{36}$/i;
  const answer = ANSWER_CODE.exec(code);
  const choice: AgentApprovalAction['choice'] | undefined = answer
    ? `answer_${Number(answer[1])}_${Number(answer[2])}`
    : (Object.keys(CHOICE_CODE) as (keyof typeof CHOICE_CODE)[]).find(
        (k) => CHOICE_CODE[k] === code,
      );
  if (![approvalId, linkId].every((id) => uuid.test(id)) || !choice)
    return { ok: false, reason: 'malformed' };
  if (!constantTimeEqual(sign(secret, parts.slice(0, 5).join('.')), signature))
    return { ok: false, reason: 'bad_signature' };
  const expiresAt = parseInt(expires, 36);
  if (!Number.isFinite(expiresAt) || expiresAt <= now) return { ok: false, reason: 'expired' };
  return { ok: true, action: { approvalId, linkId, choice, expiresAt } };
}
