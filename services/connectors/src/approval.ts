/**
 * 破壊的な操作の手前に置く関門。正本 §9、UI/UX §14.1。
 *
 * 承認は上位（policy engine / Approval service）が取る。ここは**もう一段の錠**で、
 * 承認の跡を持たない呼び出しを実行させない。
 *
 * 二重にする理由: 承認を通す経路が 1 本だけだと、いつか誰かが
 * 「この呼び出しだけ直接」と近道を作り、それが既定になる。
 * connector 側が承認の跡を要求していれば、その近道は型で止まる。
 */
import type { ActionRisk } from '@genie/contracts';
import { ConnectorError } from './http.js';

/** 承認された事実。**上位が発行し、connector が検証する。** */
export interface ApprovalProof {
  readonly approvalId: string;
  /** どの操作に対する承認か。ずれていたら使わせない。 */
  readonly operationId: string;
  readonly decision: 'APPROVED' | 'REJECTED';
  readonly decidedBy: string;
  readonly decidedAt: string;
  readonly expiresAt: string;
  /** Exact approved tool arguments, when the operation requires content binding. */
  readonly inputsHash?: string;
}

/** connector の 1 操作。**必要な許可と危険度を、操作ごとに持つ。** */
export interface OperationDecl {
  readonly id: string;
  readonly scope: string;
  readonly risk: ActionRisk;
  /** 人の承認が要るか。`risk` から導かず、操作ごとに書く。 */
  readonly requiresApproval: boolean;
}

export class ApprovalRequired extends Error {
  readonly operation: OperationDecl;
  constructor(operation: OperationDecl) {
    super(`${operation.id} needs a person to approve it first`);
    this.name = 'ApprovalRequired';
    this.operation = operation;
  }
}

/**
 * 承認の跡を確かめる。**通らなければ実行しない。**
 *
 * 期限切れを弾くのは、承認の意味が時間とともに薄れるから。
 * 「3 日前に一度 OK が出ている」で今日送ってよい理由にはならない。
 */
export function requireApproval(
  operation: OperationDecl,
  proof: ApprovalProof | undefined,
  now: Date,
): void {
  if (!operation.requiresApproval) return;
  if (!proof) throw new ApprovalRequired(operation);
  if (proof.operationId !== operation.id) throw new ApprovalRequired(operation);
  if (proof.decision !== 'APPROVED') throw new ApprovalRequired(operation);
  if (Date.parse(proof.expiresAt) <= now.getTime()) throw new ApprovalRequired(operation);
  if (!proof.decidedBy) throw new ApprovalRequired(operation);
}

/** 許可の範囲が足りているか。**要求ではなく、実際に許された scope で見る。** */
export function requireScope(operation: OperationDecl, granted: readonly string[]): void {
  if (!granted.includes(operation.scope)) {
    throw new ConnectorError(
      'insufficient_scope',
      `${operation.id} needs ${operation.scope}, which was not granted`,
    );
  }
}
