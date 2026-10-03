import { canonicalSha256 } from '@genie/contracts';
import { isTransactionAuthorizationApprovalActive, withTenant, type DbHandle } from '@genie/db';
import type { ApprovalProof } from '@genie/service-agent-host';

/**
 * その step の承認の跡を引く。正本 §9。
 *
 * **無ければ null。**作らない。ここで嘘の跡を組み立てると、
 * 端末側の検査が意味を失い、二重の錠が一重になる。
 */
export async function approvalProof(
  db: DbHandle,
  where: {
    tenantId: string;
    taskId: string;
    stepIndex: number;
    toolId: string;
    args: Record<string, unknown>;
  },
): Promise<ApprovalProof | null> {
  /*
   * 対応の無い tool には承認を渡さない。
   *
   * **渡してしまうと、端末側の検査が「承認あり」で素通しになる。**
   * 知らない tool は、そもそも端末が実行を断る側に倒す。
   */
  const operationId = OPERATION_FOR[where.toolId];
  if (!operationId) return null;

  const row = await withTenant(db, where.tenantId, (tx) =>
    tx
      .selectFrom('approvals')
      .select(['id', 'decided_by', 'decided_at', 'expires_at', 'details'])
      .where('task_id', '=', where.taskId)
      .where('step_index', '=', where.stepIndex)
      .where('status', '=', 'APPROVED')
      .executeTakeFirst(),
  );
  if (!row?.decided_by || !row.decided_at) return null;
  let inputsHash: string | undefined;
  if (where.toolId === 'transaction.submit') {
    const stored =
      row.details && typeof row.details === 'object'
        ? (row.details as Record<string, unknown>)['inputsHash']
        : undefined;
    if (
      typeof stored !== 'string' ||
      stored !== (await canonicalSha256(where.args)) ||
      row.expires_at.getTime() <= Date.now()
    )
      return null;
    inputsHash = stored;
    if (
      !(await withTenant(db, where.tenantId, (tx) =>
        isTransactionAuthorizationApprovalActive(tx, {
          approvalId: row.id,
          inputsHash: stored,
          taskId: where.taskId,
          stepIndex: where.stepIndex,
          now: new Date(),
        }),
      ))
    )
      return null;
  }

  return {
    approvalId: row.id,
    operationId,
    decision: 'APPROVED',
    decidedBy: row.decided_by,
    decidedAt: row.decided_at.toISOString(),
    expiresAt: row.expires_at.toISOString(),
    ...(inputsHash ? { inputsHash } : {}),
  };
}

/**
 * manifest の tool 名と、端末側の操作名の対応。
 *
 * 2 つの名前があるのは、manifest が製品の語彙（`mail.send`）で書かれ、
 * connector が提供者の語彙（`gmail.send`）で書かれているから。
 * **対応はここ 1 箇所に置く。**散らばると、承認が黙って効かなくなる。
 */
const OPERATION_FOR: Readonly<Record<string, string>> = {
  'mail.send': 'gmail.send',
  'outlook.mail.reply': 'outlook.mail.reply',
  'mail.trash': 'gmail.trash',
  'calendar.create_event': 'calendar.create',
  'computer.click': 'computer.click',
  'computer.type': 'computer.type',
  'computer.key': 'computer.key',
  'computer.run': 'computer.run',
  'transaction.submit': 'transaction.submit',
};
