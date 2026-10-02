import { beforeEach, describe, expect, it, vi } from 'vitest';
import { canonicalSha256 } from '@genie/contracts';
import type { DbHandle } from '@genie/db';

const state = vi.hoisted(() => ({ row: null as unknown, authority: true }));
vi.mock('@genie/db', () => ({
  isTransactionAuthorizationApprovalActive: async () => state.authority,
  withTenant: async (_db: unknown, _tenant: string, run: (tx: unknown) => unknown) => {
    const query = {
      selectFrom: () => query,
      select: () => query,
      where: () => query,
      executeTakeFirst: async () => state.row,
    };
    return run(query);
  },
}));
import { approvalProof } from '../src/approval-proof.js';

const where = {
  tenantId: 'tenant',
  taskId: 'task',
  stepIndex: 1,
  toolId: 'transaction.submit',
  args: { intent: { orderKey: 'order-1' }, quote: { total: 100 }, quoteHash: 'a'.repeat(64) },
};
const db = {} as DbHandle;
beforeEach(() => {
  state.row = null;
  state.authority = true;
});
describe('transaction dispatch approval proof', () => {
  async function approved(details: unknown) {
    state.row = {
      id: 'approval',
      decided_by: 'user',
      decided_at: new Date(),
      expires_at: new Date(Date.now() + 60000),
      details,
    };
  }
  it('returns the persisted binding only when exact dispatch contents match', async () => {
    const inputsHash = await canonicalSha256(where.args);
    await approved({ inputsHash });
    expect(await approvalProof(db, where)).toMatchObject({
      operationId: 'transaction.submit',
      inputsHash,
    });
    expect(
      await approvalProof(db, { ...where, args: { ...where.args, quote: { total: 101 } } }),
    ).toBeNull();
    expect(
      await approvalProof(db, { ...where, args: { ...where.args, extra: 'metadata' } }),
    ).toBeNull();
  });
  it('fails closed for old unbound or expired approvals', async () => {
    await approved({ items: [] });
    expect(await approvalProof(db, where)).toBeNull();
    await approved({ inputsHash: await canonicalSha256(where.args) });
    (state.row as { expires_at: Date }).expires_at = new Date(0);
    expect(await approvalProof(db, where)).toBeNull();
  });
  it('does not export a proof after the shared authorization gate denies it', async () => {
    await approved({ inputsHash: await canonicalSha256(where.args) });
    state.authority = false;
    expect(await approvalProof(db, where)).toBeNull();
  });
  it('keeps existing mail proof behavior and never issues transaction proofs for prepare/reconcile', async () => {
    await approved({ items: [] });
    expect(await approvalProof(db, { ...where, toolId: 'mail.send' })).toMatchObject({
      operationId: 'gmail.send',
    });
    expect(await approvalProof(db, { ...where, toolId: 'transaction.prepare' })).toBeNull();
    expect(await approvalProof(db, { ...where, toolId: 'transaction.reconcile' })).toBeNull();
  });
});
