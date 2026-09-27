/** Real PostgreSQL/RLS terminal transition tests. No Temporal server or model calls. */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { uuidv7 } from '@genie/contracts';
import { createDb, withIdentity, withTenant, type DbHandle } from '@genie/db';
import { FsObjectStore, LibraryService } from '@genie/service-library';
import { createTaskActivities } from '../src/activities.js';
import type { TaskActivities } from '../src/activity-types.js';
import { TaskService } from '../src/service.js';
import type { TaskWorkflowInput } from '../src/workflows.js';

const url = process.env['TEST_DATABASE_URL'];
describe.skipIf(!url)('terminal transitions with real PostgreSQL', () => {
  let db: DbHandle;
  let service: TaskService;
  let library: LibraryService;
  let activities: TaskActivities;
  let root: string;
  const tenantId = uuidv7();
  const userId = uuidv7();
  const error = {
    code: 'task.step_failed',
    message: 'injected failure',
    step_index: null,
    retryable: false,
  };

  beforeAll(async () => {
    db = createDb({
      url: url!,
      identityUrl: process.env['TEST_IDENTITY_DATABASE_URL'],
      maxConnections: 10,
      identityMaxConnections: 2,
      idleTimeoutMillis: 5000,
      connectionTimeoutMillis: 5000,
      statementTimeoutMillis: 20000,
      applicationName: 'genie-terminal-test',
    });
    await withIdentity(db, async (tx) => {
      await tx
        .insertInto('tenants')
        .values({ id: tenantId, name: 'Terminal test', kind: 'personal' })
        .execute();
      await tx
        .insertInto('users')
        .values({
          id: userId,
          email: `terminal-${userId}@example.invalid`,
          display_name: 'Terminal test',
        })
        .execute();
      await tx
        .insertInto('memberships')
        .values({ tenant_id: tenantId, user_id: userId, role: 'owner' })
        .execute();
    });
    root = await mkdtemp(path.join(tmpdir(), 'genie-terminal-'));
    library = new LibraryService(db, new FsObjectStore(root));
    activities = createTaskActivities({ db, library, publisher: { async publish() {} } });
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

  async function fixture() {
    const { task } = await service.create({
      tenantId,
      userId,
      request: { kind: 'echo', input: { message: 'terminal fixture' } },
      idempotencyKey: uuidv7(),
    });
    const input: TaskWorkflowInput = { taskId: task.id, tenantId, userId, kind: 'echo', input: {} };
    const artifact = await library.create({
      tenantId,
      ownerId: userId,
      type: 'DOCUMENT',
      title: 'Terminal fixture',
      mimeType: 'text/markdown',
      body: Buffer.from('fixture'),
      sourceTaskId: task.id,
    });
    return { input, artifact };
  }
  async function terminalEvents(taskId: string) {
    return (await service.eventsAfter(tenantId, taskId, 0)).filter((e) =>
      ['task.completed', 'task.cancelled', 'task.failed'].includes(e.type),
    );
  }

  it('completion after accepted cancellation emits no false completion', async () => {
    const { input, artifact } = await fixture();
    await service.cancel(tenantId, input.taskId, 'cancel first');
    expect(await activities.completeTask(input, artifact.id)).toEqual({
      status: 'CANCELLING',
      artifactId: null,
    });
    expect(await terminalEvents(input.taskId)).toEqual([]);
    expect(await activities.cancelTask(input, 'cancel first')).toEqual({
      status: 'CANCELLED',
      artifactId: null,
    });
    expect((await service.get(tenantId, input.taskId)).status).toBe('CANCELLED');
    expect((await terminalEvents(input.taskId)).map((e) => e.type)).toEqual(['task.cancelled']);
  });

  it('late cancellation and failure preserve completed artifact and only one terminal event', async () => {
    const { input, artifact } = await fixture();
    const expected = { status: 'COMPLETED', artifactId: artifact.id };
    expect(await activities.completeTask(input, artifact.id)).toEqual(expected);
    const completed = await service.get(tenantId, input.taskId);
    expect(await activities.completeTask(input, artifact.id)).toEqual(expected);
    expect(await activities.cancelTask(input, 'too late')).toEqual(expected);
    await activities.failTask(input, error);
    await expect(service.cancel(tenantId, input.taskId, 'too late')).rejects.toMatchObject({
      code: 'task.invalid_state',
    });
    expect(await service.get(tenantId, input.taskId)).toEqual(completed);
    expect((await terminalEvents(input.taskId)).map((e) => e.type)).toEqual(['task.completed']);
  });

  it('duplicate cancellation does not mutate timestamps or duplicate audit entries', async () => {
    const { input, artifact } = await fixture();
    await activities.cancelTask(input, 'first');
    const cancelled = await service.get(tenantId, input.taskId);
    await activities.cancelTask(input, 'duplicate');
    await activities.failTask(input, error);
    expect(await activities.completeTask(input, artifact.id)).toEqual({
      status: 'CANCELLED',
      artifactId: null,
    });
    expect(await service.get(tenantId, input.taskId)).toEqual(cancelled);
    expect((await terminalEvents(input.taskId)).map((e) => e.type)).toEqual(['task.cancelled']);
    const audits = await withTenant(db, tenantId, (tx) =>
      tx
        .selectFrom('audit_events')
        .select('id')
        .where('task_id', '=', input.taskId)
        .where('action', '=', 'task.cancelled')
        .execute(),
    );
    expect(audits).toHaveLength(1);
  });

  it('failure remains immutable when terminal activities are redelivered', async () => {
    const { input, artifact } = await fixture();
    await activities.failTask(input, error);
    const failed = await service.get(tenantId, input.taskId);
    await activities.failTask(input, { ...error, message: 'later failure', step_index: 3 });
    expect(await activities.completeTask(input, artifact.id)).toEqual({
      status: 'FAILED',
      artifactId: null,
    });
    expect(await activities.cancelTask(input, 'late')).toEqual({
      status: 'FAILED',
      artifactId: null,
    });
    expect(await service.get(tenantId, input.taskId)).toEqual(failed);
    expect((await terminalEvents(input.taskId)).map((e) => e.type)).toEqual(['task.failed']);
  });

  it('a different tenant cannot cancel or finalize this task', async () => {
    const { input, artifact } = await fixture();
    const stranger = uuidv7();
    await expect(service.cancel(stranger, input.taskId, 'unauthorized')).rejects.toMatchObject({
      code: 'task.not_found',
    });
    await expect(
      activities.completeTask({ ...input, tenantId: stranger }, artifact.id),
    ).rejects.toMatchObject({ type: 'TaskGone' });
    await expect(
      activities.cancelTask({ ...input, tenantId: stranger }, 'unauthorized'),
    ).rejects.toMatchObject({ type: 'TaskGone' });
    expect((await service.get(tenantId, input.taskId)).status).toBe('PENDING');
    expect(await terminalEvents(input.taskId)).toEqual([]);
  });

  it('cancel rechecks a completion committed while waiting for the row lock', async () => {
    const { input, artifact } = await fixture();
    let release!: () => void;
    let locked!: () => void;
    const releaseBarrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const lockedBarrier = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const committingCompletion = withTenant(db, tenantId, async (tx) => {
      await tx
        .updateTable('tasks')
        .set({ status: 'COMPLETED', result_artifact_id: artifact.id })
        .where('id', '=', input.taskId)
        .execute();
      locked();
      await releaseBarrier;
    });
    await lockedBarrier;
    // Attach rejection handling before the barrier releases.
    const cancelling = service.cancel(tenantId, input.taskId, 'concurrent').then(
      () => ({ rejected: false, code: null }),
      (error: unknown) => ({ rejected: true, code: (error as { code?: string }).code }),
    );
    let observedBlockedStatement = false;
    try {
      for (let attempt = 0; attempt < 100; attempt++) {
        const blocked = await withTenant(db, tenantId, (tx) =>
          sql<{ count: number }>`
          select count(*)::integer as count from pg_stat_activity
          where application_name like 'genie-terminal-test:%' and wait_event_type = 'Lock'
        `.execute(tx),
        );
        if (blocked.rows[0]?.count) {
          observedBlockedStatement = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    } finally {
      release();
      await committingCompletion;
    }
    expect(observedBlockedStatement).toBe(true);
    expect(await cancelling).toEqual({ rejected: true, code: 'task.invalid_state' });
    expect((await service.get(tenantId, input.taskId)).status).toBe('COMPLETED');
  });

  it('late start/pause/resume activities cannot erase cancellation or invent progress', async () => {
    const { input } = await fixture();
    await service.cancel(tenantId, input.taskId, 'cancel before delayed activity');
    for (const terminal of [false, true]) {
      if (terminal) await activities.cancelTask(input, 'cancel before delayed activity');
      const before = await service.get(tenantId, input.taskId);
      const eventsBefore = await service.eventsAfter(tenantId, input.taskId, 0);
      await activities.startTask(input, {
        kind: 'echo',
        title: 'late start',
        step_count: 1,
        run_id: uuidv7(),
      });
      await activities.pauseForHost(input, 0);
      await activities.resumeFromHost(input, 0);
      expect(await service.get(tenantId, input.taskId)).toEqual(before);
      expect(await service.eventsAfter(tenantId, input.taskId, 0)).toEqual(eventsBefore);
    }
  });

  it('concurrent cancellation and completion converge without opposite terminal events', async () => {
    for (let i = 0; i < 12; i++) {
      const { input, artifact } = await fixture();
      const [cancel, complete] = await Promise.allSettled([
        service.cancel(tenantId, input.taskId, 'race'),
        activities.completeTask(input, artifact.id),
      ]);
      expect(complete.status).toBe('fulfilled');
      let stored = await service.get(tenantId, input.taskId);
      if (stored.status === 'CANCELLING') {
        expect(cancel.status).toBe('fulfilled');
        await activities.cancelTask(input, 'race');
        stored = await service.get(tenantId, input.taskId);
      }
      expect(['COMPLETED', 'CANCELLED']).toContain(stored.status);
      expect((await terminalEvents(input.taskId)).map((e) => e.type)).toEqual([
        stored.status === 'COMPLETED' ? 'task.completed' : 'task.cancelled',
      ]);
      expect(stored.result_artifact_id).toBe(stored.status === 'COMPLETED' ? artifact.id : null);
    }
  });
  it.skipIf(!process.env['ASTRA_TEST_TEMPORAL_PATH'])(
    'real Temporal preserves cancellation during composition, including a lost signal',
    async () => {
      const { TestWorkflowEnvironment } = await import('@temporalio/testing');
      const { Worker } = await import('@temporalio/worker');
      const { TemporalTaskRuntime } = await import('../src/runtime/temporal.js');
      const { workflowIdFor } = await import('../src/runtime/types.js');
      const env = await TestWorkflowEnvironment.createLocal({
        server: {
          executable: { type: 'existing-path', path: process.env['ASTRA_TEST_TEMPORAL_PATH']! },
          ip: '127.0.0.1',
          ui: false,
        },
      });
      const queue = `terminal-${uuidv7()}`;
      let release: (() => void) | undefined;
      let composing: (() => void) | undefined;
      let releaseBarrier: Promise<void> = Promise.resolve();
      const worker = await Worker.create({
        connection: env.nativeConnection,
        namespace: env.client.options.namespace,
        taskQueue: queue,
        workflowsPath: fileURLToPath(new URL('../src/workflows.ts', import.meta.url)),
        activities: {
          ...activities,
          async composeArtifact(...args: Parameters<TaskActivities['composeArtifact']>) {
            const id = await activities.composeArtifact(...args);
            composing?.();
            await releaseBarrier;
            return id;
          },
        },
      });
      const running = worker.run();
      const runtime = new TemporalTaskRuntime(env.client, queue);
      try {
        for (const loseSignal of [false, true]) {
          let signalAttempted = false;
          releaseBarrier = new Promise<void>((resolve) => {
            release = resolve;
          });
          const enteredCompose = new Promise<void>((resolve) => {
            composing = resolve;
          });
          const realService = new TaskService(db, {
            start: runtime.start.bind(runtime),
            approve: runtime.approve.bind(runtime),
            instruct: runtime.instruct.bind(runtime),
            describe: runtime.describe.bind(runtime),
            async close() {},
            async cancel(id, reason) {
              signalAttempted = true;
              if (!loseSignal) await runtime.cancel(id, reason);
            },
          });
          const { task } = await realService.create({
            tenantId,
            userId,
            request: { kind: 'echo', input: { message: 'real engine cancellation', steps: 1 } },
            idempotencyKey: uuidv7(),
          });
          await enteredCompose;
          const accepted = await realService.cancel(tenantId, task.id, 'during composition');
          expect(accepted.status).toBe('CANCELLING');
          expect(signalAttempted).toBe(true);
          release?.();
          const result = await env.client.workflow
            .getHandle(workflowIdFor(tenantId, task.id))
            .result();
          const stored = await realService.get(tenantId, task.id);
          expect(result).toEqual({ status: 'CANCELLED', artifactId: null });
          expect(stored.status).toBe('CANCELLED');
          expect(stored.result_artifact_id).toBeNull();
          expect((await terminalEvents(task.id)).map((event) => event.type)).toEqual([
            'task.cancelled',
          ]);
          // Composition really persisted its artifact; cancellation does not erase an output.
          expect(await library.findBySourceTask(tenantId, task.id)).not.toBeNull();
        }
      } finally {
        release?.();
        worker.shutdown();
        await running;
        await env.teardown();
      }
    },
    60000,
  );
});
