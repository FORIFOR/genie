import { createHash, generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import {
  mkdir,
  readFile,
  open,
  rename,
  rm,
  readdir,
  chmod,
  realpath,
  lstat,
} from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve, join } from 'node:path';
import { createServer } from 'node:net';
import { constants } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { localEndpoint } from '../doctor-local-preview.mjs';

export const PNPM_VERSION = '10.12.2';
export const DEFAULT_PORT = 43123;
export const DEFAULT_STATE = join(homedir(), 'Library/Application Support/Genie/local-preview');
export const DEFAULT_CODEX_MODEL = 'gpt-6-sol';
export const DEFAULT_CLAUDE_CODE_MODEL = 'claude-sonnet-5-5';
export const DEFAULT_GEMINI_MODEL = 'gemini-2.5-flash';
/** Gemini's OpenAI-compatible endpoint. Fixed here: an external destination is never a free-form option. */
export const GEMINI_API_URL = 'https://generativelanguage.googleapis.com/v1beta/openai';
/** The host reads the key from this Keychain service (account = the preview project). */
export const GEMINI_KEYCHAIN_SERVICE = 'com.astra.connector.llm.gemini_api';

/**
 * 外部の提供元。名前はホストが名乗るモデルの種別（`LANGUAGE_MODEL_KINDS`）と同じにする。
 * 起動後の確認は、ホストの名乗りとこの名前を突き合わせる。
 */
const EXTERNAL_PROVIDERS = {
  codex: { defaultModel: DEFAULT_CODEX_MODEL, recipient: 'OpenAI', via: 'Codex接続' },
  claude_code: {
    defaultModel: DEFAULT_CLAUDE_CODE_MODEL,
    recipient: 'Anthropic',
    via: 'Claude Code接続',
  },
  gemini_api: { defaultModel: DEFAULT_GEMINI_MODEL, recipient: 'Google', via: 'Gemini API' },
};
export const MODEL_PROVIDERS = ['local', ...Object.keys(EXTERNAL_PROVIDERS)];

export function isExternalProvider(provider) {
  return Object.hasOwn(EXTERNAL_PROVIDERS, provider);
}

/** The model actually used: the saved choice, or the provider's default. */
export function selectedModel(config) {
  return config?.model ?? EXTERNAL_PROVIDERS[config?.modelProvider]?.defaultModel ?? null;
}

/** Who receives the request, in the words shown to the person. */
export function modelRecipient(config) {
  const external = EXTERNAL_PROVIDERS[config?.modelProvider];
  return external
    ? `${external.recipient} / ${external.via} (${selectedModel(config)})`
    : `このMac (${config?.model ?? '未選択'})`;
}

export function parseOptions(args) {
  const result = { command: 'start', stateDir: DEFAULT_STATE, open: true };
  if (args[0] && !args[0].startsWith('-')) result.command = args.shift();
  if (!['start', 'status', 'stop'].includes(result.command))
    throw new Error('start / status / stop を指定してください。');
  const fields = {
    '--state-dir': 'stateDir',
    '--port': 'port',
    '--model': 'model',
    '--model-provider': 'modelProvider',
    '--model-url': 'modelURL',
    '--app': 'app',
    '--docker-context': 'dockerContext',
    /*
     * 画面操作ヘルパーの道。**既定は今までどおりリポジトリが建てた本番の実行ファイル。**
     * 明示したときだけ別のものを使う。試験用のビルドを指すためにあり、
     * どちらを使ったかは起動時の記録（`unattendedTest`）に残る。
     */
    '--computer-helper': 'computerHelper',
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--help' || arg === '-h') result.help = true;
    else if (arg === '--no-open') result.open = false;
    else if (arg === '--computer-use') result.computerUse = true;
    else if (arg === '--allow-cloud') result.allowCloud = true;
    else if (arg === '--allow-external-screen') result.allowExternalScreen = true;
    else if (arg === '--no-external-screen') result.allowExternalScreen = false;
    else if (arg === '--transaction-simulation') result.transactionSimulation = true;
    else if (fields[arg] && args[i + 1] && !args[i + 1].startsWith('--'))
      result[fields[arg]] = args[++i];
    else throw new Error('不明なオプションです。--help で起動方法を確認してください。');
  }
  result.stateDir = resolve(result.stateDir);
  if (result.computerHelper !== undefined) result.computerHelper = resolve(result.computerHelper);
  if (result.port !== undefined) result.port = portNumber(result.port);
  if (result.model !== undefined) validateModel(result.model);
  if (result.modelProvider !== undefined) validateModelProvider(result.modelProvider);
  if (isExternalProvider(result.modelProvider) && result.modelURL !== undefined)
    throw new Error('外部モデルの接続では --model-url を指定しません。');
  if (result.modelURL !== undefined) result.modelURL = localEndpoint(result.modelURL);
  if (result.dockerContext !== undefined) validateDockerContextName(result.dockerContext);
  if (result.transactionSimulation && !result.computerUse)
    throw new Error('--transaction-simulation には --computer-use が必要です。');
  if (result.allowExternalScreen === true && !result.computerUse)
    throw new Error('--allow-external-screen には --computer-use が必要です。');
  return result;
}

export function validateDockerContextName(name) {
  if (typeof name !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(name))
    throw new Error('Docker context名を確認してください。');
  return name;
}

/** Resolve and revalidate on every start, before any daemon or Compose operation. */
export async function dockerEnvironment(env, requested, probe) {
  const name = requested ?? (await probe('docker', ['context', 'show'], env));
  validateDockerContextName(name);
  const endpoint = await probe(
    'docker',
    ['context', 'inspect', name, '--format', '{{.Endpoints.docker.Host}}'],
    env,
  );
  if (typeof endpoint !== 'string' || !/^unix:\/\/\/[^/\s?#\u0000][^\s?#\u0000]*$/.test(endpoint))
    throw new Error('Docker contextは絶対パスのローカルunixソケットである必要があります。');
  // Pin only child processes. Do not change the user's selected context or inherit DOCKER_HOST.
  return { name, env: { ...env, DOCKER_CONTEXT: name } };
}

export function portNumber(value) {
  if (!/^\d+$/.test(String(value)) || Number(value) < 1024 || Number(value) > 65535)
    throw new Error('ポートは1024〜65535の整数で指定してください。');
  return Number(value);
}

export function validateModel(value) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,159}$/.test(value))
    throw new Error('モデル名を確認してください。ollama list に表示される名前を指定できます。');
  return value;
}

export function validateModelProvider(value) {
  if (!MODEL_PROVIDERS.includes(value))
    throw new Error(
      '--model-provider は local / codex / claude_code / gemini_api のいずれかを指定してください。',
    );
  return value;
}

/** Opt in once per selected external provider; preserve that explicit choice across restart. */
export function modelConfiguration(config, options = {}) {
  const previous = validateModelProvider(config.modelProvider ?? 'local');
  const provider = validateModelProvider(options.modelProvider ?? previous);
  if (isExternalProvider(provider) && options.modelURL !== undefined)
    throw new Error('外部モデルの接続では --model-url を指定しません。');
  if (
    provider !== 'local' &&
    options.allowCloud !== true &&
    !(previous === provider && config.allowCloud === true)
  )
    throw new Error(
      `外部モデルへ送信するには --model-provider ${provider} --allow-cloud を指定してください。`,
    );
  const model =
    options.model ??
    (provider === previous ? config.model : null) ??
    EXTERNAL_PROVIDERS[provider]?.defaultModel ??
    null;
  if (model) validateModel(model);
  if (options.allowExternalScreen === true && (!options.computerUse || provider !== 'codex'))
    throw new Error('--allow-external-screen は --computer-use と Codex 接続でのみ指定できます。');
  // A conversation opt-in never authorizes automatic screenshot capture/egress.
  // Persist only an explicit screen choice for this exact provider and model.
  const externalScreenAuthorization =
    options.allowExternalScreen === true
      ? { provider, model }
      : options.allowExternalScreen !== false &&
          provider === 'codex' &&
          config.externalScreenAuthorization?.provider === provider &&
          config.externalScreenAuthorization?.model === model
        ? { provider, model }
        : null;
  return {
    ...config,
    modelProvider: provider,
    allowCloud: provider !== 'local',
    model,
    externalScreenAuthorization,
    ...(options.modelURL !== undefined ? { modelURL: localEndpoint(options.modelURL) } : {}),
  };
}

/** A loopback transport does not make a cloud model local. Never silently relabel it. */
export function assertLocalModel(model, metadata = {}) {
  if (/(?:^|[:/_-])cloud(?:$|[:/_-])/i.test(model) || metadata.remote_host || metadata.remote_model)
    throw new Error(
      'Ollamaのクラウドモデルをローカルとして起動できません。外部接続には --model-provider codex --allow-cloud を指定してください。',
    );
  return model;
}

export function modelEnvironment(config) {
  const provider = validateModelProvider(config.modelProvider ?? 'local');
  if (isExternalProvider(provider)) {
    if (config.allowCloud !== true) throw new Error('外部モデルの送信許可がありません。');
    const model = validateModel(selectedModel(config));
    if (provider === 'codex') return { ASTRA_LLM_CLI: 'codex', ASTRA_CODEX_MODEL: model };
    if (provider === 'claude_code')
      return { ASTRA_LLM_CLI: 'claude_code', ASTRA_CLAUDE_CODE_MODEL: model };
    // The key stays in the Keychain; the host reads it. Never place it in this environment.
    return {
      ASTRA_LLM_CLI: 'gemini_api',
      ASTRA_GEMINI_API_URL: GEMINI_API_URL,
      ASTRA_GEMINI_MODEL: model,
    };
  }
  if (config.model) assertLocalModel(config.model);
  return {
    ASTRA_LLM_CLI: 'local',
    ASTRA_LOCAL_LLM_URL: config.modelURL,
    ASTRA_LOCAL_LLM_MODEL: config.model,
    ASTRA_LOCAL_LLM_REASONING_EFFORT: 'none',
  };
}

export function externalScreenAllowed(config, computerUse = false) {
  return (
    computerUse === true &&
    config?.modelProvider === 'codex' &&
    config.allowCloud === true &&
    config.externalScreenAuthorization?.provider === 'codex' &&
    config.externalScreenAuthorization?.model === (config.model ?? DEFAULT_CODEX_MODEL)
  );
}

export function modelAppEnvironment(config) {
  const provider = config.modelProvider ?? 'local';
  const external = EXTERNAL_PROVIDERS[provider];
  // Also validate the saved permission before rendering an external disclosure.
  const selected = modelEnvironment(config);
  return external
    ? {
        ASTRA_MODEL_DISCLOSURE: `送信先: ${external.recipient} の ${selectedModel(config)}（${external.via}）。依頼した文章や添付画像を外部モデルへ送ります。`,
        ASTRA_LLM_CLI: provider,
        ASTRA_LOCAL_VISION: '0',
        ...(provider === 'codex' ? { ASTRA_CODEX_MODEL: selected.ASTRA_CODEX_MODEL } : {}),
      }
    : {
        ASTRA_MODEL_DISCLOSURE: `送信先: このMacの ${config.model}（${config.modelURL}）。外部モデルへの切替はありません。`,
        ASTRA_LLM_CLI: 'local',
        ASTRA_LOCAL_VISION: '1',
        ASTRA_LOCAL_LLM_URL: selected.ASTRA_LOCAL_LLM_URL,
        ASTRA_LOCAL_LLM_MODEL: selected.ASTRA_LOCAL_LLM_MODEL,
      };
}

/** Non-secret, selected connection only. It never carries credentials or readiness. */
export function desktopConnectionDescriptor(config, stateDir) {
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(config.identity ?? ''))
    throw new Error('通常起動の端末識別子を確認してください。');
  const selected = modelEnvironment(config);
  const provider = selected.ASTRA_LLM_CLI;
  const external = isExternalProvider(provider);
  const name = validateModel(external ? selectedModel(config) : selected.ASTRA_LOCAL_LLM_MODEL);
  return {
    version: 1,
    gatewayURL: `http://127.0.0.1:${portNumber(config.port)}`,
    workspace: join(stateDir, 'app'),
    desktopIdentity: config.identity,
    model: external
      ? { provider, name }
      : { provider, name, url: localEndpoint(selected.ASTRA_LOCAL_LLM_URL) },
    externalAuthorization: external ? { provider, model: name } : null,
  };
}

/** Only a ready standard workspace becomes the direct-launch choice. */
async function checkDesktopDirectory(stateDir) {
  const directory = await lstat(stateDir);
  if (
    !directory.isDirectory() ||
    directory.isSymbolicLink() ||
    directory.uid !== process.getuid() ||
    (directory.mode & 0o7777) !== 0o700 ||
    (await realpath(stateDir)) !== resolve(stateDir)
  )
    throw new Error('通常起動の保存先の所有者・アクセス権を確認してください。');
}

export async function saveDesktopConnection(
  config,
  stateDir,
  { ready = false, standardState = DEFAULT_STATE } = {},
) {
  if (!ready || resolve(stateDir) !== resolve(standardState)) return false;
  await checkDesktopDirectory(stateDir);
  await privateJSON(
    join(stateDir, 'desktop-connection.json'),
    desktopConnectionDescriptor(config, stateDir),
  );
  return true;
}

/** Revoke a stale ready choice before persisting a different selection. Never
 * delete it: absence would revive the old unconfigured local defaults. */
export async function invalidateDesktopConnection(
  config,
  stateDir,
  { standardState = DEFAULT_STATE } = {},
) {
  if (resolve(stateDir) !== resolve(standardState)) return false;
  await checkDesktopDirectory(stateDir);
  const file = join(stateDir, 'desktop-connection.json');
  let old = null,
    handle;
  try {
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const info = await handle.stat();
    if (!info.isFile() || info.uid !== process.getuid() || (info.mode & 0o7777) !== 0o600)
      throw new Error('通常起動の接続設定の所有者・アクセス権を確認してください。');
    const buffer = Buffer.alloc(16_385);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
      if (!bytesRead) break;
      length += bytesRead;
    }
    const after = await handle.stat();
    if (
      length <= 16_384 &&
      length === info.size &&
      info.size === after.size &&
      info.mtimeMs === after.mtimeMs &&
      info.ctimeMs === after.ctimeMs
    ) {
      try {
        old = JSON.parse(buffer.subarray(0, length).toString('utf8'));
      } catch {
        /* keep invalid */
      }
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  } finally {
    await handle?.close();
  }
  if (isDeepStrictEqual(old, desktopConnectionDescriptor(config, stateDir))) return false;
  await privateJSON(file, { version: 1, selectionPending: true });
  return true;
}

export function selectModel(installed, requested) {
  const names = [...new Set(installed.filter((s) => typeof s === 'string'))];
  if (requested) {
    validateModel(requested);
    // Ollama includes :latest in its catalog even when pull used an untagged name.
    const exact =
      names.find((s) => s === requested) ?? names.find((s) => s === `${requested}:latest`);
    if (!exact)
      throw new Error(
        `選択したモデルがありません。先に ollama pull ${requested} を実行してください。自動ダウンロードは行いません。`,
      );
    return validateModel(exact);
  }
  if (names.length === 1) return validateModel(names[0]);
  if (!names.length)
    throw new Error(
      'ローカルモデルがありません。Ollamaで使いたいモデルを導入してから再実行してください。',
    );
  throw new Error(
    `モデルを選んで再実行してください: --model <名前>\n利用可能: ${names.filter((s) => /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,159}$/.test(s)).join(', ')}`,
  );
}

export function systemEnvironment(source = process.env) {
  // Never inherit .env, paid providers, remote Docker contexts, or injected Node flags.
  const allowed = [
    'PATH',
    'HOME',
    'USER',
    'LOGNAME',
    'TMPDIR',
    'TEMP',
    'TMP',
    'LANG',
    'LC_ALL',
    'TERM',
    'SYSTEMROOT',
  ];
  const env = Object.fromEntries(
    allowed.filter((key) => source[key] !== undefined).map((key) => [key, source[key]]),
  );
  return {
    ...env,
    COREPACK_ENABLE_NETWORK: '0',
    COREPACK_ENABLE_AUTO_PIN: '0',
    COREPACK_DEFAULT_TO_LATEST: '0',
    npm_config_manage_package_manager_versions: 'false',
    npm_config_update_notifier: 'false',
    NO_UPDATE_NOTIFIER: '1',
  };
}

export function lockPort(stateDir) {
  return 44000 + (createHash('sha256').update(stateDir).digest().readUInt16BE(0) % 2000);
}

export async function privateJSON(file, value) {
  const temporary = `${file}.${randomBytes(8).toString('hex')}.tmp`;
  try {
    const handle = await open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(JSON.stringify(value, null, 2) + '\n');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function availablePort(port = 0) {
  const server = createServer();
  await new Promise((yes, no) => {
    server.once('error', no);
    server.listen({ host: '127.0.0.1', port, exclusive: true }, yes);
  });
  const chosen = server.address().port;
  await new Promise((yes) => server.close(yes));
  return chosen;
}

export async function loadConfig(stateDir, options = {}) {
  if (options.dockerContext !== undefined) validateDockerContextName(options.dockerContext);
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  const entries = await readdir(stateDir);
  if (entries.length && !entries.includes('runtime.json'))
    throw new Error(
      '保存先には別のファイルがあります。Genie専用の空のフォルダを --state-dir で指定してください。',
    );
  await chmod(stateDir, 0o700);
  const canonical = await realpath(stateDir);
  const file = join(canonical, 'runtime.json');
  let config;
  try {
    config = JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT')
      throw new Error(
        '保存された起動設定を読み取れません。データを削除せず、runtime.json を確認してください。',
      );
  }
  if (entries.includes('runtime.json')) {
    validateConfig(config);
    if (options.port && config.port !== options.port)
      throw new Error(
        'この保存先のポートは固定されています。既存ポートを使うか、別の --state-dir を指定してください。',
      );
    if (options.dockerContext !== undefined) {
      if (config.dockerContext !== undefined && config.dockerContext !== options.dockerContext)
        throw new Error(
          'この保存先のDocker contextは固定されています。別の --state-dir を指定してください。',
        );
      if (config.dockerContext === undefined) {
        config.dockerContext = options.dockerContext;
        await privateJSON(file, config);
      }
    }
    return config;
  }
  const keys = generateKeyPairSync('ed25519', {
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  const ports = new Set([options.port ?? DEFAULT_PORT, lockPort(canonical)]);
  const nextPort = async () => {
    let p;
    do {
      p = await availablePort();
    } while (ports.has(p));
    ports.add(p);
    return p;
  };
  config = {
    version: 1,
    project: `genie-preview-${randomBytes(6).toString('hex')}`,
    port: options.port ?? DEFAULT_PORT,
    postgresPort: await nextPort(),
    redisPort: await nextPort(),
    temporalPort: await nextPort(),
    identity: randomUUID(),
    controlToken: randomBytes(32).toString('hex'),
    adminPassword: randomBytes(24).toString('hex'),
    appPassword: randomBytes(24).toString('hex'),
    privateKey: keys.privateKey,
    publicKey: keys.publicKey,
    model: null,
    modelURL: 'http://127.0.0.1:11434/v1',
    ...(options.dockerContext !== undefined ? { dockerContext: options.dockerContext } : {}),
  };
  await privateJSON(file, config);
  return config;
}

export function validateConfig(config) {
  if (
    !config ||
    typeof config !== 'object' ||
    config.version !== 1 ||
    !/^genie-preview-[a-f0-9]{12}$/.test(config.project) ||
    !/^[a-f0-9-]{36}$/.test(config.identity)
  )
    throw new Error('この起動設定は対応していません。別の保存先へ勝手に切り替えず停止しました。');
  const ports = ['port', 'postgresPort', 'redisPort', 'temporalPort'].map((key) =>
    portNumber(config[key]),
  );
  if (new Set(ports).size !== ports.length) throw new Error('保存されたポートが重複しています。');
  for (const key of ['adminPassword', 'appPassword', 'controlToken'])
    if (!/^[a-f0-9]{48,64}$/.test(config[key])) throw new Error('保存された認証設定が不正です。');
  if (
    !config.privateKey?.startsWith('-----BEGIN PRIVATE KEY-----') ||
    !config.publicKey?.startsWith('-----BEGIN PUBLIC KEY-----')
  )
    throw new Error('保存された署名鍵を読み取れません。');
  localEndpoint(config.modelURL);
  const provider = validateModelProvider(config.modelProvider ?? 'local');
  if (config.allowCloud !== undefined && typeof config.allowCloud !== 'boolean')
    throw new Error('保存された外部モデルの送信許可が不正です。');
  if (provider !== 'local' && config.allowCloud !== true)
    throw new Error('保存された外部モデルには明示的な送信許可が必要です。');
  const screen = config.externalScreenAuthorization;
  if (
    screen != null &&
    (typeof screen !== 'object' ||
      Array.isArray(screen) ||
      Object.keys(screen).sort().join(',') !== 'model,provider' ||
      provider !== 'codex' ||
      screen.provider !== provider ||
      screen.model !== (config.model ?? DEFAULT_CODEX_MODEL))
  )
    throw new Error('保存された画面画像の送信許可が選択中の提供元・モデルと一致しません。');
  if (config.dockerContext !== undefined) validateDockerContextName(config.dockerContext);
  if (config.model) validateModel(config.model);
}

export function composeConfig(config, repo) {
  return {
    services: {
      postgres: {
        image: 'pgvector/pgvector:pg16',
        environment: {
          POSTGRES_USER: 'astra',
          POSTGRES_PASSWORD: '${GENIE_PREVIEW_DB_PASSWORD:?}',
          POSTGRES_DB: 'genie_preview',
        },
        ports: [`127.0.0.1:${config.postgresPort}:5432`],
        volumes: ['postgres:/var/lib/postgresql/data'],
        healthcheck: {
          test: ['CMD-SHELL', 'pg_isready -U astra -d genie_preview'],
          interval: '2s',
          timeout: '3s',
          retries: 60,
        },
      },
      redis: {
        image: 'redis:7-alpine',
        ports: [`127.0.0.1:${config.redisPort}:6379`],
        volumes: ['redis:/data'],
        command: ['redis-server', '--appendonly', 'yes'],
        healthcheck: {
          test: ['CMD', 'redis-cli', 'ping'],
          interval: '2s',
          timeout: '3s',
          retries: 60,
        },
      },
      temporal: {
        image: 'temporalio/auto-setup:1.27.2',
        depends_on: { postgres: { condition: 'service_healthy' } },
        environment: {
          DB: 'postgres12',
          DB_PORT: '5432',
          POSTGRES_USER: 'astra',
          POSTGRES_PWD: '${GENIE_PREVIEW_DB_PASSWORD:?}',
          POSTGRES_SEEDS: 'postgres',
        },
        ports: [`127.0.0.1:${config.temporalPort}:7233`],
        healthcheck: {
          test: ['CMD', 'temporal', '--address', 'temporal:7233', 'operator', 'cluster', 'health'],
          interval: '3s',
          timeout: '5s',
          retries: 60,
        },
      },
      migrate: {
        image: 'ghcr.io/amacneil/dbmate:2.35.1',
        profiles: ['setup'],
        environment: {
          DATABASE_URL:
            'postgres://astra:${GENIE_PREVIEW_DB_PASSWORD:?}@postgres:5432/genie_preview?sslmode=disable',
        },
        volumes: [
          {
            type: 'bind',
            source: join(repo, 'infra/db/migrations'),
            target: '/db/migrations',
            read_only: true,
          },
        ],
        command: ['--no-dump-schema', 'up'],
      },
    },
    volumes: { postgres: {}, redis: {} },
  };
}

export function serviceEnvironment(config, stateDir, repo, source = process.env, options = {}) {
  const env = systemEnvironment(source);
  const database = (role) =>
    `postgres://${role}:${config.appPassword}@127.0.0.1:${config.postgresPort}/genie_preview?sslmode=disable`;
  return {
    ...env,
    ASTRA_ENV: 'development',
    ASTRA_LOG_LEVEL: 'warn',
    ASTRA_API_HOST: '127.0.0.1',
    ASTRA_API_PORT: String(config.port),
    ASTRA_API_URL: `http://127.0.0.1:${config.port}`,
    // Match the native preview app's image handover and keep run journals isolated.
    ASTRA_DATA_ROOT: join(stateDir, 'app'),
    ASTRA_GATEWAY_URL: `http://127.0.0.1:${config.port}`,
    DATABASE_URL: database('genie_app'),
    ASTRA_DB_IDENTITY_URL: database('astra_identity'),
    ASTRA_DB_SHARE_URL: database('astra_share'),
    REDIS_URL: `redis://127.0.0.1:${config.redisPort}`,
    TEMPORAL_ADDRESS: `127.0.0.1:${config.temporalPort}`,
    TEMPORAL_NAMESPACE: 'default',
    ASTRA_TASK_QUEUE: `${config.project}.tasks`,
    ASTRA_JWT_PRIVATE_KEY: config.privateKey,
    ASTRA_JWT_PUBLIC_KEY: config.publicKey,
    ASTRA_JWT_SIGNING_KEY_ID: config.project,
    ASTRA_OBJECT_STORE_ROOT: join(stateDir, 'objects'),
    ASTRA_RECORDING_ROOT: join(stateDir, 'recordings'),
    ASTRA_BUILTIN_PLUGINS_DIR: join(repo, 'plugins/builtin'),
    ...modelEnvironment(config),
    ASTRA_COMPUTER_VISION_EXTERNAL: externalScreenAllowed(config, options.computerUse)
      ? 'on'
      : 'off',
    ASTRA_WORK_SYNC: 'off',
    ASTRA_WORK_SYNC_METERED_LLM: 'off',
    ASTRA_DEVICE_LABEL: config.project,
    ASTRA_DESKTOP_ID: config.identity,
  };
}
