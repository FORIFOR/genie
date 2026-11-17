import {
  GenieError,
  MAX_TRANSACTION_AUTHORIZATION_TTL_MS,
  TransactionAuthorization,
  TransactionAuthorizationSpec,
  canonicalSha256,
  evaluateTransactionAuthorization,
  validateTransactionSubmitArgs,
  uuidv7,
  type TransactionSubmitArgs,
} from '@genie/contracts';
import { withTenant, type Approvals, type DbHandle, type ScopedDb } from '@genie/db';
import type { Selectable } from 'kysely';
import { approvalTtlMs } from '@genie/policy';
import { appendAuditEvent } from '@genie/telemetry';

export interface DerivedTransactionApproval {
  readonly approvalId: string;
  readonly authorizationId: string;
  readonly inputsHash: string;
  readonly expiresAt: string;
}
interface AuthorizationRow {
  id: string;
  created_by: string;
  created_at: Date;
  revoked_at: Date | null;
  spec: unknown;
  spec_hash: string;
  status: string;
  expires_at: Date;
}
interface InitialApproval {
  approval: Selectable<Approvals>;
  details: Record<string, unknown>;
  args: TransactionSubmitArgs;
  inputsHash: string;
}
function conflict(reason: string): never {
  throw new GenieError('common.conflict', reason);
}
const detailsOf = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

/** The only writer for bounded consent. This is not exposed as an agent tool. */
export class TransactionAuthorizationService {
  readonly #db: DbHandle;
  readonly #now: () => Date;
  constructor(options: { db: DbHandle; now?: () => Date }) {
    this.#db = options.db;
    this.#now = options.now ?? (() => new Date());
  }

  async #usage(
    tx: ScopedDb,
    authorizationId: string,
  ): Promise<{ usedOrders: number; usedTotalMinor: number }> {
    const uses = await tx
      .selectFrom('transaction_authorization_uses')
      .select('amount_minor')
      .where('authorization_id', '=', authorizationId)
      .execute();
    const usedTotalMinor = uses.reduce((sum, row) => sum + Number(row.amount_minor), 0);
    if (!Number.isSafeInteger(usedTotalMinor) || usedTotalMinor < 0 || uses.length > 1000)
      conflict('authorization_ledger_invalid');
    return { usedOrders: uses.length, usedTotalMinor };
  }

  async #record(tx: ScopedDb, row: AuthorizationRow): Promise<TransactionAuthorization> {
    const spec = TransactionAuthorizationSpec.parse(row.spec);
    if (
      (await canonicalSha256(spec)) !== row.spec_hash ||
      Date.parse(spec.expiresAt) !== row.expires_at.getTime()
    )
      conflict('authorization_record_invalid');
    return TransactionAuthorization.parse({
      id: row.id,
      createdBy: row.created_by,
      createdAt: row.created_at.toISOString(),
      status: row.status,
      revokedAt: row.revoked_at?.toISOString() ?? null,
      spec,
      ...(await this.#usage(tx, row.id)),
    });
  }

  /** A human request id prevents a retried create from multiplying the authorized budget. */
  async create(input: {
    tenantId: string;
    userId: string;
    requestId: string;
    spec: unknown;
    approvalId?: string;
  }): Promise<{ authorization: TransactionAuthorization; approvalId?: string }> {
    const spec = TransactionAuthorizationSpec.parse(input.spec);
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(input.requestId))
      throw new GenieError('common.validation_failed', 'authorization_request_id_required');
    const at = this.#now(),
      specHash = await canonicalSha256(spec);
    return withTenant(this.#db, input.tenantId, async (tx) => {
      // Returning a creation receipt is not a fresh authorization or quota use.
      // Recover a lost response even if the task ended, the grant expired or it
      // was revoked in the meantime. The caller must not resume inactive grants.
      const previousReceipt = async () => {
        const row = await tx
          .selectFrom('transaction_authorizations')
          .selectAll()
          .where('created_by', '=', input.userId)
          .where('request_id', '=', input.requestId)
          .executeTakeFirst();
        if (!row) return null;
        if (row.spec_hash !== specHash || row.initial_approval_id !== (input.approvalId ?? null))
          conflict('authorization_request_changed');
        return {
          authorization: await this.#record(tx, row),
          ...(row.initial_approval_id ? { approvalId: row.initial_approval_id } : {}),
        };
      };
      const previous = await previousReceipt();
      if (previous) return previous;
      if (
        Date.parse(spec.expiresAt) <= at.getTime() ||
        Date.parse(spec.expiresAt) > at.getTime() + MAX_TRANSACTION_AUTHORIZATION_TTL_MS
      )
        throw new GenieError('common.validation_failed', 'authorization_expiry_out_of_range');
      // Take the task lock before a grant lock, matching deriveApproval's order.
      // The approval's stored exact args are the authority for the first use.
      let initial: InitialApproval | undefined;
      if (input.approvalId) {
        try {
          initial = await this.#initialApproval(tx, input.userId, input.approvalId);
        } catch (error) {
          // A simultaneous first request can commit while this one waits for the
          // task lock. Re-read its receipt before interpreting terminal state.
          const concurrent = await previousReceipt();
          if (concurrent) return concurrent;
          throw error;
        }
      }
      const added = await tx
        .insertInto('transaction_authorizations')
        .values({
          id: uuidv7(),
          tenant_id: input.tenantId,
          created_by: input.userId,
          request_id: input.requestId,
          initial_approval_id: input.approvalId ?? null,
          spec: JSON.stringify(spec),
          spec_hash: specHash,
          status: 'ACTIVE',
          created_at: at,
          expires_at: new Date(spec.expiresAt),
          revoked_at: null,
        })
        .onConflict((oc) => oc.columns(['tenant_id', 'created_by', 'request_id']).doNothing())
        .returningAll()
        .executeTakeFirst();
      const row =
        added ??
        (await tx
          .selectFrom('transaction_authorizations')
          .selectAll()
          .where('created_by', '=', input.userId)
          .where('request_id', '=', input.requestId)
          .executeTakeFirstOrThrow());
      if (row.spec_hash !== specHash || row.initial_approval_id !== (input.approvalId ?? null))
        conflict('authorization_request_changed');
      if (initial && added)
        await this.#consumeInitial(tx, input.tenantId, input.userId, row, initial);
      if (added)
        await appendAuditEvent(tx, input.tenantId, {
          actorType: 'user',
          actorId: input.userId,
          action: 'transaction.authorization.created',
          payload: { authorization_id: row.id, spec_hash: specHash },
        });
      return {
        authorization: await this.#record(tx, row),
        ...(row.initial_approval_id ? { approvalId: row.initial_approval_id } : {}),
      };
    });
  }

  async #initialApproval(
    tx: ScopedDb,
    userId: string,
    approvalId: string,
  ): Promise<InitialApproval> {
    const found = await tx
      .selectFrom('approvals')
      .select('task_id')
      .where('id', '=', approvalId)
      .executeTakeFirst();
    if (!found) throw new GenieError('common.not_found', 'approval_not_found');
    const task = await tx
      .selectFrom('tasks')
      .selectAll()
      .where('id', '=', found.task_id)
      .forUpdate()
      .executeTakeFirst();
    if (
      !task ||
      task.created_by !== userId ||
      !['RUNNING', 'WAITING_APPROVAL', 'PAUSED_HOST_OFFLINE'].includes(task.status)
    )
      conflict('authorization_task_inactive');
    const approval = await tx
      .selectFrom('approvals')
      .selectAll()
      .where('id', '=', approvalId)
      .forUpdate()
      .executeTakeFirstOrThrow();
    const details = detailsOf(approval.details);
    if (
      approval.risk !== 'FINANCIAL' ||
      approval.expires_at.getTime() <= this.#now().getTime() ||
      !['PENDING', 'APPROVED'].includes(approval.status) ||
      !details['transactionSubmitArgs']
    )
      conflict('authorization_initial_approval_invalid');
    const instruction = await tx
      .selectFrom('task_instructions')
      .select('request_id')
      .where('task_id', '=', task.id)
      .where('status', '=', 'RECEIVED')
      .executeTakeFirst();
    if (instruction) conflict('authorization_instruction_pending');
    const args = await validateTransactionSubmitArgs(
      details['transactionSubmitArgs'],
      this.#now().getTime(),
    );
    const inputsHash = await canonicalSha256(args);
    if (details['inputsHash'] !== inputsHash) conflict('authorization_initial_approval_changed');
    return { approval, details, args, inputsHash };
  }

  async #consumeInitial(
    tx: ScopedDb,
    tenantId: string,
    userId: string,
    row: AuthorizationRow,
    initial: InitialApproval,
  ) {
    const { approval, details, args, inputsHash } = initial;
    // The newly inserted row is owned by this transaction; a retried create locks
    // the existing grant before reading quota or accepting an old reservation.
    const locked = await tx
      .selectFrom('transaction_authorizations')
      .selectAll()
      .where('id', '=', row.id)
      .forUpdate()
      .executeTakeFirstOrThrow();
    const grant = await this.#record(tx, locked);
    if (grant.status !== 'ACTIVE' || Date.parse(grant.spec.expiresAt) <= this.#now().getTime())
      conflict('authorization_inactive');
    const previous = await tx
      .selectFrom('transaction_authorization_uses')
      .selectAll()
      .where('approval_id', '=', approval.id)
      .executeTakeFirst();
    if (previous) {
      if (
        approval.status !== 'APPROVED' ||
        previous.authorization_id !== grant.id ||
        previous.inputs_hash !== inputsHash ||
        details['authorizationId'] !== grant.id ||
        details['authorizationHash'] !== locked.spec_hash
      )
        conflict('authorization_initial_approval_changed');
      return;
    }
    if (approval.status !== 'PENDING') conflict('authorization_initial_approval_invalid');
    const evaluated = await evaluateTransactionAuthorization(
      grant.spec,
      args,
      { usedOrders: grant.usedOrders, usedTotalMinor: grant.usedTotalMinor },
      this.#now().getTime(),
    );
    if (!evaluated.allowed) conflict(`authorization_initial_${evaluated.reason}`);
    const reservation = await tx
      .insertInto('transaction_authorization_uses')
      .values({
        id: uuidv7(),
        tenant_id: tenantId,
        authorization_id: grant.id,
        approval_id: approval.id,
        task_id: approval.task_id,
        step_index: approval.step_index,
        provider: args.quote.provider,
        mode: args.quote.mode,
        account: args.quote.account,
        order_key: args.quote.orderKey,
        inputs_hash: inputsHash,
        quote_hash: args.quoteHash,
        amount_minor: evaluated.amountMinor,
        created_at: this.#now(),
      })
      .onConflict((oc) =>
        oc.columns(['tenant_id', 'provider', 'mode', 'account', 'order_key']).doNothing(),
      )
      .returning('id')
      .executeTakeFirst();
    if (!reservation) conflict('authorization_order_reused');
    await tx
      .updateTable('approvals')
      .set({
        status: 'APPROVED',
        decided_by: userId,
        decided_at: this.#now(),
        expires_at: new Date(
          Math.min(
            approval.expires_at.getTime(),
            Date.parse(grant.spec.expiresAt),
            Date.parse(args.quote.expiresAt),
          ),
        ),
        details: JSON.stringify({
          ...details,
          authorizationId: grant.id,
          authorizationHash: locked.spec_hash,
        }),
        decision_note:
          'Explicit bounded authorization; quota reservation is not refunded after failure or unknown outcome.',
      })
      .where('id', '=', approval.id)
      .where('status', '=', 'PENDING')
      .executeTakeFirstOrThrow();
    await appendAuditEvent(tx, tenantId, {
      actorType: 'system',
      action: 'transaction.authorization.reserved',
      taskId: approval.task_id,
      payload: {
        authorization_id: grant.id,
        approval_id: approval.id,
        inputs_hash: inputsHash,
        amount_minor: evaluated.amountMinor,
      },
    });
  }

  async list(tenantId: string, userId: string): Promise<TransactionAuthorization[]> {
    return withTenant(this.#db, tenantId, async (tx) => {
      const rows = await tx
        .selectFrom('transaction_authorizations')
        .selectAll()
        .where('created_by', '=', userId)
        .orderBy('created_at', 'desc')
        .limit(100)
        .execute();
      return Promise.all(rows.map((row) => this.#record(tx, row)));
    });
  }

  async revoke(input: {
    tenantId: string;
    userId: string;
    authorizationId: string;
  }): Promise<TransactionAuthorization> {
    return withTenant(this.#db, input.tenantId, async (tx) => {
      const row = await tx
        .selectFrom('transaction_authorizations')
        .selectAll()
        .where('id', '=', input.authorizationId)
        .where('created_by', '=', input.userId)
        .forUpdate()
        .executeTakeFirst();
      if (!row) throw new GenieError('common.not_found', 'authorization_not_found');
      if (row.status === 'REVOKED') return this.#record(tx, row);
      const updated = await tx
        .updateTable('transaction_authorizations')
        .set({ status: 'REVOKED', revoked_at: this.#now() })
        .where('id', '=', row.id)
        .returningAll()
        .executeTakeFirstOrThrow();
      await appendAuditEvent(tx, input.tenantId, {
        actorType: 'user',
        actorId: input.userId,
        action: 'transaction.authorization.revoked',
        payload: { authorization_id: row.id },
      });
      return this.#record(tx, updated);
    });
  }

  /** Reserve quota and mint a normal exact-input approval in the SAME transaction. */
  async deriveApproval(input: {
    tenantId: string;
    userId: string;
    taskId: string;
    stepIndex: number;
    args: unknown;
    summary: string;
    details: Record<string, unknown>;
  }): Promise<DerivedTransactionApproval | null> {
    const at = this.#now();
    const args = await validateTransactionSubmitArgs(input.args, at.getTime());
    const inputsHash = await canonicalSha256(args);
    return withTenant(this.#db, input.tenantId, async (tx) => {
      const task = await tx
        .selectFrom('tasks')
        .select(['status', 'created_by'])
        .where('id', '=', input.taskId)
        .forUpdate()
        .executeTakeFirst();
      if (
        !task ||
        task.created_by !== input.userId ||
        !['RUNNING', 'WAITING_APPROVAL', 'PAUSED_HOST_OFFLINE'].includes(task.status)
      )
        conflict('authorization_task_inactive');
      const instruction = await tx
        .selectFrom('task_instructions')
        .select('request_id')
        .where('task_id', '=', input.taskId)
        .where('status', '=', 'RECEIVED')
        .executeTakeFirst();
      if (instruction) conflict('authorization_instruction_pending');
      const existing = await tx
        .selectFrom('approvals')
        .selectAll()
        .where('task_id', '=', input.taskId)
        .where('step_index', '=', input.stepIndex)
        .executeTakeFirst();
      if (existing) {
        const details = detailsOf(existing.details);
        if (typeof details['authorizationId'] !== 'string') return null;
        const grant = await tx
          .selectFrom('transaction_authorizations')
          .selectAll()
          .where('id', '=', details['authorizationId'])
          .where('created_by', '=', input.userId)
          .forUpdate()
          .executeTakeFirst();
        const use = await tx
          .selectFrom('transaction_authorization_uses')
          .selectAll()
          .where('approval_id', '=', existing.id)
          .executeTakeFirst();
        if (
          !grant ||
          grant.status !== 'ACTIVE' ||
          grant.expires_at.getTime() <= this.#now().getTime() ||
          existing.status !== 'APPROVED' ||
          existing.expires_at.getTime() <= this.#now().getTime() ||
          details['inputsHash'] !== inputsHash ||
          details['authorizationHash'] !== grant.spec_hash ||
          !use ||
          use.inputs_hash !== inputsHash ||
          use.authorization_id !== grant.id
        )
          conflict('authorization_derived_approval_stale');
        await this.#record(tx, grant);
        return {
          approvalId: existing.id,
          authorizationId: grant.id,
          inputsHash,
          expiresAt: existing.expires_at.toISOString(),
        };
      }
      // An order identity may never migrate to another task or another grant.
      const used = await tx
        .selectFrom('transaction_authorization_uses')
        .select('id')
        .where('provider', '=', args.quote.provider)
        .where('mode', '=', args.quote.mode)
        .where('account', '=', args.quote.account)
        .where('order_key', '=', args.quote.orderKey)
        .executeTakeFirst();
      if (used) conflict('authorization_order_reused');
      const candidates = await tx
        .selectFrom('transaction_authorizations')
        .selectAll()
        .where('created_by', '=', input.userId)
        .where('status', '=', 'ACTIVE')
        .where('expires_at', '>', at)
        .orderBy('id', 'asc')
        .forUpdate()
        .execute();
      for (const candidate of candidates) {
        const grant = await this.#record(tx, candidate);
        const evaluation = await evaluateTransactionAuthorization(
          grant.spec,
          args,
          { usedOrders: grant.usedOrders, usedTotalMinor: grant.usedTotalMinor },
          this.#now().getTime(),
        );
        if (!evaluation.allowed) continue;
        const approvalId = uuidv7();
        const expiresAt = new Date(
          Math.min(
            Date.parse(args.quote.expiresAt),
            Date.parse(grant.spec.expiresAt),
            this.#now().getTime() + approvalTtlMs('FINANCIAL'),
          ),
        );
        await tx
          .insertInto('approvals')
          .values({
            id: approvalId,
            tenant_id: input.tenantId,
            task_id: input.taskId,
            step_index: input.stepIndex,
            risk: 'FINANCIAL',
            summary: input.summary,
            details: JSON.stringify({
              ...input.details,
              inputsHash,
              authorizationId: grant.id,
              authorizationHash: candidate.spec_hash,
            }),
            editable_fields: JSON.stringify([]),
            status: 'APPROVED',
            expires_at: expiresAt,
            decided_by: input.userId,
            decided_at: this.#now(),
            decision_note:
              'Explicit bounded authorization; quota reservation is not refunded after failure or unknown outcome.',
            created_at: this.#now(),
          })
          .execute();
        const reservation = await tx
          .insertInto('transaction_authorization_uses')
          .values({
            id: uuidv7(),
            tenant_id: input.tenantId,
            authorization_id: grant.id,
            approval_id: approvalId,
            task_id: input.taskId,
            step_index: input.stepIndex,
            provider: args.quote.provider,
            mode: args.quote.mode,
            account: args.quote.account,
            order_key: args.quote.orderKey,
            inputs_hash: inputsHash,
            quote_hash: args.quoteHash,
            amount_minor: evaluation.amountMinor,
            created_at: this.#now(),
          })
          .onConflict((oc) =>
            oc.columns(['tenant_id', 'provider', 'mode', 'account', 'order_key']).doNothing(),
          )
          .returning('id')
          .executeTakeFirst();
        if (!reservation) conflict('authorization_order_reused'); // rollback derived approval too
        await appendAuditEvent(tx, input.tenantId, {
          actorType: 'system',
          action: 'transaction.authorization.reserved',
          taskId: input.taskId,
          payload: {
            authorization_id: grant.id,
            approval_id: approvalId,
            inputs_hash: inputsHash,
            amount_minor: evaluation.amountMinor,
          },
        });
        return {
          approvalId,
          authorizationId: grant.id,
          inputsHash,
          expiresAt: expiresAt.toISOString(),
        };
      }
      return null;
    });
  }
}
