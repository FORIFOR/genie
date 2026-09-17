/** Real processes + fresh Docker volumes + deterministic local model HTTP fixture.
 * Checks setup/restart/artifacts/cost boundaries, not model quality or native UI.
 * This harness owns and removes only the disposable project it creates below.
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn, execFile } from 'node:child_process';
import { access, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { availablePort, systemEnvironment, validateConfig } from '../local-preview/config.mjs';
import { jsonRequest, waitFor } from '../local-preview/processes.mjs';
import { desktopEmail } from '../start-local-host.mjs';
const exec = promisify(execFile);
const repo = fileURLToPath(new URL('../../', import.meta.url));
const stateDir = await mkdtemp(join(tmpdir(), 'genie-managed-smoke-'));
const model = 'genie-preview-fixture';
const marker = 'GENIE-MANAGED-FIRST-TASK';
const text = `# 初回のチェックリスト\n\n- [ ] アプリを試す — 担当者: 未定\n- [ ] デモを撮る — 担当者: 未定\n- [ ] 公開文を書く — 担当者: 未定\n\n${marker}`;
let calls = 0,
  running,
  config;
const env = systemEnvironment();
const fixture = createServer(async (req, res) => {
  res.setHeader('content-type', 'application/json');
  if (req.method === 'GET' && req.url === '/v1/models')
    res.end(JSON.stringify({ data: [{ id: model }] }));
  else if (req.method === 'POST' && req.url === '/v1/chat/completions') {
    calls++;
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks));
    if (body.model !== model) {
      res.writeHead(400);
      res.end('{}');
      return;
    }
    res.end(
      JSON.stringify({
        choices: [{ message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 30, completion_tokens: 30, total_tokens: 60 },
      }),
    );
  } else {
    res.writeHead(404);
    res.end('{}');
  }
});
await new Promise((yes) => fixture.listen(0, '127.0.0.1', yes));
const port = await availablePort();
const modelURL = `http://127.0.0.1:${fixture.address().port}/v1`;
const base = `http://127.0.0.1:${port}`;
const cli = resolve(repo, 'scripts/start-local-preview.mjs');
const startArgs = [
  cli,
  '--no-open',
  '--state-dir',
  stateDir,
  '--port',
  String(port),
  '--model-url',
  modelURL,
  '--model',
  model,
];
let output = '';

async function start() {
  output = '';
  running = spawn(process.execPath, startArgs, {
    cwd: repo,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  running.stdout.on('data', (data) => {
    output = (output + data).slice(-10000);
  });
  running.stderr.on('data', (data) => {
    output = (output + data).slice(-10000);
  });
  running.done = new Promise((yes) => {
    running.once('error', () => yes(1));
    running.once('exit', (code) => yes(code ?? 1));
  });
  await waitFor(
    async () => {
      if (running.exitCode !== null) return true;
      return output.includes('GENIE_PREVIEW_READY ');
    },
    { timeout: 600_000, message: 'The managed preview never became ready.' },
  );
  assert.equal(running.exitCode, null, output);
  assert.ok(output.includes('GENIE_PREVIEW_READY '), output);
  config = JSON.parse(await readFile(join(stateDir, 'runtime.json'), 'utf8'));
  validateConfig(config);
}

async function stop() {
  if (!running) return;
  if (running.exitCode === null) {
    await exec(process.execPath, [cli, 'stop', '--state-dir', stateDir], {
      cwd: repo,
      env,
      timeout: 15_000,
    });
    const code = await Promise.race([
      running.done,
      new Promise((_, no) => {
        const timer = setTimeout(() => no(new Error('Supervisor did not stop.')), 45_000);
        timer.unref();
      }),
    ]);
    assert.equal(code, 0, output);
  }
  running = null;
}

async function headers() {
  const credentials = await jsonRequest(base + '/v1/auth/dev/token', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      email: desktopEmail(config.identity),
      display_name: 'Disposable startup test',
    }),
  });
  return {
    authorization: `Bearer ${credentials.access_token}`,
    'content-type': 'application/json',
  };
}

try {
  const started = Date.now();
  await start();
  assert.equal(calls, 0, 'Startup must not generate text.');
  const firstConfig = JSON.stringify(config);
  await assert.rejects(
    exec(process.execPath, startArgs, { cwd: repo, env, timeout: 15_000 }),
    (error) => error.code === 1 && error.stderr.includes('二重起動'),
  );
  assert.equal(
    JSON.stringify(JSON.parse(await readFile(join(stateDir, 'runtime.json'), 'utf8'))),
    firstConfig,
  );
  const auth = await headers();
  const conversation = await jsonRequest(base + '/v1/conversations', {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ title: 'Disposable first-start check' }),
  });
  const response = await jsonRequest(`${base}/v1/conversations/${conversation.id}/turns`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({
      text: `Markdownのチェックリストを作ってください。項目はアプリを試す、デモを撮る、公開文を書く。担当者はすべて未定。識別番号 ${marker} を含めてください。文章だけを作成してください。`,
    }),
  });
  assert.ok(response.task_id, 'First request must create a task.');
  let task;
  await waitFor(
    async () => {
      task = await jsonRequest(`${base}/v1/tasks/${response.task_id}`, { headers: auth });
      return ['COMPLETED', 'FAILED', 'CANCELLED'].includes(task.status);
    },
    { timeout: 120_000 },
  );
  assert.equal(task.status, 'COMPLETED');
  assert.equal(calls, 1, 'One compose request must cause one model generation.');
  const artifactURL = `${base}/v1/artifacts/${task.result_artifact_id}/content`;
  const artifact = await fetch(artifactURL, { headers: auth, redirect: 'error' });
  assert.equal(artifact.status, 200);
  const saved = await artifact.text();
  assert.ok(saved.includes(marker));
  await writeFile(join(stateDir, 'result.md'), saved);
  await stop();
  await assert.rejects(fetch(base + '/readyz', { signal: AbortSignal.timeout(1000) }));
  await start();
  assert.equal(
    JSON.stringify(config),
    firstConfig,
    'Restart must keep identity, signing keys, ports and model.',
  );
  // The desktop's existing access token also survives restart because signing keys persist.
  const reopened = await fetch(artifactURL, { headers: auth, redirect: 'error' });
  assert.equal(reopened.status, 200);
  assert.equal(await reopened.text(), saved);
  assert.equal(calls, 1, 'Restart and reopening must not generate again.');
  await stop();
  console.log(
    JSON.stringify({
      result: 'PASS',
      setup: 'fresh Docker database and actual gateway/worker/host',
      restartRetainedArtifact: true,
      duplicateStartRejected: true,
      existingAccessTokenRetained: true,
      modelGenerations: calls,
      elapsedMs: Date.now() - started,
      model: 'deterministic HTTP fixture, not a quality evaluation',
      nativeUI: 'not tested by this harness',
    }),
  );
} finally {
  try {
    await stop();
  } catch {
    if (running?.exitCode === null) running.kill('SIGTERM');
  }
  // Only this newly-created disposable test project can be removed here.
  if (!config)
    config = JSON.parse(await readFile(join(stateDir, 'runtime.json'), 'utf8').catch(() => 'null'));
  if (config) {
    validateConfig(config);
    const composePath = join(stateDir, 'compose.json');
    // A clean `start-local-preview ... stop` may already remove its generated
    // compose file after bringing the disposable project down. Do not turn that
    // successful cleanup into a CI failure by invoking Docker with a vanished -f.
    const composeStillExists = await access(composePath).then(
      () => true,
      () => false,
    );
    if (composeStillExists) {
      const contextName = (await exec('docker', ['context', 'show'], { env })).stdout.trim();
      const host = (
        await exec(
          'docker',
          ['context', 'inspect', contextName, '--format', '{{.Endpoints.docker.Host}}'],
          { env },
        )
      ).stdout.trim();
      assert.ok(host.startsWith('unix://'));
      await exec(
        'docker',
        [
          '--context',
          contextName,
          'compose',
          '--env-file',
          '/dev/null',
          '-p',
          config.project,
          '-f',
          composePath,
          'down',
          '--volumes',
        ],
        { env: { ...env, GENIE_PREVIEW_DB_PASSWORD: config.adminPassword }, timeout: 60_000 },
      );
    }
  }
  fixture.closeAllConnections();
  await new Promise((yes) => fixture.close(yes));
}
