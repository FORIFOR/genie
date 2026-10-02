import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtemp,
  readFile,
  stat,
  rm,
  writeFile,
  symlink,
  mkdir,
  chmod,
  realpath,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import {
  parseOptions,
  selectModel,
  modelConfiguration,
  modelEnvironment,
  modelAppEnvironment,
  desktopConnectionDescriptor,
  saveDesktopConnection,
  invalidateDesktopConnection,
  externalScreenAllowed,
  assertLocalModel,
  systemEnvironment,
  dockerEnvironment,
  loadConfig,
  validateConfig,
  composeConfig,
  serviceEnvironment,
  lockPort,
  availablePort,
} from '../local-preview/config.mjs';
import { OwnedProcesses, waitFor, jsonRequest } from '../local-preview/processes.mjs';
import {
  macAppLaunchArgs,
  nativeAppIdentity,
  readNativeProcessIdentity,
  stopOwnedNativeApp,
  monitorNativeAppExit,
  transactionSimulationEnvironment,
  verifyCodexConnection,
  resolveCodexExecutable,
  verifyClaudeConnection,
  resolveClaudeExecutable,
  verifyGeminiKey,
  verifyLocalOllamaModel,
  readyMessage,
  readComputerHelperStatus,
  computerStatusResponse,
} from '../start-local-preview.mjs';
const exec = promisify(execFile);
const repo = fileURLToPath(new URL('../../', import.meta.url));
const descriptorIdentity = '11111111-2222-4333-8444-555555555555';

test('desktop descriptor contains only the selected non-secret exact model scope', () => {
  const value = desktopConnectionDescriptor(
    {
      port: 43123,
      modelProvider: 'codex',
      model: 'gpt-6-sol',
      allowCloud: true,
      privateKey: 'never copy',
      identity: descriptorIdentity,
      token: 'never copy',
    },
    '/synthetic/state',
  );
  assert.deepEqual(value, {
    version: 1,
    gatewayURL: 'http://127.0.0.1:43123',
    workspace: '/synthetic/state/app',
    desktopIdentity: descriptorIdentity,
    model: { provider: 'codex', name: 'gpt-6-sol' },
    externalAuthorization: { provider: 'codex', model: 'gpt-6-sol' },
  });
  assert.throws(
    () =>
      desktopConnectionDescriptor(
        { port: 43123, identity: descriptorIdentity, modelProvider: 'codex', model: 'gpt-6-sol' },
        '/synthetic/state',
      ),
    /送信許可/,
  );
  const local = desktopConnectionDescriptor(
    {
      port: 43123,
      identity: descriptorIdentity,
      modelProvider: 'local',
      model: 'qwen3.5:9b',
      modelURL: 'http://127.0.0.1:11434/v1',
    },
    '/synthetic/state',
  );
  assert.equal(local.model.provider, 'local');
  assert.equal(local.externalAuthorization, null);
  assert.equal(local.model.url, 'http://127.0.0.1:11434/v1');
  assert.throws(() =>
    desktopConnectionDescriptor(
      {
        port: 43123,
        identity: descriptorIdentity,
        modelProvider: 'local',
        model: 'remote:cloud',
        modelURL: 'http://127.0.0.1:11434/v1',
      },
      '/synthetic/state',
    ),
  );
});

test('only ready standard workspace saves the direct-launch choice privately', async (t) => {
  const state = await realpath(await temporary(t)),
    other = await realpath(await temporary(t));
  await chmod(state, 0o700);
  const config = {
    port: 43123,
    identity: descriptorIdentity,
    modelProvider: 'codex',
    allowCloud: true,
    model: 'gpt-6-sol',
  };
  assert.equal(await saveDesktopConnection(config, state, { standardState: state }), false);
  assert.equal(
    await saveDesktopConnection(config, other, { standardState: state, ready: true }),
    false,
  );
  await assert.rejects(readFile(join(state, 'desktop-connection.json')), { code: 'ENOENT' });
  assert.equal(
    await saveDesktopConnection(config, state, { standardState: state, ready: true }),
    true,
  );
  const file = join(state, 'desktop-connection.json');
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  const saved = JSON.parse(await readFile(file, 'utf8'));
  assert.deepEqual(saved, desktopConnectionDescriptor(config, state));
  assert.equal('ready' in saved, false);
  assert.equal('externalScreenAuthorization' in saved, false);
  const local = {
    port: 43123,
    identity: descriptorIdentity,
    modelProvider: 'local',
    model: 'qwen3.5:9b',
    modelURL: 'http://localhost:11434/v1',
  };
  await saveDesktopConnection(local, state, { standardState: state, ready: true });
  assert.equal(JSON.parse(await readFile(file, 'utf8')).externalAuthorization, null);
});

test('changed saved selection invalidates stale cloud choice until readiness without local fallback', async (t) => {
  const state = await realpath(await temporary(t));
  await chmod(state, 0o700);
  const external = {
    port: 43123,
    identity: descriptorIdentity,
    modelProvider: 'codex',
    allowCloud: true,
    model: 'gpt-6-sol',
  };
  const options = { standardState: state },
    file = join(state, 'desktop-connection.json');
  assert.equal(await invalidateDesktopConnection(external, state, options), true);
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), {
    version: 1,
    selectionPending: true,
  });
  await saveDesktopConnection(external, state, { ...options, ready: true });
  const before = await readFile(file, 'utf8');
  assert.equal(await invalidateDesktopConnection(external, state, options), false);
  assert.equal(await readFile(file, 'utf8'), before);
  const changed = { ...external, model: 'gpt-6-astra' };
  assert.equal(await invalidateDesktopConnection(changed, state, options), true);
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), {
    version: 1,
    selectionPending: true,
  });
  await saveDesktopConnection(changed, state, { ...options, ready: true });
  assert.equal(JSON.parse(await readFile(file, 'utf8')).model.name, 'gpt-6-astra');
  assert.equal(
    await invalidateDesktopConnection(
      {
        ...external,
        modelProvider: 'local',
        model: 'qwen3.5:9b',
        modelURL: 'http://localhost:11434/v1',
      },
      state,
      options,
    ),
    true,
  );
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), {
    version: 1,
    selectionPending: true,
  });
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  const isolated = await realpath(await temporary(t));
  assert.equal(await invalidateDesktopConnection(external, isolated, options), false);
  await assert.rejects(readFile(join(isolated, 'desktop-connection.json')), { code: 'ENOENT' });
});

test('desktop descriptor rejects unsafe or symlinked standard directories without altering the old choice', async (t) => {
  const state = await realpath(await temporary(t)),
    parent = await realpath(await temporary(t));
  const config = {
    port: 43123,
    identity: descriptorIdentity,
    modelProvider: 'codex',
    allowCloud: true,
    model: 'gpt-6-sol',
  };
  await chmod(state, 0o700);
  await saveDesktopConnection(config, state, { standardState: state, ready: true });
  const file = join(state, 'desktop-connection.json'),
    before = await readFile(file, 'utf8');
  await chmod(state, 0o755);
  await assert.rejects(
    saveDesktopConnection(config, state, { standardState: state, ready: true }),
    /所有者/,
  );
  assert.equal(await readFile(file, 'utf8'), before);
  const alias = join(parent, 'alias');
  await symlink(state, alias);
  await assert.rejects(
    saveDesktopConnection(config, alias, { standardState: alias, ready: true }),
    /所有者/,
  );
  assert.equal(await readFile(file, 'utf8'), before);
});

test('scoped Mac launch gets the same absolute Codex executable that was verified', async (t) => {
  const root = await temporary(t);
  const binary = join(root, 'codex');
  await writeFile(binary, 'fixture only', { mode: 0o700 });
  const command = await resolveCodexExecutable({ PATH: root });
  const calls = [];
  await verifyCodexConnection(
    { PATH: root },
    async (file, args) => {
      calls.push({ file, args });
    },
    command,
  );
  assert.deepEqual(
    calls.map((call) => call.file),
    [command, command],
  );
  assert.equal(command.startsWith('/'), true);
  const args = macAppLaunchArgs(
    '/tmp/Genie.app',
    { ASTRA_CODEX_PATH: command },
    '/tmp/logs',
    'fixture',
  );
  assert.ok(args.includes(`ASTRA_CODEX_PATH=${command}`));
  assert.ok(!args.includes('/bin/sh'));
});

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
    ['--docker-context', '../other'],
    ['--docker-context', '-remote'],
    ['--docker-context'],
    ['--transaction-simulation'],
  ])
    assert.throws(() => parseOptions(args));
  assert.equal(parseOptions(['stop']).command, 'stop');
  assert.equal(parseOptions(['--app', '/tmp/Genie.app']).open, true);
  assert.equal(parseOptions(['--app', '/tmp/Genie.app', '--no-open']).open, false);
  assert.equal(parseOptions(['--port', '43124', '--no-open']).port, 43124);
  assert.equal(
    parseOptions(['--docker-context', 'colima-genie-test']).dockerContext,
    'colima-genie-test',
  );
});

test('transaction simulation is explicit, requires computer use and only exports the local fixture executable', async (t) => {
  assert.equal(parseOptions([]).transactionSimulation, undefined);
  const options = parseOptions(['--transaction-simulation', '--computer-use']);
  assert.equal(options.transactionSimulation, true);
  const root = await temporary(t);
  assert.deepEqual(await transactionSimulationEnvironment({}, root), {});
  await assert.rejects(transactionSimulationEnvironment({ transactionSimulation: true }, root));
  await assert.rejects(transactionSimulationEnvironment(options, root));
  const directory = join(root, '.build/computer/GenieCheckoutSimulation.app/Contents/MacOS');
  await mkdir(directory, { recursive: true });
  const executable = join(directory, 'GenieCheckoutSimulation');
  await writeFile(executable, '#!/bin/sh\nexit 0\n', { mode: 0o600 });
  await assert.rejects(transactionSimulationEnvironment(options, root));
  await chmod(executable, 0o700);
  assert.deepEqual(await transactionSimulationEnvironment(options, root), {
    ASTRA_TRANSACTION_SIMULATION: 'on',
    ASTRA_TRANSACTION_SIMULATION_APP: executable,
  });
});

test('native app launches through LaunchServices with instance-only scope and a waited lifecycle', () => {
  const scope = {
    ASTRA_GATEWAY_URL: 'http://127.0.0.1:43180',
    ASTRA_DATA_ROOT: '/private/tmp/preview with spaces/app',
    ASTRA_MODEL_DISCLOSURE: 'このMacの model ($literal)',
  };
  const args = macAppLaunchArgs('/tmp/Genie Preview.app', scope, '/tmp/logs', 'unique-instance');
  assert.deepEqual(args.slice(0, 4), ['-n', '-W', '-a', '/tmp/Genie Preview.app']);
  for (const [key, value] of Object.entries(scope)) {
    const position = args.indexOf(`${key}=${value}`);
    assert.equal(args[position - 1], '--env');
  }
  assert.deepEqual(args.slice(-5), [
    '--args',
    '--demo',
    'main',
    '--preview-instance',
    'unique-instance',
  ]);
  assert.ok(!args.includes('/bin/sh'));
});

test('native app monitor accepts confirmed normal exit and keeps early or abnormal exits as failures', async (t) => {
  const root = await temporary(t);
  const processes = new OwnedProcesses({ cwd: root, logs: root });
  t.after(() => processes.stop());
  for (const code of [0, 7]) {
    const child = await processes.spawn(
      `app-exit-${code}`,
      process.execPath,
      ['-e', `process.exit(${code})`],
      systemEnvironment(),
    );
    for (const confirmed of [false, true]) {
      const events = [];
      await monitorNativeAppExit(child.done, {
        state: () => ({ confirmed, stopping: false, aborted: false }),
        stop: () => events.push('stop'),
        fail: (error) => events.push(error.message),
      });
      if (confirmed && code === 0) assert.deepEqual(events, ['stop']);
      else {
        assert.equal(events.length, 1);
        assert.match(events[0], new RegExp(`exit ${code}`));
      }
    }
  }
});

test('native app monitor reads lifecycle at exit and does not replace an existing stop or failure', async () => {
  let finish;
  let confirmed = false;
  const events = [];
  const completion = monitorNativeAppExit(
    new Promise((resolve) => {
      finish = resolve;
    }),
    {
      state: () => ({ confirmed, stopping: false, aborted: false }),
      stop: () => events.push('stop'),
      fail: () => events.push('failure'),
    },
  );
  confirmed = true;
  finish(0);
  await completion;
  assert.deepEqual(events, ['stop']);
  for (const code of [0, 7]) {
    for (const state of [
      { confirmed: true, stopping: true, aborted: false },
      { confirmed: true, stopping: false, aborted: true },
    ]) {
      await monitorNativeAppExit(Promise.resolve(code), {
        state: () => state,
        stop: () => assert.fail('already stopping'),
        fail: () => assert.fail('must preserve original failure'),
      });
    }
  }
});

test('native ownership distinguishes simultaneous app instances and rejects PID reuse without matching argv', async () => {
  const path = '/tmp/Genie Preview.app/Contents/MacOS/GenieMac';
  const inspect = (command) => async (pid) => ({
    pid,
    command,
    started: 'Fri Oct  2 01:00:00 2026',
  });
  const owner = await nativeAppIdentity(
    123,
    path,
    'own',
    {},
    inspect(`${path} --demo main --preview-instance own`),
  );
  assert.equal(owner.pid, 123);
  for (const command of [
    path,
    `${path} --demo main`,
    `${path} --demo main --preview-instance other`,
    `${path} --demo main --preview-instance own --extra`,
    '/other/app --demo main --preview-instance own',
  ])
    assert.equal(await nativeAppIdentity(123, path, 'own', {}, inspect(command)), null);
});

test('native process inspection takes one snapshot and never treats inspection errors as exit', async () => {
  const run = async (file, args, options) => {
    assert.equal(file, '/bin/ps');
    assert.deepEqual(args, ['-ww', '-p', '123', '-o', 'lstart=', '-o', 'stat=', '-o', 'command=']);
    assert.equal(options.env.LC_ALL, 'C');
    return { stdout: 'Fri Oct  2 01:00:00 2026 S /tmp/Genie App --preview-instance own\n' };
  };
  assert.deepEqual(await readNativeProcessIdentity(123, {}, run), {
    pid: 123,
    started: 'Fri Oct  2 01:00:00 2026',
    state: 'S',
    command: '/tmp/Genie App --preview-instance own',
  });
  assert.equal(
    await readNativeProcessIdentity(123, {}, async () => {
      throw Object.assign(new Error(), { code: 1, stdout: '', stderr: '' });
    }),
    null,
  );
  for (const result of [{ stdout: '' }, { stdout: 'invalid' }])
    await assert.rejects(readNativeProcessIdentity(123, {}, async () => result));
  await assert.rejects(
    readNativeProcessIdentity(123, {}, async () => {
      throw Object.assign(new Error(), { code: 1, stdout: '', stderr: 'permission denied' });
    }),
  );
});

test('native stop waits through macOS exiting argv loss and accepts only proven death', async () => {
  const owner = { pid: 123, started: 'start', state: 'S', command: 'owned --nonce own' };
  for (const outcome of ['gone', 'zombie', 'stuck', 'live-mismatch', 'reused', 'wrong-pid']) {
    let time = 0;
    const calls = [];
    const operation = stopOwnedNativeApp(
      owner,
      {},
      {
        graceMs: 10,
        killWaitMs: 5,
        intervalMs: 5,
        now: () => time,
        sleep: async (ms) => {
          time += ms;
        },
        inspect: async () => {
          if (calls.length === 0) return owner;
          if (time < 5 || outcome === 'stuck')
            return { ...owner, state: '?E', command: '(GenieMac)' };
          if (outcome === 'gone') return null;
          if (outcome === 'live-mismatch') return { ...owner, state: 'S', command: 'other app' };
          return {
            ...owner,
            state: 'Z',
            command: '(GenieMac)',
            ...(outcome === 'reused' ? { started: 'new start' } : {}),
            ...(outcome === 'wrong-pid' ? { pid: 456 } : {}),
          };
        },
        sendSignal: (_pid, value) => calls.push(value),
      },
    );
    if (outcome === 'gone' || outcome === 'zombie')
      assert.deepEqual(await operation, { forced: false });
    else
      await assert.rejects(
        operation,
        outcome === 'stuck' ? /終了を確認できません/ : /個体が変わりました/,
      );
    assert.deepEqual(
      calls,
      ['SIGTERM'],
      'never send another signal after argv is discarded during exit',
    );
  }
  for (const state of ['Z', 'Z+', '?E']) {
    const command = '/tmp/Genie --demo main --preview-instance own';
    assert.equal(
      await nativeAppIdentity(123, '/tmp/Genie', 'own', {}, async () => ({
        ...owner,
        command,
        state,
      })),
      null,
    );
  }
});

test('native stop verifies absence, escalates only after grace, and fails if exit stays unconfirmed', async () => {
  const owner = { pid: 123, started: 'start', command: 'owned --nonce own' };
  for (const state of ['absent', 'normal', 'forced', 'stuck']) {
    let time = 0,
      signal;
    const calls = [];
    const operation = stopOwnedNativeApp(
      owner,
      {},
      {
        graceMs: 10,
        killWaitMs: 5,
        intervalMs: 5,
        now: () => time,
        sleep: async (ms) => {
          time += ms;
        },
        inspect: async () =>
          state === 'absent' ||
          (state === 'normal' && signal === 'SIGTERM' && time >= 5) ||
          (state === 'forced' && signal === 'SIGKILL')
            ? null
            : owner,
        sendSignal: (pid, value) => {
          assert.equal(pid, owner.pid);
          signal = value;
          calls.push([value, time]);
        },
      },
    );
    if (state === 'stuck') await assert.rejects(operation, /停止は未確認/);
    else assert.deepEqual(await operation, { forced: state === 'forced' });
    assert.deepEqual(
      calls,
      state === 'absent'
        ? []
        : state === 'normal'
          ? [['SIGTERM', 0]]
          : [
              ['SIGTERM', 0],
              ['SIGKILL', 10],
            ],
    );
  }
});

test('native stop rejects PID/start/argv changes before TERM and immediately before KILL', async () => {
  const owner = { pid: 123, started: 'start', command: 'owned --nonce own' };
  for (const changed of [
    { ...owner, pid: 456 },
    { ...owner, started: 'new start' },
    { ...owner, command: 'other app' },
  ]) {
    for (const changedAt of [1, 4]) {
      let reads = 0,
        time = 0;
      const calls = [];
      await assert.rejects(
        stopOwnedNativeApp(
          owner,
          {},
          {
            graceMs: 10,
            intervalMs: 10,
            now: () => time,
            sleep: async (ms) => {
              time += ms;
            },
            inspect: async () => (++reads >= changedAt ? changed : owner),
            sendSignal: (_pid, value) => calls.push(value),
          },
        ),
        /個体が変わりました/,
      );
      assert.deepEqual(calls, changedAt === 1 ? [] : ['SIGTERM']);
    }
  }
});

test('native stop does not report success after inspection or signal failures', async () => {
  const owner = { pid: 123, started: 'start', command: 'owned' };
  let signals = 0;
  await assert.rejects(
    stopOwnedNativeApp(
      owner,
      {},
      {
        inspect: async () => {
          throw new Error('inspection failed');
        },
        sendSignal: () => {
          signals++;
        },
      },
    ),
  );
  assert.equal(signals, 0);
  for (const code of ['EPERM', 'ESRCH'])
    await assert.rejects(
      stopOwnedNativeApp(
        owner,
        {},
        {
          inspect: async () => owner,
          sendSignal: () => {
            throw Object.assign(new Error(), { code });
          },
        },
      ),
    );
});

test('native stop waits for a real tiny child exit and escalates a TERM-resistant child only', async (t) => {
  const root = await temporary(t);
  for (const resistant of [false, true]) {
    const script = join(root, `owned-${resistant}.mjs`);
    await writeFile(
      script,
      `process.on('SIGTERM',()=>{${resistant ? '' : 'setTimeout(()=>process.exit(0),40)'}});process.send('ready');setInterval(()=>{},1000);`,
    );
    const child = spawn(process.execPath, [script], {
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
    const exited = new Promise((yes) => child.once('exit', yes));
    t.after(async () => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await exited;
    });
    await new Promise((yes, no) => {
      const timer = setTimeout(() => no(new Error('tiny fixture not ready')), 3000);
      child.once('message', () => {
        clearTimeout(timer);
        yes();
      });
      child.once('error', (error) => {
        clearTimeout(timer);
        no(error);
      });
    });
    const owner = await readNativeProcessIdentity(child.pid, systemEnvironment());
    const result = await stopOwnedNativeApp(owner, systemEnvironment(), {
      graceMs: resistant ? 150 : 2000,
      killWaitMs: 2000,
      intervalMs: 20,
    });
    await exited;
    assert.deepEqual(result, { forced: resistant });
    assert.equal(child.signalCode, resistant ? 'SIGKILL' : null);
    assert.equal(child.exitCode, resistant ? null : 0);
  }
});

test('explicit local Docker selection pins child operations without inheriting or changing the user context', async () => {
  const parent = { PATH: '/bin', DOCKER_HOST: 'tcp://remote:2375', DOCKER_CONTEXT: 'remote' };
  const clean = systemEnvironment(parent);
  const calls = [];
  const result = await dockerEnvironment(clean, 'colima-test', async (file, args, env) => {
    calls.push([file, args]);
    assert.equal(env.DOCKER_HOST, undefined);
    assert.equal(env.DOCKER_CONTEXT, undefined);
    return 'unix:///private/tmp/genie-docker.sock';
  });
  assert.deepEqual(calls, [
    ['docker', ['context', 'inspect', 'colima-test', '--format', '{{.Endpoints.docker.Host}}']],
  ]);
  assert.equal(result.env.DOCKER_CONTEXT, 'colima-test');
  assert.equal(clean.DOCKER_CONTEXT, undefined);
  assert.equal(parent.DOCKER_CONTEXT, 'remote');
  assert.equal(result.env.DOCKER_HOST, undefined);
});

test('Docker endpoint changes are revalidated on every start and remote/relative/missing contexts fail closed', async () => {
  const clean = systemEnvironment({ PATH: '/bin' });
  const selected = async (endpoint) => dockerEnvironment(clean, 'fixture', async () => endpoint);
  assert.equal((await selected('unix:///tmp/fixture.sock')).name, 'fixture');
  for (const endpoint of [
    'tcp://127.0.0.1:2375',
    'ssh://localhost',
    'unix://relative.sock',
    'unix:relative.sock',
    'unix://host/tmp/socket',
    'unix:////remote/socket',
    'unix:///',
    '',
    null,
  ])
    await assert.rejects(selected(endpoint));
  const calls = [];
  const fallback = await dockerEnvironment(clean, undefined, async (_file, args) => {
    calls.push(args);
    return args[1] === 'show' ? 'default' : 'unix:///var/run/docker.sock';
  });
  assert.equal(fallback.name, 'default');
  assert.equal(fallback.env.DOCKER_CONTEXT, 'default');
  assert.equal(calls[0][1], 'show');
  assert.equal(calls[1][1], 'inspect');
});

test('explicit Docker context persists for restart, migrates legacy state optionally and prevents changing its database host', async (t) => {
  const root = await temporary(t);
  const initial = await loadConfig(root);
  assert.equal(initial.dockerContext, undefined);
  const migrated = await loadConfig(root, { dockerContext: 'colima-test' });
  assert.equal(migrated.dockerContext, 'colima-test');
  assert.equal(migrated.project, initial.project);
  assert.equal(migrated.identity, initial.identity);
  assert.equal((await loadConfig(root)).dockerContext, 'colima-test');
  await assert.rejects(loadConfig(root, { dockerContext: 'another-context' }));
  assert.equal((await loadConfig(root)).dockerContext, 'colima-test');
  const fresh = await loadConfig(await temporary(t), { dockerContext: 'isolated' });
  assert.equal(fresh.dockerContext, 'isolated');
  assert.throws(() => validateConfig({ ...fresh, dockerContext: '../invalid' }));
});

test('model choice persists explicit intent, supports Ollama latest aliases and never picks a paid fallback', () => {
  assert.equal(selectModel(['llama3.2:latest'], 'llama3.2'), 'llama3.2:latest');
  assert.equal(selectModel(['qwen3.5:9b']), 'qwen3.5:9b');
  assert.throws(() => selectModel(['qwen3.5:9b'], 'llama3.2'));
  assert.throws(() => selectModel(['qwen3.5:9b', 'llama3.2:latest']));
  assert.throws(() => selectModel([]));
});

test('external CLI selection needs explicit opt-in, persists that choice, and never inherits the old local model', async (t) => {
  const base = await loadConfig(await temporary(t));
  base.model = 'qwen3.5:9b';
  assert.throws(() => modelConfiguration(base, { modelProvider: 'codex' }));
  assert.throws(() => parseOptions(['--model-provider', 'unknown']));
  assert.throws(() =>
    parseOptions(['--model-provider', 'codex', '--model-url', 'http://localhost:11434/v1']),
  );
  const external = modelConfiguration(
    base,
    parseOptions(['--model-provider', 'codex', '--allow-cloud', '--model', 'gpt-6-sol']),
  );
  assert.equal(external.modelProvider, 'codex');
  assert.equal(external.allowCloud, true);
  assert.equal(external.model, 'gpt-6-sol');
  assert.equal(base.model, 'qwen3.5:9b');
  assert.equal(base.modelProvider, undefined);
  validateConfig(external);
  assert.deepEqual(modelConfiguration(external), external);
  assert.equal(
    modelConfiguration(base, { modelProvider: 'codex', allowCloud: true }).model,
    'gpt-6-sol',
  );
  assert.throws(() => validateConfig({ ...external, allowCloud: false }));
  assert.throws(() => validateConfig({ ...external, allowCloud: 'true' }));
  const local = modelConfiguration(external, { modelProvider: 'local', model: 'qwen3.5:9b' });
  assert.equal(local.allowCloud, false);
  assert.throws(() => modelConfiguration(local, { modelProvider: 'codex' }));
});

test('external conversation selection does not authorize screen egress or import credentials', async (t) => {
  const root = await temporary(t);
  const config = modelConfiguration(await loadConfig(root), {
    modelProvider: 'codex',
    allowCloud: true,
    model: 'gpt-6-sol',
  });
  const env = serviceEnvironment(config, root, repo, {
    PATH: '/bin',
    OPENAI_API_KEY: 'must-not-copy',
    ASTRA_LOCAL_VISION: '1',
    ASTRA_LOCAL_LLM_URL: 'http://localhost:1',
    ASTRA_COMPUTER_VISION_EXTERNAL: 'on',
  });
  assert.equal(env.ASTRA_LLM_CLI, 'codex');
  assert.equal(env.ASTRA_COMPUTER_VISION_EXTERNAL, 'off');
  assert.equal(env.ASTRA_CODEX_MODEL, 'gpt-6-sol');
  assert.equal(env.ASTRA_LOCAL_LLM_URL, undefined);
  assert.equal(env.OPENAI_API_KEY, undefined);
  const app = modelAppEnvironment(config);
  assert.equal(app.ASTRA_LOCAL_VISION, '0');
  assert.equal(app.ASTRA_LLM_CLI, 'codex');
  assert.equal(app.ASTRA_CODEX_MODEL, 'gpt-6-sol');
  assert.match(app.ASTRA_MODEL_DISCLOSURE, /OpenAI.*gpt-6-sol/);
  assert.match(app.ASTRA_MODEL_DISCLOSURE, /外部モデルへ送ります/);
  assert.doesNotMatch(app.ASTRA_MODEL_DISCLOSURE, /このMacの/);
  assert.throws(() => modelEnvironment({ ...config, allowCloud: false }));
  assert.throws(() => modelAppEnvironment({ ...config, allowCloud: false }));
});

test('screen opt-in is separate, persists only for the exact provider/model, and can be revoked', async (t) => {
  const base = await loadConfig(await temporary(t));
  const conversation = modelConfiguration(base, { modelProvider: 'codex', allowCloud: true });
  assert.equal(externalScreenAllowed(conversation, true), false);
  assert.throws(() => parseOptions(['--allow-external-screen']));
  assert.throws(() => modelConfiguration(base, { computerUse: true, allowExternalScreen: true }));
  assert.throws(() => modelConfiguration(conversation, { allowExternalScreen: true }));
  const screen = modelConfiguration(
    conversation,
    parseOptions(['--computer-use', '--allow-external-screen']),
  );
  assert.deepEqual(screen.externalScreenAuthorization, { provider: 'codex', model: 'gpt-6-sol' });
  validateConfig(screen);
  assert.equal(externalScreenAllowed(screen, true), true);
  assert.equal(externalScreenAllowed(screen, false), false);
  assert.deepEqual(modelConfiguration(screen), screen);
  assert.equal(
    externalScreenAllowed(modelConfiguration(screen, { model: 'gpt-6-astra' }), true),
    false,
  );
  const local = modelConfiguration(screen, { modelProvider: 'local', model: 'qwen3.5:9b' });
  assert.equal(local.externalScreenAuthorization, null);
  const back = modelConfiguration(local, { modelProvider: 'codex', allowCloud: true });
  assert.equal(externalScreenAllowed(back, true), false);
  const revoked = modelConfiguration(screen, parseOptions(['--no-external-screen']));
  assert.equal(revoked.externalScreenAuthorization, null);
  assert.equal(revoked.allowCloud, true);
  assert.equal(externalScreenAllowed(modelConfiguration(revoked), true), false);
  for (const invalid of [
    true,
    'true',
    [],
    { provider: 'codex', model: 'other' },
    { provider: 'codex', model: 'gpt-6-sol', extra: true },
  ]) {
    assert.throws(() => validateConfig({ ...screen, externalScreenAuthorization: invalid }));
  }
});

test('screen permission cannot leak from another state directory or enable an inactive computer route', async (t) => {
  const first = await temporary(t);
  const second = await temporary(t);
  const allowed = modelConfiguration(await loadConfig(first), {
    modelProvider: 'codex',
    allowCloud: true,
    computerUse: true,
    allowExternalScreen: true,
  });
  const other = modelConfiguration(await loadConfig(second), {
    modelProvider: 'codex',
    allowCloud: true,
  });
  await writeFile(join(first, 'runtime.json'), JSON.stringify(allowed));
  assert.equal(externalScreenAllowed(modelConfiguration(await loadConfig(first)), true), true);
  assert.equal(externalScreenAllowed(modelConfiguration(await loadConfig(second)), true), false);
  assert.equal(
    serviceEnvironment(allowed, first, repo, {}, { computerUse: true })
      .ASTRA_COMPUTER_VISION_EXTERNAL,
    'on',
  );
  assert.equal(serviceEnvironment(allowed, first, repo, {}).ASTRA_COMPUTER_VISION_EXTERNAL, 'off');
  assert.equal(
    serviceEnvironment(
      other,
      second,
      repo,
      { ASTRA_COMPUTER_VISION_EXTERNAL: 'on' },
      { computerUse: true },
    ).ASTRA_COMPUTER_VISION_EXTERNAL,
    'off',
  );
  assert.equal(modelEnvironment(allowed).ASTRA_COMPUTER_VISION_EXTERNAL, undefined);
});

test('computer status probes the selected helper anew and exposes only bounded status fields', async (t) => {
  const folder = await temporary(t);
  const executable = join(folder, 'selected-helper');
  const stateFile = join(folder, 'permission.json');
  const value = {
    accessibility: true,
    screenRecording: true,
    supported: true,
    ready: true,
    unattendedTest: false,
    deliveryMode: 'background',
    capabilities: ['ax_press', 'append_text_field'],
    extraSecret: 'must-not-leak',
  };
  await writeFile(stateFile, JSON.stringify(value));
  await writeFile(
    executable,
    `#!${process.execPath}\nconst fs = require('node:fs');\nif (JSON.stringify(process.argv.slice(2)) !== '["--status"]') process.exit(9);\nprocess.stdout.write(fs.readFileSync(process.env.FIXTURE_STATUS_FILE));\n`,
    { mode: 0o700 },
  );
  const env = { ...systemEnvironment(), FIXTURE_STATUS_FILE: stateFile };
  const current = {
    project: 'fixture',
    phase: 'ready',
    computerUse: true,
    computerDelivery: 'background',
    computerHelperUnattendedTest: false,
    model: 'gpt-6-sol',
    modelProvider: 'codex',
    externalScreenAllowed: true,
    recipient: 'OpenAI / Codex (gpt-6-sol)',
  };
  const first = await computerStatusResponse(current, executable, env);
  assert.equal(first.computerHelper.path, executable);
  assert.equal(first.computerHelper.status.ready, true);
  assert.equal(first.computerHelper.status.extraSecret, undefined);
  assert.equal(first.recipient, current.recipient);
  await writeFile(stateFile, JSON.stringify({ ...value, accessibility: false, ready: false }));
  const later = await computerStatusResponse(current, executable, env);
  assert.equal(later.computerHelper.status.ready, false);
  assert.equal(later.computerHelper.status.accessibility, false);
  const disabled = await computerStatusResponse(
    { ...current, computerUse: false },
    executable,
    env,
    async () => {
      throw new Error('Must not execute disabled helper');
    },
  );
  assert.equal(disabled.computerHelper.status, null);
  assert.equal(disabled.computerHelper.error, 'computer_use_disabled');
  assert.equal(disabled.computerHelperUnattendedTest, null);
});

test('unknown, invalid or failed helper probes remain unavailable without subprocess output disclosure', async () => {
  assert.equal((await readComputerHelperStatus(null, {})).error, 'helper_not_configured');
  for (const stdout of ['not JSON', '{}', JSON.stringify({ ready: 'true' }), '[]']) {
    const result = await readComputerHelperStatus(
      '/owned/helper',
      {},
      async (path, args, options) => {
        assert.equal(path, '/owned/helper');
        assert.deepEqual(args, ['--status']);
        assert.equal(options.timeout, 8000);
        assert.equal(options.maxBuffer, 65536);
        return { stdout };
      },
    );
    assert.equal(result.status, null);
    assert.ok(result.error);
  }
  const result = await readComputerHelperStatus('/owned/helper', {}, async () => {
    throw new Error('sensitive stderr must-not-leak');
  });
  assert.equal(result.error, 'helper_status_unavailable');
  assert.doesNotMatch(JSON.stringify(result), /sensitive|must-not-leak/);
});

test('Codex omitted model uses the same explicit model for host, native translation and disclosure', async (t) => {
  const root = await temporary(t);
  const config = modelConfiguration(await loadConfig(root), {
    modelProvider: 'codex',
    allowCloud: true,
  });
  assert.equal(config.model, 'gpt-6-sol');
  // Older saved configurations may still have a null model. Never let the host
  // use the CLI default while native translation selects a different model.
  for (const selected of [config, { ...config, model: null }]) {
    assert.equal(modelEnvironment(selected).ASTRA_CODEX_MODEL, 'gpt-6-sol');
    assert.equal(modelAppEnvironment(selected).ASTRA_CODEX_MODEL, 'gpt-6-sol');
    assert.equal(modelEnvironment(selected).ASTRA_LOCAL_LLM_MODEL, undefined);
    assert.equal(modelAppEnvironment(selected).ASTRA_LOCAL_LLM_URL, undefined);
    assert.match(readyMessage(selected, root), /gpt-6-solで依頼できます/);
    assert.match(modelAppEnvironment(selected).ASTRA_MODEL_DISCLOSURE, /OpenAI の gpt-6-sol/);
  }
  assert.doesNotMatch(readyMessage(config, root), /null|undefined/);
  assert.match(readyMessage({ ...config, model: 'gpt-6-sol' }, root), /gpt-6-solで依頼できます/);
  assert.match(
    readyMessage({ modelProvider: 'local', model: 'qwen3.5:9b' }, root),
    /qwen3.5:9bで依頼できます/,
  );
});

test('explicit local selection reaches native translation with its exact model and endpoint', async (t) => {
  const root = await temporary(t);
  const config = modelConfiguration(await loadConfig(root), {
    modelProvider: 'local',
    model: 'llama3.2:latest',
    modelURL: 'http://127.0.0.1:12434/v1',
  });
  const app = modelAppEnvironment(config);
  const host = modelEnvironment(config);
  assert.equal(app.ASTRA_LLM_CLI, 'local');
  assert.equal(app.ASTRA_LOCAL_LLM_MODEL, host.ASTRA_LOCAL_LLM_MODEL);
  assert.equal(app.ASTRA_LOCAL_LLM_URL, host.ASTRA_LOCAL_LLM_URL);
  assert.equal(app.ASTRA_LOCAL_LLM_MODEL, 'llama3.2:latest');
  assert.equal(app.ASTRA_LOCAL_LLM_URL, 'http://127.0.0.1:12434/v1');
  assert.equal(app.ASTRA_CODEX_MODEL, undefined);
  assert.equal(app.ASTRA_LOCAL_VISION, '1');
  const args = macAppLaunchArgs('/tmp/Genie.app', app, '/tmp/logs', 'fixture');
  assert.ok(args.includes('ASTRA_LOCAL_LLM_MODEL=llama3.2:latest'));
  assert.ok(args.includes('ASTRA_LOCAL_LLM_URL=http://127.0.0.1:12434/v1'));
  assert.match(app.ASTRA_MODEL_DISCLOSURE, /このMacの llama3\.2:latest/);
});

test('CLI readiness uses its own authentication boundary without a generated prompt or credential copy', async () => {
  const calls = [];
  await verifyCodexConnection(
    { PATH: '/bin', HOME: '/fixture/home' },
    async (file, args, options) => {
      calls.push({ file, args, options });
    },
  );
  assert.deepEqual(
    calls.map(({ file, args }) => [file, args]),
    [
      ['codex', ['--version']],
      ['codex', ['login', 'status']],
    ],
  );
  await assert.rejects(
    verifyCodexConnection({}, async () => {
      throw Error('credential-secret');
    }),
    (error) =>
      !error.message.includes('credential-secret') &&
      error.message.includes('自動で切り替えません'),
  );
});

test('Ollama cloud models and renamed remote aliases cannot be disclosed as local inference', async () => {
  for (const name of ['qwen3.5:cloud', 'model:671b-cloud', 'custom-cloud:latest', 'model_cloud'])
    assert.throws(() => assertLocalModel(name));
  assert.throws(() => assertLocalModel('innocent-alias', { remote_host: 'https://ollama.com' }));
  assert.throws(() => assertLocalModel('innocent-alias', { remote_model: 'hosted-model' }));
  const config = { modelURL: 'http://127.0.0.1:11434/v1', model: 'local-alias' };
  await verifyLocalOllamaModel(config, async (url, options) => {
    assert.equal(url, 'http://127.0.0.1:11434/api/show');
    assert.deepEqual(JSON.parse(options.body), { model: 'local-alias' });
    return { model_info: { architecture: 'qwen' } };
  });
  await assert.rejects(
    verifyLocalOllamaModel(config, async () => ({
      remote_host: 'https://ollama.com',
      model_info: {},
    })),
  );
  await assert.rejects(verifyLocalOllamaModel(config, async () => ({})));
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
    ASTRA_TRANSACTION_SIMULATION: 'on',
    ASTRA_TRANSACTION_SIMULATION_APP: '/external/fixture',
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
    'ASTRA_TRANSACTION_SIMULATION',
    'ASTRA_TRANSACTION_SIMULATION_APP',
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

test('Claude Code and Gemini API are explicit external choices with their own model, recipient and disclosure', async (t) => {
  const root = await temporary(t);
  const base = await loadConfig(root);
  base.model = 'qwen3.5:9b';
  for (const [provider, model, recipient, modelKey] of [
    ['claude_code', 'claude-sonnet-5-5', 'Anthropic', 'ASTRA_CLAUDE_CODE_MODEL'],
    ['gemini_api', 'gemini-2.5-flash', 'Google', 'ASTRA_GEMINI_MODEL'],
  ]) {
    // No silent external use, and no inherited local model name.
    assert.throws(() => modelConfiguration(base, { modelProvider: provider }), /--allow-cloud/);
    assert.throws(() =>
      parseOptions(['--model-provider', provider, '--model-url', 'http://localhost:11434/v1']),
    );
    const config = modelConfiguration(
      base,
      parseOptions(['--model-provider', provider, '--allow-cloud']),
    );
    assert.equal(config.modelProvider, provider);
    assert.equal(config.model, model);
    assert.equal(config.allowCloud, true);
    assert.equal(config.externalScreenAuthorization, null);
    validateConfig(config);
    assert.deepEqual(modelConfiguration(config), config);
    assert.throws(() => validateConfig({ ...config, allowCloud: false }));

    const env = serviceEnvironment(config, root, repo, {
      PATH: '/bin',
      GEMINI_API_KEY: 'must-not-copy',
      ANTHROPIC_API_KEY: 'must-not-copy',
      ASTRA_LOCAL_LLM_URL: 'http://localhost:1',
    });
    assert.equal(env.ASTRA_LLM_CLI, provider);
    assert.equal(env[modelKey], model);
    assert.equal(env.ASTRA_LOCAL_LLM_URL, undefined);
    assert.equal(env.ASTRA_CODEX_MODEL, undefined);
    assert.equal(env.ASTRA_COMPUTER_VISION_EXTERNAL, 'off');
    assert.ok(!Object.values(env).includes('must-not-copy'));
    assert.equal(
      env.ASTRA_GEMINI_API_URL,
      provider === 'gemini_api'
        ? 'https://generativelanguage.googleapis.com/v1beta/openai'
        : undefined,
    );

    const app = modelAppEnvironment(config);
    assert.equal(app.ASTRA_LLM_CLI, provider);
    assert.equal(app.ASTRA_LOCAL_VISION, '0');
    assert.match(app.ASTRA_MODEL_DISCLOSURE, new RegExp(`${recipient} の ${model}`));
    assert.match(app.ASTRA_MODEL_DISCLOSURE, /外部モデルへ送ります/);
    assert.throws(() => modelAppEnvironment({ ...config, allowCloud: false }));

    const descriptor = desktopConnectionDescriptor(
      { ...config, port: 43123, identity: '11111111-2222-4333-8444-555555555555' },
      root,
    );
    assert.deepEqual(descriptor.model, { provider, name: model });
    assert.deepEqual(descriptor.externalAuthorization, { provider, model });

    // Screen images stay a separate permission that these providers cannot be given here.
    assert.throws(() =>
      modelConfiguration(base, {
        modelProvider: provider,
        allowCloud: true,
        computerUse: true,
        allowExternalScreen: true,
      }),
    );
    // Returning to the Mac drops the external permission.
    const local = modelConfiguration(config, { modelProvider: 'local', model: 'qwen3.5:9b' });
    assert.equal(local.allowCloud, false);
    assert.throws(() => modelConfiguration(local, { modelProvider: provider }));
  }
});

test('Claude Code readiness asks the CLI for its own sign-in state and never falls back', async (t) => {
  const root = await temporary(t);
  const binary = join(root, 'claude');
  await writeFile(binary, 'fixture only', { mode: 0o700 });
  const command = await resolveClaudeExecutable({ PATH: root });
  const calls = [];
  await verifyClaudeConnection(
    { PATH: root },
    async (file, args) => {
      calls.push([file, args]);
    },
    command,
  );
  assert.deepEqual(calls, [
    [command, ['--version']],
    [command, ['auth', 'status']],
  ]);
  await assert.rejects(
    verifyClaudeConnection({}, async () => {
      throw Error('credential-secret');
    }),
    (error) =>
      !error.message.includes('credential-secret') &&
      error.message.includes('自動で切り替えません'),
  );
});

test('Gemini readiness checks only that the key exists and never reads or prints it', async () => {
  const calls = [];
  await verifyGeminiKey({ PATH: '/bin' }, 'genie-preview-0123456789ab', async (file, args) => {
    calls.push([file, args]);
  });
  assert.deepEqual(calls, [
    [
      '/usr/bin/security',
      [
        'find-generic-password',
        '-a',
        'genie-preview-0123456789ab',
        '-s',
        'com.astra.connector.llm.gemini_api',
      ],
    ],
  ]);
  // -w would print the secret; -g would too.
  assert.ok(!calls[0][1].includes('-w') && !calls[0][1].includes('-g'));
  await assert.rejects(
    verifyGeminiKey({}, 'genie-preview-0123456789ab', async () => {
      throw Error('key-secret');
    }),
    (error) =>
      !error.message.includes('key-secret') &&
      error.message.includes('security add-generic-password -a genie-preview-0123456789ab') &&
      error.message.includes('自動で切り替えません'),
  );
});
