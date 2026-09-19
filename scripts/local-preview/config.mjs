import { createHash, generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, open, rename, rm, readdir, chmod, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve, join } from 'node:path';
import { createServer } from 'node:net';
import { localEndpoint } from '../doctor-local-preview.mjs';

export const PNPM_VERSION = '10.12.2';
export const DEFAULT_PORT = 43123;
export const DEFAULT_STATE = join(homedir(), 'Library/Application Support/Genie/local-preview');

export function parseOptions(args) {
  const result = { command: 'start', stateDir: DEFAULT_STATE, open: true };
  if (args[0] && !args[0].startsWith('-')) result.command = args.shift();
  if (!['start', 'status', 'stop'].includes(result.command))
    throw new Error('start / status / stop を指定してください。');
  const fields = {
    '--state-dir': 'stateDir',
    '--port': 'port',
    '--model': 'model',
    '--model-url': 'modelURL',
    '--app': 'app',
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--help' || arg === '-h') result.help = true;
    else if (arg === '--no-open') result.open = false;
    else if (arg === '--computer-use') result.computerUse = true;
    else if (fields[arg] && args[i + 1] && !args[i + 1].startsWith('--'))
      result[fields[arg]] = args[++i];
    else throw new Error('不明なオプションです。--help で起動方法を確認してください。');
  }
  result.stateDir = resolve(result.stateDir);
  if (result.port !== undefined) result.port = portNumber(result.port);
  if (result.model !== undefined) validateModel(result.model);
  if (result.modelURL !== undefined) result.modelURL = localEndpoint(result.modelURL);
  return result;
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

export function serviceEnvironment(config, stateDir, repo, source = process.env) {
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
    ASTRA_LLM_CLI: 'local',
    ASTRA_LOCAL_LLM_URL: config.modelURL,
    ASTRA_LOCAL_LLM_MODEL: config.model,
    ASTRA_LOCAL_LLM_REASONING_EFFORT: 'none',
    ASTRA_WORK_SYNC: 'off',
    ASTRA_WORK_SYNC_METERED_LLM: 'off',
    ASTRA_DEVICE_LABEL: config.project,
    ASTRA_DESKTOP_ID: config.identity,
  };
}
