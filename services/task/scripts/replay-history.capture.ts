/** Explicit fixture generator; not a release acceptance test.
 * ASTRA_CAPTURE_REPLAY=1 ASTRA_TEST_TEMPORAL_PATH=/cached/temporal pnpm --filter @genie/service-task exec vitest run --config scripts/replay-capture.config.ts
 * Never run this to make a failing replay pass. Existing histories are immutable regression inputs.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import type { WorkflowHandle } from '@temporalio/client';
import { Worker } from '@temporalio/worker';
import { it } from 'vitest';

const revision = '28f89f2636a3b780e813ea902e07d2e4900a6e3f';
const fixtureDir = fileURLToPath(new URL('../test/replay-fixtures/', import.meta.url));
const sha256 = (data: string) => createHash('sha256').update(data).digest('hex');

async function capture() {
  if (process.env['ASTRA_CAPTURE_REPLAY'] !== '1')
    throw new Error('Fixture generation requires explicit ASTRA_CAPTURE_REPLAY=1. Existing histories were not changed.');
  const executable = process.env['ASTRA_TEST_TEMPORAL_PATH'];
  if (!executable || !path.isAbsolute(executable))
    throw new Error(
      'An explicit cached Temporal executable is required; never download implicitly.',
    );
  await realpath(executable);
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), 'genie-replay-old-')));
  const sources: Record<string, string> = {};
  let env: TestWorkflowEnvironment | undefined;
  let worker: Worker | undefined;
  let running: Promise<void> | undefined;
  let release: (() => void) | undefined;
  try {
    for (const name of ['workflows.ts', 'plan.ts']) {
      const source = execFileSync('git', ['show', `${revision}:services/task/src/${name}`], {
        encoding: 'utf8',
      });
      sources[name] = sha256(source);
      await writeFile(path.join(dir, name), source);
    }
    await symlink(
      fileURLToPath(new URL('../node_modules', import.meta.url)),
      path.join(dir, 'node_modules'),
    );
    env = await TestWorkflowEnvironment.createLocal({
      client: { identity: 'genie-replay-fixture' },
      server: {
        executable: { type: 'existing-path', path: executable },
        ip: '127.0.0.1',
        ui: false,
      },
    });
    const queue = 'genie-previous-revision-replay';
    let entered: (() => void) | undefined;
    let barrier = Promise.resolve();
    worker = await Worker.create({
      connection: env.nativeConnection,
      identity: 'genie-replay-fixture',
      namespace: env.client.options.namespace,
      taskQueue: queue,
      workflowsPath: path.join(dir, 'workflows.ts'),
      activities: {
        async startTask() {},
        async requestApprovalIfNeeded() {
          return null;
        },
        async executeStep() {
          entered?.();
          await barrier;
          return { message: 'synthetic local checklist' };
        },
        async composeArtifact() {
          return 'fixture-artifact';
        },
        // Deliberately retain the old activity result contract: void, not TaskResult.
        async completeTask() {},
        async cancelTask() {},
      },
    });
    running = worker.run();
    const histories: Record<string, string> = {};
    for (const scenario of ['completed', 'cancelled']) {
      const reachedStep = new Promise<void>((resolve) => {
        entered = resolve;
      });
      barrier = new Promise<void>((resolve) => {
        release = resolve;
      });
      const handle: WorkflowHandle = await env.client.workflow.start('TaskWorkflow', {
        taskQueue: queue,
        workflowId: `historical-${scenario}`,
        args: [
          {
            taskId: `fixture-${scenario}`,
            tenantId: 'synthetic-tenant',
            userId: 'synthetic-user',
            kind: 'echo',
            input: { message: 'synthetic local checklist', steps: 1 },
          },
        ],
      });
      let stepTimeout: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          reachedStep,
          new Promise<never>((_, reject) => {
            stepTimeout = setTimeout(
              () => reject(new Error('Historical workflow did not enter fixture step')),
              10000,
            );
          }),
        ]);
      } finally {
        clearTimeout(stepTimeout);
      }
      if (scenario === 'cancelled')
        await handle.signal('cancel', { reason: 'fixture cancellation' });
      release?.();
      assert.deepEqual(await handle.result(), {
        status: scenario === 'completed' ? 'COMPLETED' : 'CANCELLED',
        artifactId: scenario === 'completed' ? 'fixture-artifact' : null,
      });
      const history = await handle.fetchHistory();
      const json = JSON.stringify(history, null, 2) + '\n';
      assert.ok(!json.includes('task-terminal-outcome-v1'));
      histories[scenario] = sha256(json);
      await writeFile(path.join(fixtureDir, `${scenario}.json`), json);
    }
    await writeFile(
      path.join(fixtureDir, 'provenance.json'),
      JSON.stringify(
        {
          revision,
          capturedAt: new Date().toISOString(),
          sourceSha256: sources,
          historySha256: histories,
          activities:
            'Local synthetic activities; completeTask and cancelTask returned undefined. No provider, database, production history, or external network.',
          platform: process.platform,
          architecture: process.arch,
          node: process.version,
        },
        null,
        2,
      ) + '\n',
    );
  } finally {
    release?.();
    try {
      worker?.shutdown();
      await running;
    } finally {
      try {
        await env?.teardown();
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    }
  }
}

// Preserve the original generator's bounded test-runner lifetime. The .capture
// suffix keeps this mutating tool out of normal *.test.ts acceptance discovery.
it('capture previous-revision histories on an isolated real Temporal server', capture, 60000);
