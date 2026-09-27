import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat, rm, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import {
  parseOptions,
  selectModel,
  systemEnvironment,
  loadConfig,
  validateConfig,
  composeConfig,
  serviceEnvironment,
  lockPort,
  availablePort,
} from '../local-preview/config.mjs';
import { OwnedProcesses, waitFor, jsonRequest } from '../local-preview/processes.mjs';
const exec = promisify(execFile);
const repo = fileURLToPath(new URL('../../', import.meta.url));

async function temporary(t) {
  const directory = await mkdtemp(join(tmpdir(), 'genie managed test '));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test('CLI rejects unsupported actions, external model URLs, ambiguous ports and unsafe names', () => {
  for (const args of [
    ['reset'],
    ['--port', '0'],
    ['--port', '3000x'],
    ['--port', '65536'],
    ['--unknown'],
    ['--model-url', 'https://external.test'],
    ['--model-url', 'http://user:secret@localhost'],
    ['--model', 'x;rm'],
    ['--model'],
  ])
    assert.throws(() => parseOptions(args));
  assert.equal(parseOptions(['stop']).command, 'stop');
  assert.equal(parseOptions(['--port', '43124', '--no-open']).port, 43124);
});

test('model choice persists explicit intent, supports Ollama latest aliases and never picks a paid fallback', () => {
  assert.equal(selectModel(['llama3.2:latest'], 'llama3.2'), 'llama3.2:latest');
  assert.equal(selectModel(['qwen3.5:9b']), 'qwen3.5:9b');
  assert.throws(() => selectModel(['qwen3.5:9b'], 'llama3.2'));
  assert.throws(() => selectModel(['qwen3.5:9b', 'llama3.2:latest']));
  assert.throws(() => selectModel([]));
});

test('service environment does not inherit paid credentials, remote infrastructure or shell hooks', async (t) => {
  const root = await temporary(t);
  const config = await loadConfig(root);
  config.model = 'llama3.2:latest';
  const source = {
    PATH: '/bin',
    HOME: '/example',
    ASTRA_OPENAI_API_KEY: 'secret',
    OPENAI_API_KEY: 'secret',
    GOOGLE_APPLICATION_CREDENTIALS: 'secret',
    DATABASE_URL: 'remote',
    REDIS_URL: 'remote',
    DOCKER_HOST: 'tcp://remote:2375',
    DOCKER_CONTEXT: 'remote',
    NODE_OPTIONS: '--require malicious',
    ASTRA_WORK_SYNC: 'on',
    HTTPS_PROXY: 'http://proxy',
  };
  const env = serviceEnvironment(config, root, repo, source);
  assert.equal(env.PATH, '/bin');
  for (const key of [
    'OPENAI_API_KEY',
    'GOOGLE_APPLICATION_CREDENTIALS',
    'ASTRA_OPENAI_API_KEY',
    'DOCKER_HOST',
    'DOCKER_CONTEXT',
    'NODE_OPTIONS',
    'HTTPS_PROXY',
  ])
    assert.equal(env[key], undefined);
  assert.equal(env.ASTRA_WORK_SYNC, 'off');
  assert.equal(env.ASTRA_LLM_CLI, 'local');
  assert.equal(env.ASTRA_API_HOST, '127.0.0.1');
  assert.equal(env.ASTRA_DATA_ROOT, join(root, 'app'));
  assert.ok(env.DATABASE_URL.includes('@127.0.0.1:'));
  assert.equal(systemEnvironment(source).DATABASE_URL, undefined);
});

test('first boot persists private keys, ports and identity; later starts keep them and reject silent port changes', async (t) => {
  const root = await temporary(t);
  const first = await loadConfig(root, { port: 43125 });
  assert.deepEqual(await loadConfig(root), first);
  assert.equal((await stat(join(root, 'runtime.json'))).mode & 0o777, 0o600);
  assert.equal((await stat(root)).mode & 0o777, 0o700);
  assert.equal(
    new Set([first.port, first.postgresPort, first.redisPort, first.temporalPort, lockPort(root)])
      .size,
    5,
  );
  await assert.rejects(loadConfig(root, { port: 43126 }));
  for (const invalid of ['{broken', 'null', 'false', '0', '[]']) {
    await writeFile(join(root, 'runtime.json'), invalid);
    await assert.rejects(loadConfig(root));
    assert.equal(await readFile(join(root, 'runtime.json'), 'utf8'), invalid);
  }
});

test('saved configuration is validated before forming compose operations', async (t) => {
  const config = await loadConfig(await temporary(t));
  for (const patch of [
    { project: '../../existing' },
    { identity: 'x@example.com' },
    { appPassword: "'; DROP DATABASE x;" },
    { modelURL: 'https://external.test' },
    { postgresPort: config.port },
  ])
    assert.throws(() => validateConfig({ ...config, ...patch }));
});

test('an unrelated nonempty state directory is never taken over', async (t) => {
  const root = await temporary(t);
  await writeFile(join(root, 'my-file.txt'), 'keep');
  await assert.rejects(loadConfig(root));
  assert.equal(await readFile(join(root, 'my-file.txt'), 'utf8'), 'keep');
  await assert.rejects(stat(join(root, 'runtime.json')));
});

test('managed service stops when its supervisor disappears', async (t) => {
  const root = await temporary(t);
  const marker = join(root, 'stopped');
  const entry = join(root, 'service.mjs');
  await writeFile(
    entry,
    `import {writeFileSync} from 'node:fs'; process.on('SIGTERM',()=>{writeFileSync(${JSON.stringify(marker)},'stopped');process.exit(0)});process.send('ready');setInterval(()=>{},1000);`,
  );
  const wrapper = resolve(repo, 'scripts/local-preview/child.mjs');
  const parent = spawn(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `import {fork} from 'node:child_process'; const child=fork(${JSON.stringify(wrapper)},[${JSON.stringify(entry)}],{execArgv:[]});child.on('message',()=>console.log('ready'));`,
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  t.after(() => parent.kill());
  await new Promise((yes, no) => {
    const timer = setTimeout(() => no(new Error('fixture never started')), 5000);
    parent.stdout.once('data', () => {
      clearTimeout(timer);
      yes();
    });
  });
  parent.kill('SIGKILL');
  await waitFor(async () => (await readFile(marker, 'utf8')) === 'stopped', {
    timeout: 5000,
    interval: 20,
  });
});

test('managed Compose isolates named volumes and all published ports; migration mounts are read-only', async (t) => {
  const config = await loadConfig(await temporary(t));
  const compose = composeConfig(config, repo);
  for (const service of Object.values(compose.services)) {
    assert.equal(service.container_name, undefined);
    for (const port of service.ports ?? []) assert.ok(port.startsWith('127.0.0.1:'));
  }
  assert.deepEqual(Object.keys(compose.volumes).sort(), ['postgres', 'redis']);
  assert.equal(compose.services.migrate.volumes[0].read_only, true);
  assert.ok(!JSON.stringify(compose).includes(config.adminPassword));
  assert.match(compose.services.migrate.image, /:2\.35\.1$/);
});

test('port conflicts fail without modifying the listener', async (t) => {
  const server = createServer();
  await new Promise((yes) => server.listen(0, '127.0.0.1', yes));
  t.after(() => server.close());
  await assert.rejects(availablePort(server.address().port));
  assert.ok(server.listening);
});

test('owned processes fail on exit and stop children; unrelated processes stay alive', async (t) => {
  const root = await temporary(t);
  const unrelated = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)']);
  t.after(() => unrelated.kill());
  const controller = new AbortController();
  const errors = [];
  const group = new OwnedProcesses({
    cwd: root,
    logs: root,
    signal: controller.signal,
    onFailure: (e) => errors.push(e),
  });
  const child = await group.spawn(
    'owned',
    process.execPath,
    ['-e', 'setInterval(()=>{},1000)'],
    systemEnvironment(),
    { service: true },
  );
  await group.stop();
  assert.notEqual(child.signalCode, null);
  assert.equal(errors.length, 0);
  assert.equal(unrelated.exitCode, null);
  assert.equal((await stat(join(root, 'owned.log'))).mode & 0o777, 0o600);
  const failedGroup = new OwnedProcesses({
    cwd: root,
    logs: root,
    onFailure: (e) => errors.push(e),
  });
  const failed = await failedGroup.spawn(
    'failed',
    process.execPath,
    ['-e', 'process.exit(9)'],
    systemEnvironment(),
    { service: true },
  );
  assert.equal(await failed.done, 9);
  assert.equal(errors.length, 1);
});

test('command timeout, startup abort and bounded readiness cannot report success', async (t) => {
  const root = await temporary(t);
  const controller = new AbortController();
  const group = new OwnedProcesses({ cwd: root, logs: root, signal: controller.signal });
  await assert.rejects(
    group.run(
      'timeout',
      process.execPath,
      ['-e', 'setInterval(()=>{},1000)'],
      systemEnvironment(),
      { timeout: 30 },
    ),
  );
  await assert.rejects(
    group.run('missing-command', join(root, 'does-not-exist'), [], systemEnvironment()),
  );
  controller.abort();
  await assert.rejects(
    group.run('aborted', process.execPath, ['-e', 'process.exit(0)'], systemEnvironment()),
  );
  await assert.rejects(waitFor(async () => false, { timeout: 30, interval: 5 }));
  await assert.rejects(waitFor(async () => true, { signal: controller.signal }));
});

test('entrypoint help works from a symlink with spaces and importing it starts nothing', async (t) => {
  const root = await temporary(t);
  const path = join(root, 'start genie.mjs');
  await symlink(resolve(repo, 'scripts/start-local-preview.mjs'), path);
  const help = await exec(process.execPath, [path, '--help']);
  assert.match(help.stdout, /Genie ローカル起動/);
  const imported = await exec(process.execPath, [
    '--input-type=module',
    '-e',
    `await import(${JSON.stringify(new URL('../start-local-preview.mjs', import.meta.url).href)});`,
  ]);
  assert.equal(imported.stdout, '');
});

test('network errors and redirects do not expose returned response bodies', async () => {
  const { createServer } = await import('node:http');
  const server = createServer((req, res) => {
    res.writeHead(500);
    res.end('secret token must not appear');
  });
  await new Promise((yes) => server.listen(0, '127.0.0.1', yes));
  try {
    await assert.rejects(
      jsonRequest(`http://127.0.0.1:${server.address().port}`),
      (e) => !e.message.includes('secret') && e.message.includes('500'),
    );
  } finally {
    server.closeAllConnections();
    await new Promise((yes) => server.close(yes));
  }
});
