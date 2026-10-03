#!/usr/bin/env node
/** One owner for setup, the three local services, readiness and clean shutdown. */
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, realpath, access, constants, writeFile } from 'node:fs/promises';
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
  DEFAULT_CODEX_MODEL,
  PNPM_VERSION,
  systemEnvironment,
  dockerEnvironment,
  lockPort,
  loadConfig,
  validateConfig,
  privateJSON,
  availablePort,
  composeConfig,
  serviceEnvironment,
  selectModel,
  modelConfiguration,
  modelAppEnvironment,
  assertLocalModel,
  externalScreenAllowed,
  isExternalProvider,
  modelRecipient,
  selectedModel,
  GEMINI_KEYCHAIN_SERVICE,
  saveDesktopConnection,
  invalidateDesktopConnection,
} from './local-preview/config.mjs';
import { OwnedProcesses, waitFor, jsonRequest } from './local-preview/processes.mjs';

const exec = promisify(execFile);
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const HELP = `Genie ローカル起動

  node scripts/start-local-preview.mjs --model qwen3.5:9b
  node scripts/start-local-preview.mjs status
  node scripts/start-local-preview.mjs stop

必要: Node 22以降・Docker・Genie.app と、次のどれか: Ollamaの導入済みモデル / サインイン済みCodex CLI /
      サインイン済みClaude Code / Keychainに登録したGemini APIキー。
初回は固定版pnpm・依存パッケージ・コンテナイメージを取得し、専用DBを作ります。
DB設定・マイグレーション・3サービスの起動をまとめて行います。
準備完了後もこのターミナルは開いたまま使います。Ctrl+Cで停止、保存データは保持。
有料APIへの切替・モデル取得・AIへの依頼・外部サービスの同期は自動で行いません。

  --model <名前>       選んだ提供元のモデル名。ローカルは導入済みの名前
  --model-provider <local|codex|claude_code|gemini_api>  既定 local。local 以外は外部モデル接続
                      codex / claude_code はサインイン済みのCLIを使います（資格情報は読みません）
                      gemini_api はKeychainのキーを使います。未登録なら登録コマンドを案内します
  --allow-cloud        外部モデルへの送信を明示許可。専用保存先の選択として保持
  --allow-external-screen  画面操作の画像送信を別途許可。--computer-use と Codex 接続が必要
  --no-external-screen  保存した画面画像の送信許可を解除（会話の接続設定は保持）
  --model-url <URL>    ローカルHTTPモデル（既定 http://127.0.0.1:11434/v1）
  --app <Genie.app>    開くMacアプリ（既定 /Applications/Genie.app）
  --state-dir <path>  専用の保存先（既定 ${DEFAULT_STATE}）
  --port <port>       初回作成時のGatewayポート（既定 ${DEFAULT_PORT}）
  --docker-context <名前>  ローカルunixソケットのcontext。専用保存先に記録し、毎回検証
  --no-open           アプリを開かず起動（Linuxの統合検証でも使用）
  --computer-use      Macの画面操作を有効化。タスク承認と開始時の同意が必要
  --transaction-simulation  架空の注文だけを検証。--computer-use 必須、実サービスへ発注しません
  --computer-helper <path>  画面操作ヘルパーの道。既定はこのリポジトリが建てた本番版。
                      反復試験用のビルドを指すためのもので、指したものが同意を省く
                      ビルドなら起動時の記録に unattendedTest として出ます
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

/** Probe only the supervisor's selected executable. No caller supplies a path. */
export async function readComputerHelperStatus(path, env, run = exec) {
  if (!path) return { path: null, status: null, error: 'helper_not_configured' };
  try {
    const { stdout } = await run(path, ['--status'], {
      env,
      cwd: REPO,
      timeout: 8000,
      maxBuffer: 65536,
    });
    const value = JSON.parse(stdout);
    const flags = ['accessibility', 'screenRecording', 'supported', 'ready', 'unattendedTest'];
    if (
      !value ||
      typeof value !== 'object' ||
      flags.some((key) => typeof value[key] !== 'boolean') ||
      !['background', 'foreground'].includes(value.deliveryMode) ||
      !Array.isArray(value.capabilities) ||
      value.capabilities.length > 128 ||
      value.capabilities.some(
        (item) => typeof item !== 'string' || !/^[a-z][a-z0-9_]{0,63}$/.test(item),
      ) ||
      (value.ready && (!value.accessibility || !value.screenRecording || !value.supported))
    )
      return { path, status: null, error: 'invalid_helper_status' };
    return {
      path,
      status: {
        ...Object.fromEntries(flags.map((key) => [key, value[key]])),
        deliveryMode: value.deliveryMode,
        capabilities: [...new Set(value.capabilities)],
      },
      error: null,
    };
  } catch {
    // Do not expose subprocess stderr or any unexpected non-status output.
    return { path, status: null, error: 'helper_status_unavailable' };
  }
}

export async function computerStatusResponse(current, helperPath, env, run = exec) {
  const computerHelper = current.computerUse
    ? await readComputerHelperStatus(helperPath, env, run)
    : { path: null, status: null, error: 'computer_use_disabled' };
  return {
    ...current,
    computerHelper,
    computerHelperUnattendedTest: computerHelper.status?.unattendedTest ?? null,
    probedAt: new Date().toISOString(),
  };
}

export async function resolveCodexExecutable(env) {
  const directories = (env.PATH ?? '').split(':').filter((entry) => entry.startsWith('/'));
  directories.push(
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/Applications/Codex.app/Contents/Resources',
    '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS',
  );
  for (const directory of directories) {
    const candidate = join(directory, 'codex');
    try {
      await access(candidate, constants.X_OK);
      return await realpath(candidate);
    } catch {
      /* Try only known executable locations, never a shell. */
    }
  }
  throw new Error('Codex CLI が見つかりません。Codex を設定して再実行してください。');
}

export async function verifyCodexConnection(env, run = exec, command = 'codex') {
  try {
    await run(command, ['--version'], { env, timeout: 8000, maxBuffer: 65536 });
    await run(command, ['login', 'status'], { env, timeout: 8000, maxBuffer: 65536 });
  } catch {
    throw new Error(
      'Codex CLIへのサインインを確認できません。既存のCodexでサインインを確認してください。ローカルモデルへ自動で切り替えません。',
    );
  }
}

export async function resolveClaudeExecutable(env) {
  const directories = (env.PATH ?? '').split(':').filter((entry) => entry.startsWith('/'));
  if (env.HOME?.startsWith('/')) directories.push(join(env.HOME, '.local/bin'));
  directories.push('/opt/homebrew/bin', '/usr/local/bin');
  for (const directory of directories) {
    const candidate = join(directory, 'claude');
    try {
      await access(candidate, constants.X_OK);
      return await realpath(candidate);
    } catch {
      /* Try only known executable locations, never a shell. */
    }
  }
  throw new Error('Claude Code が見つかりません。Claude Code を設定して再実行してください。');
}

export async function verifyClaudeConnection(env, run = exec, command = 'claude') {
  try {
    await run(command, ['--version'], { env, timeout: 8000, maxBuffer: 65536 });
    // The CLI reports its own sign-in state; its credential store is never read here.
    await run(command, ['auth', 'status'], { env, timeout: 8000, maxBuffer: 65536 });
  } catch {
    throw new Error(
      'Claude Codeへのサインインを確認できません。claude auth login でサインインを確認してください。ローカルモデルへ自動で切り替えません。',
    );
  }
}

/**
 * Gemini のキーが、ホストが読む場所にあるか。**在るかどうかだけ見る。値は読まない。**
 * `-w` を付けない検索は属性だけを返し、Keychain の確認ダイアログも出さない。
 */
export async function verifyGeminiKey(env, project, run = exec) {
  try {
    await run(
      '/usr/bin/security',
      ['find-generic-password', '-a', project, '-s', GEMINI_KEYCHAIN_SERVICE],
      { env, timeout: 8000, maxBuffer: 65536 },
    );
  } catch {
    throw new Error(
      `Gemini APIキーがKeychainにありません。次のコマンドで登録して再実行してください（キーは入力待ちで貼り付けます。コマンドの引数に書きません）:\n  security add-generic-password -a ${project} -s ${GEMINI_KEYCHAIN_SERVICE} -w\nローカルモデルへ自動で切り替えません。`,
    );
  }
}

export function readyMessage(config, stateDir) {
  const model = selectedModel(config) ?? DEFAULT_CODEX_MODEL;
  return `準備できました。${model}で依頼できます。\n保存先: ${stateDir}\nCtrl+Cでサービスを停止します。結果と設定は次回も使えます。`;
}

export async function verifyLocalOllamaModel(config, request = jsonRequest) {
  assertLocalModel(config.model);
  const url = new URL(config.modelURL);
  if (url.port !== '11434' || url.pathname.replace(/\/$/, '') !== '/v1') return;
  // A renamed Ollama cloud alias need not contain "cloud". Inspect the server's
  // actual selected-model metadata instead of treating loopback as proof of locality.
  const metadata = await request(`${url.origin}/api/show`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: config.model }),
  });
  assertLocalModel(config.model, metadata);
  if (!metadata.model_info || !Object.keys(metadata.model_info).length)
    throw new Error(
      '選んだOllamaモデルが端末内で動くことを確認できません。外部接続を明示して起動してください。',
    );
}

export async function transactionSimulationEnvironment(options, repo = REPO) {
  if (!options.transactionSimulation) return {};
  if (!options.computerUse)
    throw new Error('--transaction-simulation には --computer-use が必要です。');
  const app = join(
    repo,
    '.build/computer/GenieCheckoutSimulation.app/Contents/MacOS/GenieCheckoutSimulation',
  );
  await access(app, constants.X_OK);
  return { ASTRA_TRANSACTION_SIMULATION: 'on', ASTRA_TRANSACTION_SIMULATION_APP: app };
}

export function macAppLaunchArgs(app, appEnv, logs, instance) {
  return [
    '-n',
    '-W',
    '-a',
    app,
    '-o',
    join(logs, 'app-stdout.log'),
    '--stderr',
    join(logs, 'app-stderr.log'),
    ...Object.entries(appEnv).flatMap(([key, value]) => ['--env', `${key}=${value}`]),
    '--args',
    '--demo',
    'main',
    '--preview-instance',
    instance,
  ];
}

export async function readNativeProcessIdentity(pid, env, run = exec) {
  let output;
  try {
    // One snapshot prevents combining argv, start time and exit state from different processes.
    output = await run(
      '/bin/ps',
      ['-ww', '-p', String(pid), '-o', 'lstart=', '-o', 'stat=', '-o', 'command='],
      { env: { ...env, LC_ALL: 'C' }, timeout: 2000, maxBuffer: 65536 },
    );
  } catch (error) {
    if (error.code === 1 && error.stdout?.trim() === '' && error.stderr?.trim() === '') return null;
    throw new Error('専用アプリの個体を確認できません。停止は未確認です。');
  }
  const match = output.stdout
    .trim()
    .match(/^([A-Za-z]{3} [A-Za-z]{3} [ \d]\d \d{2}:\d{2}:\d{2} \d{4})\s+(\S+)\s+(\S.*)$/);
  if (!match) throw new Error('専用アプリの個体を確認できません。停止は未確認です。');
  return { pid, started: match[1], state: match[2], command: match[3] };
}

function nativeExitState(identity) {
  if (identity.state?.startsWith('Z')) return 'gone';
  // macOS ps: E is an additional "trying to exit" flag, not proof of exit.
  if (identity.state?.slice(1).includes('E')) return 'exiting';
  return 'running';
}

export async function nativeAppIdentity(
  pid,
  executable,
  instance,
  env,
  inspect = readNativeProcessIdentity,
) {
  const current = await inspect(pid, env);
  return current?.command === `${executable} --demo main --preview-instance ${instance}` &&
    nativeExitState(current) === 'running'
    ? current
    : null;
}

export async function stopOwnedNativeApp(
  identity,
  env,
  {
    inspect = readNativeProcessIdentity,
    sendSignal = (pid, signal) => process.kill(pid, signal),
    graceMs = 10_000,
    killWaitMs = 2000,
    intervalMs = 100,
    now = () => performance.now(),
    sleep = (ms) => new Promise((accept) => setTimeout(accept, ms)),
  } = {},
) {
  if (
    !Number.isSafeInteger(identity?.pid) ||
    identity.pid <= 0 ||
    !identity.started ||
    !identity.command
  )
    throw new Error('専用アプリの所有情報がありません。停止は未確認です。');
  const state = async () => {
    const current = await inspect(identity.pid, env);
    if (current === null) return 'gone';
    if (current.pid !== identity.pid || current.started !== identity.started)
      throw new Error('専用アプリの個体が変わりました。別のプロセスは停止していません。');
    const lifecycle = nativeExitState(current);
    // Exit may discard argv before the process table entry disappears. Never
    // signal such an entry; still wait for proven death or disappearance.
    if (lifecycle !== 'running') return lifecycle;
    if (current.command !== identity.command)
      throw new Error('専用アプリの個体が変わりました。別のプロセスは停止していません。');
    return 'running';
  };
  const send = async (signal) => {
    const lifecycle = await state();
    if (lifecycle !== 'running') return lifecycle;
    try {
      sendSignal(identity.pid, signal);
    } catch (error) {
      if (error.code !== 'ESRCH')
        throw new Error('専用アプリへ停止を送れませんでした。停止は未確認です。');
      // A signal's ESRCH is not itself an exit acknowledgement; inspect again.
      if ((await state()) !== 'gone') throw new Error('専用アプリの終了を確認できませんでした。');
    }
    return 'sent';
  };
  const waitForExit = async (timeout) => {
    const until = now() + timeout;
    do {
      if ((await state()) === 'gone') return true;
      const remaining = until - now();
      if (remaining <= 0) return false;
      await sleep(Math.min(intervalMs, remaining));
    } while (true);
  };
  if ((await send('SIGTERM')) === 'gone' || (await waitForExit(graceMs))) return { forced: false };
  // Recheck all identity fields immediately before escalation, never signal a group.
  const escalation = await send('SIGKILL');
  if (escalation === 'gone') return { forced: false };
  if (!(await waitForExit(killWaitMs)))
    throw new Error('専用アプリの終了を確認できませんでした。停止は未確認です。');
  return { forced: escalation === 'sent' };
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

export async function monitorNativeAppExit(done, { state, stop, fail }) {
  const code = await done;
  const { confirmed, stopping, aborted } = state();
  if (stopping || aborted) return;
  // A successful waited LaunchServices exit is normal only after this instance
  // was observed. An early open failure must not look like a successful session.
  if (code === 0 && confirmed) {
    stop();
    return;
  }
  fail(
    new Error(
      `Genieアプリが終了しました（exit ${code}）。app-launcher.logとapp-stderr.logを確認して再起動してください。`,
    ),
  );
}

export async function start(options) {
  if (Number(process.versions.node.split('.')[0]) < 22)
    throw new Error('Node 22以降をインストールしてから実行してください。');
  if (process.platform !== 'darwin' && options.open)
    throw new Error('アプリの起動はmacOS専用です。サービス検証には --no-open を指定してください。');
  await mkdir(options.stateDir, { recursive: true, mode: 0o700 });
  const stateDir = await realpath(options.stateDir);
  let env = systemEnvironment();
  const abort = new AbortController();
  const appInstance = randomUUID();
  let config,
    processes,
    appProcess,
    appExecutable,
    codexExecutable,
    claudeExecutable,
    computerHelper,
    appIdentity,
    /*
     * 使ったヘルパーが、同意を省く試験用ビルドだったかどうか。
     * null は「確かめられなかった」で、false（本番）とは別に扱う。
     */
    computerHelperUnattendedTest = null,
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
    modelProvider: config?.modelProvider ?? 'local',
    externalModel: isExternalProvider(config?.modelProvider),
    computerUse: options.computerUse === true,
    transactionSimulation: options.transactionSimulation === true,
    computerDelivery: options.computerUse ? 'background' : null,
    computerHelperUnattendedTest,
    externalScreenAllowed: externalScreenAllowed(config, options.computerUse),
    externalScreenAuthorization: config?.externalScreenAuthorization ?? null,
    recipient: config ? modelRecipient(config) : null,
    appPID: appIdentity?.pid ?? null,
    appRequested: options.open === true,
  });
  const server = createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (!config || req.headers.authorization !== `Bearer ${config.controlToken}`) {
      res.writeHead(403);
      res.end('{}');
      return;
    }
    if (req.url === '/status' && req.method === 'GET') res.end(JSON.stringify(status()));
    else if (req.url === '/computer/status' && req.method === 'GET') {
      void computerStatusResponse(status(), computerHelper, env)
        .then((value) => res.end(JSON.stringify(value)))
        .catch(() => {
          res.writeHead(500);
          res.end(JSON.stringify({ error: 'computer_status_unavailable' }));
        });
    } else if (req.url === '/stop' && req.method === 'POST') {
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
    config = modelConfiguration(await loadConfig(stateDir, options), options);
    const base = `http://127.0.0.1:${config.port}`;
    const app = resolve(options.app ?? '/Applications/Genie.app');
    let appBundleID;
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
      // open -n launches a separately scoped instance while the normal app stays running.
    }
    try {
      await availablePort(config.port);
    } catch {
      throw new Error(
        `ポート${config.port}は既に使用中です。既存サービスは停止していません。別の保存先と --port を指定できます。`,
      );
    }
    const docker = await dockerEnvironment(env, config.dockerContext, probe);
    const contextName = docker.name;
    env = docker.env;
    if (!(await probe('docker', ['compose', 'version'], env)))
      throw new Error(
        'Docker Composeが見つかりません。Docker Desktopをインストールして再実行してください。',
      );
    if (!(await probe('docker', ['info', '--format', '{{.ServerVersion}}'], env))) {
      if (config.dockerContext !== undefined)
        throw new Error(
          `Docker context「${contextName}」のサービスが起動していません。指定したローカル環境を起動して再実行してください。`,
        );
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
    if (config.modelProvider === 'codex') {
      // Probe the CLI's own login status; never read/copy its credential files.
      codexExecutable = await resolveCodexExecutable(env);
      await verifyCodexConnection(env, exec, codexExecutable);
    } else if (config.modelProvider === 'claude_code') {
      claudeExecutable = await resolveClaudeExecutable(env);
      await verifyClaudeConnection(env, exec, claudeExecutable);
    } else if (config.modelProvider === 'gemini_api') {
      await verifyGeminiKey(env, config.project);
    } else {
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
      config.model = assertLocalModel(selectModel(names, selected));
      await verifyLocalOllamaModel(config);
    }
    await invalidateDesktopConnection(config, stateDir);
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
    if (options.computerUse) {
      if (process.platform !== 'darwin')
        throw new Error('--computer-use はmacOSでのみ利用できます。');
      if (!(await probe('swiftc', ['--version'], env)))
        throw new Error(
          '画面操作の準備にSwiftコンパイラが必要です。Xcode Command Line Toolsを導入してください。',
        );
      stage('computer', '画面操作ヘルパーを準備しています…');
      /*
       * 明示された道があればそれを使い、無ければ今までどおり建てる。
       * **指したものが何であるかは、そのヘルパー自身に言わせる**——
       * `--status` の `unattendedTest` をそのまま起動時の記録へ載せるので、
       * 同意を省く試験用ビルドで取った結果を、後から本番と取り違えることがない。
       */
      if (options.computerHelper) {
        computerHelper = options.computerHelper;
        await access(computerHelper, constants.X_OK);
      } else {
        await processes.run(
          'computer-helper',
          'bash',
          [join(REPO, 'scripts/build-computer-helper.sh')],
          env,
          {
            timeout: 120_000,
          },
        );
        computerHelper = join(REPO, '.build/computer/genie-computer-background');
        await access(computerHelper, constants.X_OK);
      }
      // `--status` は読み取りだけで、撮影も入力も OS への許可要求も行わない。
      computerHelper = await realpath(computerHelper);
      const reported = await readComputerHelperStatus(computerHelper, env);
      computerHelperUnattendedTest = reported.status?.unattendedTest ?? null;
    }
    if (options.transactionSimulation) {
      stage('simulation', '架空注文の検証画面を準備しています…');
      await processes.run(
        'checkout-simulation',
        'bash',
        [join(REPO, 'scripts/build-checkout-simulation.sh')],
        env,
        { timeout: 120_000 },
      );
    }
    const simulationHostEnv = await transactionSimulationEnvironment(options);
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
    const runtimeEnv = serviceEnvironment(config, stateDir, REPO, process.env, options);
    if (codexExecutable) runtimeEnv.ASTRA_CODEX_PATH = codexExecutable;
    if (claudeExecutable) runtimeEnv.ASTRA_CLAUDE_CODE_PATH = claudeExecutable;
    if (options.computerUse) {
      runtimeEnv.ASTRA_COMPUTER_USE = 'on';
      runtimeEnv.ASTRA_COMPUTER_VISION_HELPER = computerHelper;
      // 画面操作が止まった理由（helper の STAGE 行: どの段で何に阻まれたか）を host.log に残す。
      // 行に画面の中身も入力した文字も入らない（helper 側の約束）。以前は環境を引き継がないので、
      // 止まっても「target_changed」しか分からなかった（2026-09-28）。
      runtimeEnv.ASTRA_COMPUTER_STAGE_LOG = process.env.ASTRA_COMPUTER_STAGE_LOG ?? 'on';
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
      ...simulationHostEnv,
      ASTRA_HOST_TOKEN: credentials.access_token,
      ASTRA_HOST_REFRESH_TOKEN: credentials.refresh_token,
    });
    await waitFor(
      async () => {
        const hosts = await jsonRequest(base + '/v1/agent-hosts', { headers: auth });
        return hosts.items?.some(
          (host) =>
            (host.device_label ?? host.deviceLabel) === config.project &&
            host.models?.includes(config.modelProvider ?? 'local') &&
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
      const appEnv = {
        ASTRA_GATEWAY_URL: base,
        ASTRA_DATA_ROOT: appData,
        ASTRA_DESKTOP_IDENTITY: config.identity,
        ...modelAppEnvironment(config),
        ...(codexExecutable ? { ASTRA_CODEX_PATH: codexExecutable } : {}),
      };
      for (const name of ['app-stdout.log', 'app-stderr.log'])
        await writeFile(join(logs, name), '', { flag: 'a', mode: 0o600 });
      // LaunchServices must own the signed app, so TCC sees its usage descriptions.
      // --env applies only to this instance, never to launchd or the user's app defaults.
      appProcess = await processes.spawn(
        'app-launcher',
        '/usr/bin/open',
        macAppLaunchArgs(app, appEnv, logs, appInstance),
        env,
      );
      void monitorNativeAppExit(appProcess.done, {
        state: () => ({ confirmed: Boolean(appIdentity), stopping, aborted: abort.signal.aborted }),
        stop,
        fail,
      });
      const escapedExecutable = appExecutable.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      await waitFor(
        async () => {
          const matches = await probe(
            '/usr/bin/pgrep',
            ['-f', `^${escapedExecutable} --demo main --preview-instance ${appInstance}$`],
            env,
          );
          if (!matches || !/^\d+$/.test(matches)) return false;
          appIdentity = await nativeAppIdentity(Number(matches), appExecutable, appInstance, env);
          return appIdentity !== null;
        },
        {
          signal: abort.signal,
          timeout: 15_000,
          interval: 100,
          message:
            '専用のGenieアプリの起動を確認できません。app-launcher.logとapp-stderr.logを確認してください。',
        },
      );
    }
    await saveDesktopConnection(config, stateDir, { ready: true });
    stage('ready', readyMessage(config, stateDir));
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
    // LaunchServices reparents the app to launchd; killing the open(1) process
    // group does not stop it. Await termination of the exact owned identity.
    if (appIdentity) {
      try {
        const result = await stopOwnedNativeApp(appIdentity, env);
        if (result.forced)
          console.warn(
            '専用アプリが10秒以内に正常終了しなかったため、個体を再確認して強制終了しました。',
          );
      } catch (error) {
        failure ??= error;
      }
    }
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
