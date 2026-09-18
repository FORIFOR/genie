#!/usr/bin/env node
/** One owner for setup, the three local services, readiness and clean shutdown. */
import { execFile } from 'node:child_process';
import { mkdir, readFile, realpath, access, constants } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { promisify } from 'node:util';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { desktopEmail } from './start-local-host.mjs';
import {
  parseOptions,
  DEFAULT_STATE,
  DEFAULT_PORT,
  PNPM_VERSION,
  systemEnvironment,
  lockPort,
  loadConfig,
  validateConfig,
  privateJSON,
  availablePort,
  composeConfig,
  serviceEnvironment,
  selectModel,
} from './local-preview/config.mjs';
import { OwnedProcesses, waitFor, jsonRequest } from './local-preview/processes.mjs';

const exec = promisify(execFile);
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const HELP = `Genie ローカル起動

  node scripts/start-local-preview.mjs --model qwen3.5:9b
  node scripts/start-local-preview.mjs status
  node scripts/start-local-preview.mjs stop

必要: Node 22以降・Docker Desktop・Ollamaの導入済みモデル・Genie.app。
初回は固定版pnpm・依存パッケージ・コンテナイメージを取得し、専用DBを作ります。
DB設定・マイグレーション・3サービスの起動をまとめて行います。
準備完了後もこのターミナルは開いたまま使います。Ctrl+Cで停止、保存データは保持。
有料APIへの切替・モデル取得・AIへの依頼・外部サービスの同期は自動で行いません。

  --model <名前>       Ollamaのモデル名。初回に複数ある場合は選択
  --model-url <URL>    ローカルHTTPモデル（既定 http://127.0.0.1:11434/v1）
  --app <Genie.app>    開くMacアプリ（既定 /Applications/Genie.app）
  --state-dir <path>  専用の保存先（既定 ${DEFAULT_STATE}）
  --port <port>       初回作成時のGatewayポート（既定 ${DEFAULT_PORT}）
  --no-open           アプリを開かず起動（Linuxの統合検証でも使用）
  --computer-use      Macの画面操作を有効化。操作ごとの承認が必要
  --help             この案内を表示

この起動経路は独立したプレビュー用です。既存の.env・DB・通常起動のアプリ履歴を変更しません。
`;

async function probe(file, args, env) {
  try {
    return (
      await exec(file, args, { env, cwd: REPO, timeout: 8000, maxBuffer: 65536 })
    ).stdout.trim();
  } catch {
    return null;
  }
}

export async function control(options) {
  let stateDir, config;
  try {
    stateDir = await realpath(options.stateDir);
    config = JSON.parse(await readFile(join(stateDir, 'runtime.json'), 'utf8'));
    validateConfig(config);
  } catch {
    throw new Error('起動設定が見つかりません。同じ --state-dir で start を実行してください。');
  }
  try {
    const result = await jsonRequest(`http://127.0.0.1:${lockPort(stateDir)}/${options.command}`, {
      method: options.command === 'stop' ? 'POST' : 'GET',
      headers: { authorization: `Bearer ${config.controlToken}` },
    });
    if (result.project !== config.project) throw new Error('起動管理の識別情報が一致しません。');
    console.log(JSON.stringify(result));
  } catch {
    if (options.command === 'stop')
      throw new Error(
        'この保存先の起動管理には接続できませんでした。既存の別プロセスは停止していません。',
      );
    console.log(
      JSON.stringify({
        phase: 'stopped',
        project: config.project,
        message: '起動管理は動いていません。保存データは保持されています。',
      }),
    );
    process.exitCode = 1;
  }
}

export async function start(options) {
  if (Number(process.versions.node.split('.')[0]) < 22)
    throw new Error('Node 22以降をインストールしてから実行してください。');
  if (process.platform !== 'darwin' && options.open)
    throw new Error('アプリの起動はmacOS専用です。サービス検証には --no-open を指定してください。');
  await mkdir(options.stateDir, { recursive: true, mode: 0o700 });
  const stateDir = await realpath(options.stateDir);
  const env = systemEnvironment();
  const abort = new AbortController();
  let config,
    processes,
    composeArgs,
    composeEnv,
    containersTouched = false,
    stopping = false,
    failure,
    phase = 'checking';
  const stop = () => {
    stopping = true;
    abort.abort();
  };
  const fail = (error) => {
    failure ??= error;
    abort.abort();
  };
  abort.signal.addEventListener(
    'abort',
    () => {
      void processes?.stop();
    },
    { once: true },
  );
  const status = () => ({
    project: config?.project ?? null,
    phase,
    gateway: config ? `http://127.0.0.1:${config.port}` : null,
    model: config?.model ?? null,
  });
  const server = createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (!config || req.headers.authorization !== `Bearer ${config.controlToken}`) {
      res.writeHead(403);
      res.end('{}');
      return;
    }
    if (req.url === '/status' && req.method === 'GET') res.end(JSON.stringify(status()));
    else if (req.url === '/stop' && req.method === 'POST') {
      res.end(JSON.stringify({ ...status(), phase: 'stopping' }));
      stop();
    } else {
      res.writeHead(404);
      res.end('{}');
    }
  });
  server.requestTimeout = 3000;
  server.headersTimeout = 3000;
  await new Promise((yes, no) => {
    server.once('error', () =>
      no(
        new Error(
          'この保存先は起動中、または管理ポートが使用中です。statusで確認してください。二重起動は行いません。',
        ),
      ),
    );
    server.listen({ host: '127.0.0.1', port: lockPort(stateDir), exclusive: true }, yes);
  });
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  const stage = (next, message) => {
    phase = next;
    console.log(message);
  };
  try {
    config = await loadConfig(stateDir, options);
    if (options.modelURL) config.modelURL = options.modelURL;
    const base = `http://127.0.0.1:${config.port}`;
    const app = resolve(options.app ?? '/Applications/Genie.app');
    let appExecutable, appBundleID;
    if (options.open) {
      const appVersion = await probe(
        '/usr/libexec/PlistBuddy',
        ['-c', 'Print :CFBundleShortVersionString', join(app, 'Contents/Info.plist')],
        env,
      );
      const sourceVersion = JSON.parse(await readFile(join(REPO, 'package.json'), 'utf8')).version;
      if (!appVersion)
        throw new Error(
          'Genie.appが見つかりません。Applicationsへコピーするか --app で指定してください。',
        );
      if (appVersion !== sourceVersion)
        throw new Error(
          `アプリ(${appVersion})とソース(${sourceVersion})の版が違います。同じリリースを使ってください。`,
        );
      const executableName = await probe(
        '/usr/libexec/PlistBuddy',
        ['-c', 'Print :CFBundleExecutable', join(app, 'Contents/Info.plist')],
        env,
      );
      if (!executableName || executableName.includes('/'))
        throw new Error('アプリの実行ファイルを確認できません。');
      appExecutable = join(app, 'Contents/MacOS', executableName);
      appBundleID = await probe(
        '/usr/libexec/PlistBuddy',
        ['-c', 'Print :CFBundleIdentifier', join(app, 'Contents/Info.plist')],
        env,
      );
      if (!appBundleID || !/^[a-zA-Z0-9.-]+$/.test(appBundleID))
        throw new Error('アプリの識別情報を確認できません。');
      await access(appExecutable, constants.X_OK);
      const escapedExecutable = appExecutable.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      if (await probe('/usr/bin/pgrep', ['-f', `^${escapedExecutable}( |$)`], env)) {
        throw new Error(
          'Genieが既に起動しています。Genieのメニューから一度終了して、同じ起動コマンドを再実行してください。',
        );
      }
    }
    try {
      await availablePort(config.port);
    } catch {
      throw new Error(
        `ポート${config.port}は既に使用中です。既存サービスは停止していません。別の保存先と --port を指定できます。`,
      );
    }
    if (!(await probe('docker', ['compose', 'version'], env)))
      throw new Error(
        'Docker Composeが見つかりません。Docker Desktopをインストールして再実行してください。',
      );
    if (!(await probe('docker', ['info', '--format', '{{.ServerVersion}}'], env))) {
      if (process.platform === 'darwin') await probe('/usr/bin/open', ['-a', 'Docker'], env);
      stage('docker', 'Dockerの起動を待っています…');
      await waitFor(
        async () => Boolean(await probe('docker', ['info', '--format', '{{.ServerVersion}}'], env)),
        {
          signal: abort.signal,
          timeout: 120_000,
          message:
            'Dockerを起動できません。Docker Desktopの画面で初回設定を完了し、同じコマンドを再実行してください。',
        },
      );
    }
    // A user's selected context can point at another machine despite a loopback app URL.
    const contextName = await probe('docker', ['context', 'show'], env);
    if (!contextName) throw new Error('Dockerのcontextを確認できません。');
    const context = await probe(
      'docker',
      ['context', 'inspect', contextName, '--format', '{{.Endpoints.docker.Host}}'],
      env,
    );
    if (!context?.startsWith('unix://'))
      throw new Error(
        'この起動経路はMac内のDocker専用です。Docker Desktopのローカルcontextを選択してください。',
      );
    let models;
    try {
      models = await jsonRequest(config.modelURL + '/models');
    } catch {
      if (process.platform === 'darwin' && config.modelURL === 'http://127.0.0.1:11434/v1')
        await probe('/usr/bin/open', ['-a', 'Ollama'], env);
      stage('model', 'ローカルモデルの起動を待っています…');
      await waitFor(
        async () => {
          models = await jsonRequest(config.modelURL + '/models');
          return Array.isArray(models.data);
        },
        {
          signal: abort.signal,
          timeout: 30_000,
          message: 'モデルに接続できません。Ollamaを起動し、同じコマンドを再実行してください。',
        },
      );
    }
    const names = (models.data ?? []).map((item) => item.id);
    let selected = options.model ?? config.model;
    if (!selected && names.length > 1 && stdin.isTTY) {
      const choices = names.filter(
        (s) => typeof s === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,159}$/.test(s),
      );
      console.log(choices.map((name, i) => `${i + 1}. ${name}`).join('\n'));
      const prompt = createInterface({ input: stdin, output: stdout });
      try {
        const answer = await prompt.question('使うモデルの番号: ', { signal: abort.signal });
        selected = choices[Number(answer) - 1] ?? 'invalid-selection';
      } finally {
        prompt.close();
      }
    }
    config.model = selectModel(names, selected);
    await privateJSON(join(stateDir, 'runtime.json'), config);
    const logs = join(stateDir, 'logs');
    await mkdir(logs, { recursive: true, mode: 0o700 });
    processes = new OwnedProcesses({ cwd: REPO, logs, signal: abort.signal, onFailure: fail });
    // Use an already installed pinned pnpm; otherwise provision only inside our tools directory.
    let pnpm,
      pnpmArgs = [];
    if ((await probe('pnpm', ['--version'], env)) === PNPM_VERSION) pnpm = 'pnpm';
    else {
      const toolsDir = join(stateDir, 'tools');
      const entry = join(toolsDir, 'node_modules/pnpm/bin/pnpm.cjs');
      if ((await probe(process.execPath, [entry, '--version'], env)) !== PNPM_VERSION) {
        if (!(await probe('npm', ['--version'], env)))
          throw new Error('npmが見つかりません。npmを含むNodeのインストールを確認してください。');
        stage('tools', '初回の起動ツールを準備しています…');
        await processes.run(
          'tools',
          'npm',
          [
            'install',
            '--prefix',
            toolsDir,
            '--no-audit',
            '--no-fund',
            '--ignore-scripts',
            '--package-lock=false',
            `pnpm@${PNPM_VERSION}`,
          ],
          env,
          { timeout: 300_000 },
        );
      }
      pnpm = process.execPath;
      pnpmArgs = [entry];
    }
    stage('dependencies', '依存パッケージを確認しています（初回はダウンロードします）…');
    await processes.run(
      'dependencies',
      pnpm,
      [...pnpmArgs, 'install', '--frozen-lockfile'],
      { ...env, CI: 'true' },
      { timeout: 600_000 },
    );
    stage('build', 'ローカル実行サービスを準備しています…');
    await processes.run('build', pnpm, [...pnpmArgs, 'build'], env, { timeout: 300_000 });
    let computerHelper;
    if (options.computerUse) {
      if (process.platform !== 'darwin')
        throw new Error('--computer-use はmacOSでのみ利用できます。');
      if (!(await probe('swiftc', ['--version'], env)))
        throw new Error(
          '画面操作の準備にSwiftコンパイラが必要です。Xcode Command Line Toolsを導入してください。',
        );
      stage('computer', '画面操作ヘルパーを準備しています…');
      await processes.run(
        'computer-helper',
        'bash',
        [join(REPO, 'scripts/ux-auto/build-tools.sh')],
        env,
        {
          timeout: 120_000,
        },
      );
      computerHelper = join(REPO, '.build/uxlab/uxin');
      await access(computerHelper, constants.X_OK);
    }
    const composeFile = join(stateDir, 'compose.json');
    await privateJSON(composeFile, composeConfig(config, REPO));
    composeArgs = [
      '--context',
      contextName,
      'compose',
      '--env-file',
      '/dev/null',
      '-p',
      config.project,
      '-f',
      composeFile,
    ];
    composeEnv = { ...env, GENIE_PREVIEW_DB_PASSWORD: config.adminPassword };
    stage('database', 'このプレビュー専用の保存場所を準備しています…');
    containersTouched = true;
    await processes.run(
      'infrastructure',
      'docker',
      [
        ...composeArgs,
        'up',
        '-d',
        '--wait',
        '--wait-timeout',
        '180',
        'postgres',
        'redis',
        'temporal',
      ],
      composeEnv,
      { timeout: 600_000 },
    );
    await processes.run(
      'migrations',
      'docker',
      [...composeArgs, 'run', '--rm', '--no-deps', 'migrate'],
      composeEnv,
      { timeout: 180_000 },
    );
    const bootstrap = await readFile(join(REPO, 'infra/db/bootstrap.sql'), 'utf8');
    const passwords = ['genie_app', 'astra_identity', 'astra_share', 'astra_migrate']
      .map((role) => `ALTER ROLE ${role} PASSWORD '${config.appPassword}';`)
      .join('\n');
    await processes.run(
      'database',
      'docker',
      [
        ...composeArgs,
        'exec',
        '-T',
        'postgres',
        'psql',
        '-U',
        'astra',
        '-d',
        'genie_preview',
        '-v',
        'ON_ERROR_STOP=1',
        '-X',
        '-q',
      ],
      composeEnv,
      { input: bootstrap + '\n' + passwords, timeout: 30_000 },
    );
    const runtimeEnv = serviceEnvironment(config, stateDir, REPO);
    if (options.computerUse) {
      runtimeEnv.ASTRA_COMPUTER_USE = 'on';
      runtimeEnv.ASTRA_COMPUTER_HELPER = computerHelper;
    }
    if (process.platform !== 'darwin')
      runtimeEnv.ASTRA_SECRET_STORE_FILE = join(stateDir, 'host-secrets.json');
    const runService = async (name, entry, extra = {}) =>
      processes.spawn(
        name,
        process.execPath,
        [join(REPO, 'scripts/local-preview/child.mjs'), join(REPO, entry)],
        { ...runtimeEnv, ...extra },
        { service: true },
      );
    stage('services', 'Genieの実行サービスを起動しています…');
    await runService('worker', 'workers/task-worker/dist/worker-main.js');
    await runService('gateway', 'services/api-gateway/dist/server.js');
    await waitFor(
      async () => {
        const ready = await jsonRequest(base + '/readyz');
        return ready.status === 'ok';
      },
      {
        signal: abort.signal,
        message: '接続サービスを起動できません。gateway.logとworker.logを確認してください。',
      },
    );
    await waitFor(
      async () =>
        (await probe(
          process.execPath,
          [join(REPO, 'scripts/local-preview/check-worker.mjs')],
          runtimeEnv,
        )) !== null,
      {
        signal: abort.signal,
        message: '仕事を処理するサービスの準備が完了しません。worker.logを確認してください。',
      },
    );
    const credentials = await jsonRequest(base + '/v1/auth/dev/token', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        email: desktopEmail(config.identity),
        display_name: 'Genie local preview',
      }),
    });
    if (!credentials.access_token || !credentials.refresh_token)
      throw new Error('ローカル認証の応答を確認できません。');
    const auth = {
      authorization: `Bearer ${credentials.access_token}`,
      'content-type': 'application/json',
    };
    await jsonRequest(base + '/v1/plugins/com.astra.general/install', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({
        version: '0.1.0',
        granted_scopes: ['artifacts.read', 'artifacts.write'],
      }),
    });
    await runService('host', 'workers/agent-host/dist/main.js', {
      ASTRA_HOST_TOKEN: credentials.access_token,
      ASTRA_HOST_REFRESH_TOKEN: credentials.refresh_token,
    });
    await waitFor(
      async () => {
        const hosts = await jsonRequest(base + '/v1/agent-hosts', { headers: auth });
        return hosts.items?.some(
          (host) =>
            (host.device_label ?? host.deviceLabel) === config.project &&
            host.models?.includes('local') &&
            Date.now() - Date.parse(host.last_seen_at ?? host.lastSeenAt) < 30_000,
        );
      },
      {
        signal: abort.signal,
        message: 'モデル実行ホストの登録を確認できません。host.logを確認してください。',
      },
    );
    const appData = join(stateDir, 'app');
    await mkdir(appData, { recursive: true, mode: 0o700 });
    if (options.open) {
      const identityKey = `astra.dev.identity.${base}.data-root.${appData}`;
      await processes.run(
        'app-identity',
        '/usr/bin/defaults',
        ['write', appBundleID, identityKey, '-string', config.identity],
        env,
        { timeout: 8000 },
      );
      // Existing .main launch mode opens the real Home; it injects no sample data.
      await processes.spawn('app', appExecutable, ['--demo', 'main'], {
        ...env,
        ASTRA_GATEWAY_URL: base,
        ASTRA_DATA_ROOT: appData,
      });
    }
    stage(
      'ready',
      `準備できました。${config.model}で依頼できます。\n保存先: ${stateDir}\nCtrl+Cでサービスを停止します。結果と設定は次回も使えます。`,
    );
    console.log('GENIE_PREVIEW_READY ' + JSON.stringify(status()));
    let healthFailures = 0;
    while (!abort.signal.aborted) {
      await new Promise((accept) => {
        const done = () => {
          clearTimeout(timer);
          abort.signal.removeEventListener('abort', done);
          accept();
        };
        const timer = setTimeout(done, 10_000);
        abort.signal.addEventListener('abort', done, { once: true });
      });
      if (abort.signal.aborted) break;
      try {
        const ready = await jsonRequest(base + '/readyz');
        if (ready.status !== 'ok') throw new Error();
        healthFailures = 0;
      } catch {
        if (++healthFailures >= 3)
          fail(
            new Error(
              '保存サービスとの接続が失われました。Dockerの状態を確認して再実行してください。',
            ),
          );
      }
    }
  } catch (error) {
    if (!stopping) failure ??= error;
  } finally {
    phase = 'stopping';
    await processes?.stop();
    if (containersTouched) {
      console.log('この起動で管理したサービスを停止しています。保存データは保持します…');
      try {
        await exec('docker', [...composeArgs, 'stop', '-t', '10'], {
          env: composeEnv,
          cwd: stateDir,
          timeout: 45_000,
          maxBuffer: 65536,
        });
      } catch {
        failure ??= new Error(
          'コンテナの停止を確認できませんでした。Docker Desktopで、この保存先のgenie-previewプロジェクトを確認してください。',
        );
      }
    }
    server.closeAllConnections();
    await new Promise((accept) => server.close(accept));
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
    phase = failure ? 'failed' : 'stopped';
  }
  if (failure) throw failure;
  console.log('停止しました。次回も同じ起動コマンドで再開できます。');
}

export async function main(args = process.argv.slice(2)) {
  const options = parseOptions([...args]);
  if (options.help) {
    console.log(HELP);
    return;
  }
  if (options.command !== 'start') return control(options);
  return start(options);
}

if (
  process.argv[1] &&
  (await realpath(process.argv[1]).catch(() => '')) ===
    (await realpath(fileURLToPath(import.meta.url)))
) {
  main().catch((error) => {
    console.error(`Genie: ${error.message}\n起動案内: node scripts/start-local-preview.mjs --help`);
    process.exitCode = 1;
  });
}
