import { TransactionAuthorizationSpec, canonicalSha256 } from '@genie/contracts';
import type { ScopedDb } from './tenant.js';

/** Read-only dispatch gate shared by task workers and the claimed-host authority poll. */
export async function isTransactionAuthorizationApprovalActive(
  tx: ScopedDb,
  input: {
    approvalId: string;
    now: Date;
    inputsHash?: string;
    userId?: string;
    taskId?: string;
    stepIndex?: number;
  },
): Promise<boolean> {
  const approval = await tx
    .selectFrom('approvals')
    .selectAll()
    .where('id', '=', input.approvalId)
    .executeTakeFirst();
  if (
    !approval ||
    approval.status !== 'APPROVED' ||
    approval.expires_at.getTime() <= input.now.getTime() ||
    (input.userId !== undefined && approval.decided_by !== input.userId)
  )
    return false;
  if (
    (input.taskId !== undefined && approval.task_id !== input.taskId) ||
    (input.stepIndex !== undefined && approval.step_index !== input.stepIndex)
  )
    return false;
  const details =
    approval.details && typeof approval.details === 'object' && !Array.isArray(approval.details)
      ? (approval.details as Record<string, unknown>)
      : {};
  if (input.inputsHash !== undefined && details['inputsHash'] !== input.inputsHash) return false;
  if (details['authorizationId'] === undefined) return true; // Existing one-order human approval.
  if (typeof details['authorizationId'] !== 'string') return false;
  const grant = await tx
    .selectFrom('transaction_authorizations')
    .selectAll()
    .where('id', '=', details['authorizationId'])
    .executeTakeFirst();
  if (
    !grant ||
    grant.status !== 'ACTIVE' ||
    grant.expires_at.getTime() <= input.now.getTime() ||
    grant.created_by !== approval.decided_by ||
    details['authorizationHash'] !== grant.spec_hash
  )
    return false;
  const spec = TransactionAuthorizationSpec.safeParse(grant.spec);
  if (
    !spec.success ||
    Date.parse(spec.data.expiresAt) !== grant.expires_at.getTime() ||
    (await canonicalSha256(spec.data)) !== grant.spec_hash
  )
    return false;
  const use = await tx
    .selectFrom('transaction_authorization_uses')
    .selectAll()
    .where('approval_id', '=', approval.id)
    .executeTakeFirst();
  return (
    !!use &&
    use.authorization_id === grant.id &&
    use.task_id === approval.task_id &&
    use.step_index === approval.step_index &&
    use.inputs_hash === details['inputsHash']
  );
}
