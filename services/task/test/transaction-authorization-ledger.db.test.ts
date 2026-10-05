/** Real PostgreSQL locks/RLS; provider execution is deliberately absent. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  canonicalSha256,
  TransactionIntent,
  transactionAuthorizationScope,
  uuidv7,
} from '@genie/contracts';
import {
  createDb,
  withIdentity,
  withTenant,
  isTransactionAuthorizationApprovalActive,
  type DbHandle,
} from '@genie/db';
import { TransactionAuthorizationService } from '../src/transaction-authorizations.js';
import { HostBridge } from '../../agent-host/src/bridge.js';
import { HostStepExecutor } from '../../agent-host/src/step-executor.js';
import { AgentHostService } from '../../agent-host/src/service.js';
import { approvalProof } from '../../../workers/task-worker/src/approval-proof.js';
import { NOW, transactionFixture } from './transaction-fixture.js';

const exec = promisify(execFile);
const url = process.env['TEST_DATABASE_URL'];
describe.skipIf(!url)('bounded authorization atomic ledger', () => {
  let db: DbHandle, service: TransactionAuthorizationService;
  const tenantId = uuidv7(),
    userId = uuidv7(),
    otherTenant = uuidv7(),
    otherUser = uuidv7();
  let clock = NOW.getTime();
  beforeAll(async () => {
    db = createDb({
      url: url!,
      identityUrl: process.env['TEST_IDENTITY_DATABASE_URL'],
      maxConnections: 8,
      identityMaxConnections: 2,
      idleTimeoutMillis: 5000,
      connectionTimeoutMillis: 5000,
      statementTimeoutMillis: 20000,
      applicationName: 'genie-bounded-authorization-test',
    });
    service = new TransactionAuthorizationService({ db, now: () => new Date(clock) });
    await withIdentity(db, async (tx) => {
      for (const [tenant, user] of [
        [tenantId, userId],
        [otherTenant, otherUser],
      ]) {
        await tx
          .insertInto('tenants')
          .values({ id: tenant!, name: 'Bounded test', kind: 'personal' })
          .execute();
        await tx
          .insertInto('users')
          .values({
            id: user!,
            email: `bound-${user}@example.invalid`,
            display_name: 'Bounded test',
          })
          .execute();
        await tx
          .insertInto('memberships')
          .values({ tenant_id: tenant!, user_id: user!, role: 'owner' })
          .execute();
      }
    });
  });
  afterAll(async () => db?.close());
  async function fixture() {
    clock = NOW.getTime();
    const f = await transactionFixture();
    f.intent.provider = `fixture-${uuidv7()}`;
    f.quote.provider = f.intent.provider;
    f.submitArgs.quoteHash = await canonicalSha256(f.quote);
    const spec = {
      scope: transactionAuthorizationScope(TransactionIntent.parse(f.intent)),
      maxPerOrderMinor: 3000,
      maxTotalMinor: 7050,
      maxOrders: 3,
      expiresAt: new Date(clock + 3600_000).toISOString(),
    };
    return { ...f, spec };
  }
  async function task(status = 'RUNNING') {
    const id = uuidv7();
    await withTenant(db, tenantId, (tx) =>
      tx
        .insertInto('tasks')
        .values({
          id,
          tenant_id: tenantId,
          created_by: userId,
          kind: 'transaction.order',
          status,
          input: '{}',
          idempotency_key: id,
          workflow_id: id,
        })
        .execute(),
    );
    return id;
  }
  async function pending(args: unknown) {
    const taskId = await task('WAITING_APPROVAL'),
      approvalId = uuidv7();
    const details = { inputsHash: await canonicalSha256(args), transactionSubmitArgs: args };
    await withTenant(db, tenantId, (tx) =>
      tx
        .insertInto('approvals')
        .values({
          id: approvalId,
          tenant_id: tenantId,
          task_id: taskId,
          step_index: 1,
          risk: 'FINANCIAL',
          summary: '模擬注文',
          details: JSON.stringify(details),
          status: 'PENDING',
          expires_at: new Date(clock + 120_000),
          created_at: new Date(clock),
        })
        .execute(),
    );
    return { taskId, approvalId };
  }
  const derive = (taskId: string, args: unknown) =>
    service.deriveApproval({
      tenantId,
      userId,
      taskId,
      stepIndex: 1,
      args,
      summary: '模擬注文',
      details: {},
    });
  async function nextArgs(
    original: Awaited<ReturnType<typeof fixture>>['submitArgs'],
    key = uuidv7(),
  ) {
    const args = structuredClone(original);
    args.intent.orderKey = key;
    args.quote.orderKey = key;
    args.quoteHash = await canonicalSha256(args.quote);
    return args;
  }

  it('atomically includes the initial pending approval, retries idempotently, and preserves exact proof binding', async () => {
    const f = await fixture(),
      first = await pending(f.submitArgs),
      requestId = uuidv7();
    const created = await service.create({
      tenantId,
      userId,
      requestId,
      spec: f.spec,
      approvalId: first.approvalId,
    });
    expect(created).toMatchObject({
      approvalId: first.approvalId,
      authorization: { usedOrders: 1, usedTotalMinor: 2350 },
    });
    expect(
      await service.create({
        tenantId,
        userId,
        requestId,
        spec: f.spec,
        approvalId: first.approvalId,
      }),
    ).toEqual(created);
    expect(await derive(first.taskId, f.submitArgs)).toMatchObject({
      approvalId: first.approvalId,
      authorizationId: created.authorization.id,
      inputsHash: await canonicalSha256(f.submitArgs),
    });
    expect(
      await withTenant(db, tenantId, (tx) =>
        isTransactionAuthorizationApprovalActive(tx, {
          approvalId: first.approvalId,
          now: new Date(clock),
          inputsHash: '0'.repeat(64),
        }),
      ),
    ).toBe(false);
    const inputHash = await canonicalSha256(f.submitArgs);
    expect(
      await withTenant(db, tenantId, (tx) =>
        isTransactionAuthorizationApprovalActive(tx, {
          approvalId: first.approvalId,
          now: new Date(clock),
          inputsHash: inputHash,
        }),
      ),
    ).toBe(true);
    await expect(
      service.create({
        tenantId,
        userId,
        requestId,
        spec: { ...f.spec, maxOrders: 2 },
        approvalId: first.approvalId,
      }),
    ).rejects.toThrow('authorization_request_changed');
  });

  it('rolls back the entire new grant when the first quote changes, exceeds scope, expires or belongs to someone else', async () => {
    for (const reason of ['scope', 'hash', 'expired', 'owner', 'nontransaction']) {
      const f = await fixture(),
        p = await pending(f.submitArgs);
      if (reason === 'hash')
        await withTenant(db, tenantId, (tx) =>
          tx
            .updateTable('approvals')
            .set({
              details: JSON.stringify({
                inputsHash: '0'.repeat(64),
                transactionSubmitArgs: f.submitArgs,
              }),
            })
            .where('id', '=', p.approvalId)
            .execute(),
        );
      if (reason === 'expired')
        await withTenant(db, tenantId, (tx) =>
          tx
            .updateTable('approvals')
            .set({ expires_at: new Date(clock - 1) })
            .where('id', '=', p.approvalId)
            .execute(),
        );
      if (reason === 'nontransaction')
        await withTenant(db, tenantId, (tx) =>
          tx
            .updateTable('approvals')
            .set({ risk: 'EXTERNAL_COMMIT' })
            .where('id', '=', p.approvalId)
            .execute(),
        );
      const spec =
        reason === 'scope'
          ? { ...f.spec, scope: { ...f.spec.scope, paymentMethodRef: 'other' } }
          : f.spec;
      const before = (await service.list(tenantId, userId)).length;
      await expect(
        service.create({
          tenantId,
          userId: reason === 'owner' ? otherUser : userId,
          requestId: uuidv7(),
          spec,
          approvalId: p.approvalId,
        }),
      ).rejects.toThrow();
      expect((await service.list(tenantId, userId)).length).toBe(before);
      expect(
        await withTenant(db, tenantId, (tx) =>
          tx
            .selectFrom('approvals')
            .select('status')
            .where('id', '=', p.approvalId)
            .executeTakeFirst(),
        ),
      ).toEqual({ status: 'PENDING' });
    }
  });

  it('returns the same creation receipt after task completion, quote expiry and revocation without another reservation', async () => {
    for (const status of ['COMPLETED', 'CANCELLED', 'FAILED']) {
      const f = await fixture(),
        p = await pending(f.submitArgs),
        requestId = uuidv7();
      const input = { tenantId, userId, requestId, spec: f.spec, approvalId: p.approvalId };
      const original = await service.create(input);
      await withTenant(db, tenantId, (tx) =>
        tx.updateTable('tasks').set({ status }).where('id', '=', p.taskId).execute(),
      );
      clock += 2 * 3600_000; // Both the original quote and the grant are expired.
      expect(await service.create(input)).toEqual(original);
      await service.revoke({ tenantId, userId, authorizationId: original.authorization.id });
      const recovered = await service.create(input);
      expect(recovered).toMatchObject({
        approvalId: p.approvalId,
        authorization: {
          id: original.authorization.id,
          status: 'REVOKED',
          usedOrders: 1,
          usedTotalMinor: 2350,
        },
      });
      expect(
        await withTenant(db, tenantId, (tx) =>
          isTransactionAuthorizationApprovalActive(tx, {
            approvalId: p.approvalId,
            now: new Date(clock),
          }),
        ),
      ).toBe(false);
    }
  });

  it('cannot move an order identity to another task or another grant, and never refunds failed or unknown attempts', async () => {
    const f = await fixture(),
      grant = (
        await service.create({
          tenantId,
          userId,
          requestId: uuidv7(),
          spec: { ...f.spec, maxOrders: 1 },
        })
      ).authorization;
    const first = await task();
    expect(await derive(first, f.submitArgs)).not.toBeNull();
    await withTenant(db, tenantId, (tx) =>
      tx.updateTable('tasks').set({ status: 'CANCELLED' }).where('id', '=', first).execute(),
    );
    expect((await service.list(tenantId, userId)).find((x) => x.id === grant.id)).toMatchObject({
      usedOrders: 1,
      usedTotalMinor: 2350,
    });
    expect(await derive(await task(), await nextArgs(f.submitArgs))).toBeNull();
    await service.create({ tenantId, userId, requestId: uuidv7(), spec: f.spec });
    await expect(derive(await task(), f.submitArgs)).rejects.toThrow('authorization_order_reused');
    await expect(
      withTenant(db, tenantId, (tx) =>
        tx
          .deleteFrom('transaction_authorization_uses')
          .where('authorization_id', '=', grant.id)
          .execute(),
      ),
    ).rejects.toThrow();
  });

  it('serializes quota in independent processes and reserves at most the total budget and count', async () => {
    const f = await fixture();
    const grant = (
      await service.create({
        tenantId,
        userId,
        requestId: uuidv7(),
        spec: { ...f.spec, maxOrders: 2, maxTotalMinor: 4700 },
      })
    ).authorization;
    const calls = await Promise.all(
      Array.from({ length: 4 }, async () => ({
        taskId: await task(),
        args: await nextArgs(f.submitArgs),
      })),
    );
    const serviceUrl = new URL('../dist/transaction-authorizations.js', import.meta.url).href;
    const dbUrl = new URL('../../../packages/db/dist/index.js', import.meta.url).href;
    const script = `import{createDb}from${JSON.stringify(dbUrl)};import{TransactionAuthorizationService}from${JSON.stringify(serviceUrl)};const db=createDb({url:process.env.TEST_DATABASE_URL,maxConnections:2,identityMaxConnections:1,idleTimeoutMillis:5000,connectionTimeoutMillis:5000,statementTimeoutMillis:20000,applicationName:'genie-bounded-child'});try{const input=JSON.parse(process.argv[1]);const service=new TransactionAuthorizationService({db,now:()=>new Date(${clock})});console.log(JSON.stringify(await service.deriveApproval(input)));}finally{await db.close();}`;
    const results = await Promise.all(
      calls.map((call) =>
        exec(
          process.execPath,
          [
            '--input-type=module',
            '-e',
            script,
            JSON.stringify({
              tenantId,
              userId,
              stepIndex: 1,
              ...call,
              summary: '模擬注文',
              details: {},
            }),
          ],
          { cwd: process.cwd(), env: process.env },
        ),
      ),
    );
    expect(results.filter((x) => JSON.parse(x.stdout) !== null)).toHaveLength(2);
    expect((await service.list(tenantId, userId)).find((x) => x.id === grant.id)).toMatchObject({
      usedOrders: 2,
      usedTotalMinor: 4700,
    });
  });

  it('revocation and expiry invalidate exact derived approvals and the claimed host authority', async () => {
    const f = await fixture(),
      grant = (await service.create({ tenantId, userId, requestId: uuidv7(), spec: f.spec }))
        .authorization;
    const taskId = await task(),
      approval = await derive(taskId, f.submitArgs);
    expect(approval).not.toBeNull();
    const hosts = new AgentHostService({ db, now: () => new Date(clock) }),
      bridge = new HostBridge({ db, now: () => new Date(clock) });
    const hostId = (
      await hosts.heartbeat({ tenantId, userId, deviceLabel: uuidv7(), models: ['fixture'] })
    ).id;
    const request = await bridge.request({
      tenantId,
      taskId,
      stepIndex: 1,
      toolId: 'transaction.submit',
      args: f.submitArgs,
      approval: {
        approvalId: approval!.approvalId,
        operationId: 'transaction.submit',
        decision: 'APPROVED',
        decidedBy: userId,
        decidedAt: new Date(clock).toISOString(),
        expiresAt: approval!.expiresAt,
        inputsHash: approval!.inputsHash,
      },
    });
    await bridge.claimNext({ tenantId, hostId });
    const auth = { tenantId, userId, hostId, requestId: request.id };
    expect(await bridge.executionAllowed(auth)).toBe(true);
    clock += 120_000;
    expect(await bridge.executionAllowed(auth)).toBe(false);
    clock = NOW.getTime();
    await service.revoke({ tenantId, userId, authorizationId: grant.id });
    expect(await bridge.executionAllowed(auth)).toBe(false);
    expect(await service.revoke({ tenantId, userId, authorizationId: grant.id })).toMatchObject({
      status: 'REVOKED',
      usedOrders: 1,
    });
    await expect(derive(taskId, f.submitArgs)).rejects.toThrow(
      'authorization_derived_approval_stale',
    );
    await expect(
      withTenant(db, tenantId, (tx) =>
        tx
          .updateTable('transaction_authorizations')
          .set({ status: 'ACTIVE', revoked_at: null })
          .where('id', '=', grant.id)
          .execute(),
      ),
    ).rejects.toThrow();
  });

  it('enforces tenant and user ownership and rejects mutation of fixed terms', async () => {
    const f = await fixture(),
      grant = (await service.create({ tenantId, userId, requestId: uuidv7(), spec: f.spec }))
        .authorization;
    expect(await service.list(otherTenant, otherUser)).toEqual([]);
    await expect(
      service.revoke({ tenantId: otherTenant, userId: otherUser, authorizationId: grant.id }),
    ).rejects.toMatchObject({ code: 'common.not_found' });
    await expect(
      service.revoke({ tenantId, userId: otherUser, authorizationId: grant.id }),
    ).rejects.toMatchObject({ code: 'common.not_found' });
    await expect(
      withTenant(db, tenantId, (tx) =>
        tx
          .updateTable('transaction_authorizations')
          .set({ spec: JSON.stringify({ ...f.spec, maxOrders: 1000 }) })
          .where('id', '=', grant.id)
          .execute(),
      ),
    ).rejects.toThrow();
    const wrongOwner = await task();
    await withTenant(db, tenantId, (tx) =>
      tx.updateTable('tasks').set({ created_by: otherUser }).where('id', '=', wrongOwner).execute(),
    );
    await expect(derive(wrongOwner, f.submitArgs)).rejects.toThrow('authorization_task_inactive');
  });

  it('carries a real derived worker proof through the host executor and denies the claimed request after revocation', async () => {
    const f = await fixture();
    // The production worker proof reads the wall clock. Use a fresh real quote,
    // without mocking its DB gate or synthesizing any ApprovalProof fields.
    clock = Date.now();
    f.quote.expiresAt = new Date(clock + 120_000).toISOString();
    f.submitArgs.quoteHash = await canonicalSha256(f.quote);
    f.spec.expiresAt = new Date(clock + 3600_000).toISOString();
    const grant = (await service.create({ tenantId, userId, requestId: uuidv7(), spec: f.spec }))
      .authorization;
    const taskId = await task();
    const derived = await derive(taskId, f.submitArgs);
    expect(derived).not.toBeNull();
    const where = {
      tenantId,
      taskId,
      stepIndex: 1,
      toolId: 'transaction.submit',
      args: f.submitArgs,
    };
    const proof = await approvalProof(db, where);
    expect(proof).toMatchObject({
      approvalId: derived!.approvalId,
      operationId: 'transaction.submit',
      decidedBy: userId,
      inputsHash: await canonicalSha256(f.submitArgs),
      expiresAt: derived!.expiresAt,
    });
    expect(await approvalProof(db, { ...where, args: await nextArgs(f.submitArgs) })).toBeNull();

    const hosts = new AgentHostService({ db, now: () => new Date(clock) });
    const bridge = new HostBridge({ db, now: () => new Date(clock) });
    const hostId = (
      await hosts.heartbeat({ tenantId, userId, deviceLabel: uuidv7(), models: ['fixture'] })
    ).id;
    let claimCount = 0;
    const executor = new HostStepExecutor({
      bridge,
      approvalFor: (input) => approvalProof(db, input),
      pollMs: 1,
      waitMs: 100,
      sleep: async () => {
        expect(++claimCount).toBe(1);
        const claimed = await bridge.claimNext({ tenantId, hostId });
        expect(claimed).toMatchObject({
          taskId,
          stepIndex: 1,
          toolId: 'transaction.submit',
          args: f.submitArgs,
          approval: proof,
        });
        const authority = { tenantId, userId, hostId, requestId: claimed!.id };
        expect(await bridge.executionAllowed(authority)).toBe(true);
        // This is the host hand-off boundary only: no provider or native input
        // is invoked. Revoke before dispatch and preserve that failure upstream.
        await service.revoke({ tenantId, userId, authorizationId: grant.id });
        expect(await approvalProof(db, where)).toBeNull();
        expect(await bridge.executionAllowed(authority)).toBe(false);
        await bridge.fail({
          tenantId,
          hostId,
          requestId: claimed!.id,
          error: { code: 'host.authority_revoked', message: 'Revoked before provider dispatch' },
        });
      },
    });
    await expect(
      executor.execute(
        { tenantId, userId, taskId },
        { index: 1, toolId: 'transaction.submit', args: f.submitArgs },
      ),
    ).rejects.toMatchObject({ name: 'HostStepFailed', code: 'host.authority_revoked' });
    expect(claimCount).toBe(1);
    expect(
      await withTenant(db, tenantId, (tx) =>
        tx
          .selectFrom('host_step_requests')
          .select(['status', 'approval'])
          .where('task_id', '=', taskId)
          .execute(),
      ),
    ).toEqual([{ status: 'FAILED', approval: proof }]);
    expect((await service.list(tenantId, userId)).find((row) => row.id === grant.id)).toMatchObject(
      {
        status: 'REVOKED',
        usedOrders: 1,
        usedTotalMinor: 2350,
      },
    );
  });
});
