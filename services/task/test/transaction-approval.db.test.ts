/** Real PostgreSQL/RLS approval binding; no provider or financial requests. */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { canonicalSha256, uuidv7 } from '@genie/contracts';
import { createDb, withIdentity, withTenant, type DbHandle } from '@genie/db';
import { FsObjectStore, LibraryService } from '@genie/service-library';
import { createTaskActivities } from '../src/activities.js';
import { TaskService } from '../src/service.js';
import { HostStepFailed } from '../../agent-host/src/step-executor.js';
import { NOW, transactionFixture } from './transaction-fixture.js';

const url = process.env['TEST_DATABASE_URL'];
describe.skipIf(!url)('transaction approvals with real PostgreSQL', () => {
  let db: DbHandle, service: TaskService, library: LibraryService, root: string;
  const tenantId = uuidv7(),
    userId = uuidv7();
  beforeAll(async () => {
    db = createDb({
      url: url!,
      identityUrl: process.env['TEST_IDENTITY_DATABASE_URL'],
      maxConnections: 5,
      identityMaxConnections: 2,
      idleTimeoutMillis: 5000,
      connectionTimeoutMillis: 5000,
      statementTimeoutMillis: 20000,
      applicationName: 'genie-transaction-approval-test',
    });
    await withIdentity(db, async (tx) => {
      await tx
        .insertInto('tenants')
        .values({ id: tenantId, name: 'Transaction approval test', kind: 'personal' })
        .execute();
      await tx
        .insertInto('users')
        .values({
          id: userId,
          email: `transaction-${userId}@example.invalid`,
          display_name: 'Transaction test',
        })
        .execute();
      await tx
        .insertInto('memberships')
        .values({ tenant_id: tenantId, user_id: userId, role: 'owner' })
        .execute();
    });
    root = await mkdtemp(path.join(tmpdir(), 'genie-transaction-approval-'));
    library = new LibraryService(db, new FsObjectStore(root));
    service = new TaskService(db, {
      async start(_input, workflowId) {
        return { workflowId, runId: uuidv7(), alreadyRunning: false };
      },
      async cancel() {},
      async approve() {},
      async instruct() {},
      async describe() {
        return null;
      },
      async close() {},
    });
  });
  afterAll(async () => {
    await db?.close();
    if (root) await rm(root, { recursive: true, force: true });
  });
  async function fixture(hostError?: (result: Record<string, unknown>) => Error) {
    const fixture = await transactionFixture();
    const { task } = await service.create({
      tenantId,
      userId,
      request: { kind: 'transaction.order', input: { intent: fixture.intent } },
      idempotencyKey: uuidv7(),
    });
    let calls = 0;
    const activities = createTaskActivities({
      db,
      library,
      publisher: { async publish() {} },
      now: () => NOW,
      hostExecutor: {
        async execute() {
          calls += 1;
          if (hostError) throw hostError(fixture.result);
          return { result: fixture.result };
        },
      },
    });
    const input = {
      taskId: task.id,
      tenantId,
      userId,
      kind: 'transaction.order',
      input: { intent: fixture.intent },
    };
    await activities.startTask(input, {
      kind: input.kind,
      title: '注文の確認',
      step_count: 2,
      run_id: uuidv7(),
    });
    return { ...fixture, activities, input, calls: () => calls };
  }
  async function approve(taskId: string) {
    await withTenant(db, tenantId, (tx) =>
      tx
        .updateTable('approvals')
        .set({ status: 'APPROVED', decided_by: userId, decided_at: NOW })
        .where('task_id', '=', taskId)
        .execute(),
    );
  }
  it('persists the exact displayed args hash and quote expiry, reuses unchanged approval, and dispatches only after approval', async () => {
    const f = await fixture();
    const approval = await f.activities.requestApprovalIfNeeded(f.input, f.step);
    expect(approval).toMatchObject({ timeoutMs: 120000 });
    const row = await withTenant(db, tenantId, (tx) =>
      tx
        .selectFrom('approvals')
        .selectAll()
        .where('id', '=', approval!.approvalId)
        .executeTakeFirstOrThrow(),
    );
    expect(row.details).toMatchObject({ inputsHash: await canonicalSha256(f.submitArgs) });
    expect(row.expires_at.toISOString()).toBe(f.quote.expiresAt);
    await expect(f.activities.executeStep(f.input, f.step)).rejects.toMatchObject({
      type: 'ApprovalStale',
    });
    expect(f.calls()).toBe(0);
    await approve(f.input.taskId);
    expect(await f.activities.requestApprovalIfNeeded(f.input, f.step)).toBeNull();
    expect(await f.activities.executeStep(f.input, f.step)).toEqual(f.result);
    expect(f.calls()).toBe(1);
    const artifactId = await f.activities.composeArtifact(f.input, f.plan.artifact, [
      f.prepared,
      f.result,
    ]);
    const { stream, artifact } = await library.readContent(tenantId, artifactId);
    let body = '';
    for await (const chunk of stream) body += chunk.toString();
    expect(artifact.mime_type).toBe('text/markdown');
    expect(body).toContain('注文番号: receipt-1');
    expect(body).toContain('注文合計（税・手数料・チップ込み）: JPY 2350');
    expect(body).toContain('支払方法（参照ID）: test-card');
    expect(body).not.toContain('submitArgs');
  });
  it('rejects a valid but changed quote both on approval reuse and before dispatch', async () => {
    const f = await fixture();
    await f.activities.requestApprovalIfNeeded(f.input, f.step);
    await approve(f.input.taskId);
    const quote = {
      ...f.quote,
      quoteId: 'quote-2',
      totals: { ...f.quote.totals, feeMinor: 101, totalMinor: 2351 },
    };
    const changed = {
      ...f.step,
      args: { ...f.submitArgs, quote, quoteHash: await canonicalSha256(quote) },
    };
    await expect(f.activities.requestApprovalIfNeeded(f.input, changed)).rejects.toMatchObject({
      type: 'ApprovalStale',
    });
    await expect(f.activities.executeStep(f.input, changed)).rejects.toMatchObject({
      type: 'ApprovalStale',
    });
    expect(f.calls()).toBe(0);
  });
  it('refuses legacy unbound approvals and expired or malformed quote contents', async () => {
    const f = await fixture();
    await f.activities.requestApprovalIfNeeded(f.input, f.step);
    await approve(f.input.taskId);
    await withTenant(db, tenantId, (tx) =>
      tx
        .updateTable('approvals')
        .set({ details: JSON.stringify({ items: [] }) })
        .where('task_id', '=', f.input.taskId)
        .execute(),
    );
    await expect(f.activities.requestApprovalIfNeeded(f.input, f.step)).rejects.toMatchObject({
      type: 'ApprovalStale',
    });
    await expect(f.activities.executeStep(f.input, f.step)).rejects.toMatchObject({
      type: 'ApprovalStale',
    });
    const expired = { ...f.quote, expiresAt: NOW.toISOString() };
    await expect(
      f.activities.requestApprovalIfNeeded(f.input, {
        ...f.step,
        args: { ...f.submitArgs, quote: expired, quoteHash: await canonicalSha256(expired) },
      }),
    ).rejects.toMatchObject({ type: 'ValidationError' });
    await expect(
      f.activities.requestApprovalIfNeeded(f.input, {
        ...f.step,
        args: { ...f.submitArgs, follow_up_instructions: ['extra'] },
      }),
    ).rejects.toMatchObject({ type: 'ValidationError' });
    expect(f.calls()).toBe(0);
  });
  it('refuses cancellation or newer instructions persisted before the workflow signal arrives', async () => {
    const f = await fixture();
    await f.activities.requestApprovalIfNeeded(f.input, f.step);
    await approve(f.input.taskId);
    await withTenant(db, tenantId, (tx) =>
      tx
        .updateTable('tasks')
        .set({ status: 'CANCELLING' })
        .where('id', '=', f.input.taskId)
        .execute(),
    );
    await expect(f.activities.executeStep(f.input, f.step)).rejects.toMatchObject({
      type: 'ApprovalStale',
    });
    const second = await fixture();
    await second.activities.requestApprovalIfNeeded(second.input, second.step);
    await approve(second.input.taskId);
    await withTenant(db, tenantId, (tx) =>
      tx
        .insertInto('task_instructions')
        .values({
          task_id: second.input.taskId,
          tenant_id: tenantId,
          request_id: uuidv7(),
          text: '数量を変えて',
          created_by: userId,
          status: 'RECEIVED',
        })
        .execute(),
    );
    await expect(second.activities.executeStep(second.input, second.step)).rejects.toMatchObject({
      type: 'ApprovalStale',
    });
    expect(f.calls() + second.calls()).toBe(0);
  });

  it.each([false, true])(
    'retains only quote-bound unknown identity through the activity failure (mismatched=%s)',
    async (mismatched) => {
      let expected: Record<string, unknown>;
      const f = await fixture(({ observation: _receipt, ...identity }) => {
        expected = {
          ...identity,
          status: 'unknown',
          ...(mismatched ? { orderKey: 'another-order' } : {}),
        };
        return new HostStepFailed('result_unknown', 'Order outcome unconfirmed', expected);
      });
      await f.activities.requestApprovalIfNeeded(f.input, f.step);
      await approve(f.input.taskId);
      const failure = await f.activities.executeStep(f.input, f.step).then(
        () => {
          throw new Error('Expected unknown transaction failure');
        },
        (error: unknown) => error as { type: string; nonRetryable: boolean; details: unknown[] },
      );
      expect(failure).toMatchObject({ type: 'ExternalActionFailed', nonRetryable: true });
      expect(failure.details.slice(1)).toEqual(
        mismatched ? [] : [{ transactionResult: expected! }],
      );
      expect(f.calls()).toBe(1);
    },
  );

  it.each([
    ['claimed', 'CLAIMED', null, true],
    ['lost unknown details', 'FAILED', 'transaction.result_unknown', true],
    ['host crash', 'FAILED', 'host.failed', true],
    ['before claim', 'PENDING', null, false],
    ['known not sent', 'FAILED', 'host.cancelled', false],
    ['changed args', 'CLAIMED', null, false],
    ['unapproved', 'CLAIMED', null, false],
    ['missing proof', 'CLAIMED', null, false],
  ] as const)(
    'recovers timeout identity only from an exact approved host claim: %s',
    async (scenario, status, code, expected) => {
      const f = await fixture();
      const requested = await f.activities.requestApprovalIfNeeded(f.input, f.step);
      if (scenario !== 'unapproved') await approve(f.input.taskId);
      const hostId = uuidv7();
      const hash = await canonicalSha256(f.submitArgs);
      await withTenant(db, tenantId, async (tx) => {
        await tx
          .insertInto('agent_hosts')
          .values({
            id: hostId,
            tenant_id: tenantId,
            user_id: userId,
            device_label: `Timeout fixture ${hostId}`,
          })
          .execute();
        await tx
          .insertInto('host_step_requests')
          .values({
            id: uuidv7(),
            tenant_id: tenantId,
            task_id: f.input.taskId,
            step_index: f.step.index,
            tool_id: 'transaction.submit',
            status,
            args: JSON.stringify(
              scenario === 'changed args'
                ? { ...f.submitArgs, quoteHash: 'b'.repeat(64) }
                : f.submitArgs,
            ),
            approval:
              scenario === 'missing proof'
                ? null
                : JSON.stringify({
                    approvalId: requested!.approvalId,
                    operationId: 'transaction.submit',
                    decision: 'APPROVED',
                    inputsHash: hash,
                    decidedBy: userId,
                    decidedAt: NOW.toISOString(),
                    expiresAt: f.quote.expiresAt,
                  }),
            host_id: status === 'PENDING' ? null : hostId,
            claimed_at: status === 'PENDING' ? null : NOW,
            completed_at: status === 'FAILED' ? NOW : null,
            error: code
              ? JSON.stringify({ code, message: 'Injected failure without result' })
              : null,
            expires_at: new Date(f.quote.expiresAt),
          })
          .execute();
      });
      await service.cancel(tenantId, f.input.taskId, 'stop during worker loss');
      expect(
        await f.activities.failTask(
          f.input,
          {
            code: 'task.step_failed',
            message: 'Activity timed out',
            step_index: f.step.index,
            retryable: false,
          },
          {
            preserveCancellation: true,
            transactionSubmission: { stepIndex: f.step.index, args: f.submitArgs },
          },
        ),
      ).toEqual({ status: 'CANCELLED', artifactId: null });
      const task = await service.get(tenantId, f.input.taskId);
      expect(task.error?.transaction_result).toEqual(
        expected
          ? {
              mode: f.quote.mode,
              provider: f.quote.provider,
              account: f.quote.account,
              orderKey: f.quote.orderKey,
              quoteHash: f.quoteHash,
              status: 'unknown',
            }
          : undefined,
      );
      expect(f.calls()).toBe(0); // Finalization is strictly read-only toward the provider.
    },
  );
});
