/** 結合テスト共通の組み立て。実物と同じ経路（buildApp）を通す。 */
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Writable } from 'node:stream';
import { createDb, type DbConfig, type DbHandle } from '@genie/db';
import { createLogger } from '@genie/telemetry';
import { FsObjectStore, LibraryService } from '@genie/service-library';
import { ConversationService } from '@genie/service-conversation';
import { WorkContextService, WorldModelService } from '@genie/service-world-model';
import { InMemoryTaskRuntime, TaskService } from '@genie/service-task';
import { PluginRegistryService, agentResolver } from '@genie/service-plugin-registry';
import type { DataSourceResolver } from '@genie/service-plugin-registry';
import { ShareService } from '@genie/service-share';
import { ResearchLedgerService } from '@genie/service-research';
// 名前がぶつかる: こちらは手元 step の受け渡し、下の HostBridge は desktop 側の口
import { AgentHostService, HostBridge as HostStepBridge } from '@genie/service-agent-host';
import {
  MeetingService,
  MemoryRecordingStore,
  ScriptedStreamingTranscriber,
  type ScriptLine,
} from '@genie/service-meeting';
import { buildApp } from '../src/app.js';
import type { HostBridge } from '../src/host/bridge.js';
import { MemoryRateLimiter } from '../src/rate-limit/memory.js';
import { loadSigningKeys } from '../src/auth/keys.js';
import { JwtTokens } from '../src/auth/tokens.js';
import type { Environment, GatewayConfig } from '../src/config.js';
import type { App } from '../src/fastify.js';

const sink = new Writable({
  write(_c, _e, cb) {
    cb();
  },
});

export function testDbConfig(url: string, identityUrl?: string, shareUrl?: string): DbConfig {
  return {
    url,
    identityUrl,
    shareUrl,
    shareMaxConnections: 2,
    maxConnections: 8,
    identityMaxConnections: 2,
    idleTimeoutMillis: 5_000,
    connectionTimeoutMillis: 5_000,
    statementTimeoutMillis: 20_000,
    applicationName: 'astra-test',
  };
}

export async function makeTokens(): Promise<JwtTokens> {
  return new JwtTokens({
    issuer: 'https://auth.astra.test',
    keys: await loadSigningKeys({ keyId: 'test-1' }),
  });
}

export interface TestApp {
  readonly app: App;
  readonly db: DbHandle;
  readonly tasks: TaskService;
  readonly library: LibraryService;
  readonly runtime: InMemoryTaskRuntime;
  readonly registry: PluginRegistryService;
  readonly shares: ShareService;
  readonly meetings: MeetingService;
  readonly recordings: MemoryRecordingStore;
  close(): Promise<void>;
}

export interface MakeAppOptions {
  readonly db?: DbHandle;
  readonly dbConfig: DbConfig;
  readonly tokens: JwtTokens;
  readonly env?: Environment;
  /** ready() の前に呼ばれる。テスト専用ルートを足す用。 */
  readonly configure?: (app: App) => void;
  /** 同梱プラグインを DB へ seed するか。プラグインを見るテストだけ true。 */
  readonly seedPlugins?: boolean;
  readonly bridge?: HostBridge;
  readonly allowedOrigins?: readonly string[];
  /** 外部 IdP の検証を差し替える（実物の鍵を持たないテストのため）。 */
  readonly identityVerifier?: import('../src/auth/idp.js').IdentityVerifier;
  /** live STT の代役に読ませる台本。省略すると録音だけになる。 */
  readonly script?: readonly ScriptLine[];
  /** dashboard の bind を解決する先。 */
  readonly dataSources?: DataSourceResolver;
}

export async function makeTestApp(options: MakeAppOptions): Promise<TestApp> {
  const owned = options.db === undefined;
  const db = options.db ?? createDb(options.dbConfig);
  const storeRoot = await mkdtemp(path.join(tmpdir(), 'astra-gw-'));
  const library = new LibraryService(db, new FsObjectStore(storeRoot));
  const runtime = new InMemoryTaskRuntime();
  const registry = new PluginRegistryService({ db, coreVersion: '0.1.0' });
  // install した plugin の agent を task にできるように、本番と同じ resolver を渡す
  // （渡さないと chat lane の General Assistant が「unknown task kind」で始まらず、試験がそれを見逃す）。
  const tasks = new TaskService(db, runtime, agentResolver(registry));
  // 会話経路も本番同様に積む。積まないと conversation の HTTP 契約を試験が見逃す。
  const conversations = new ConversationService({
    db,
    findAcceptedTask: tasks.findByConversationTurn.bind(tasks),
  });
  const shares = new ShareService({ db, library, shareHost: 'http://localhost:1430' });
  const meetings = new MeetingService({ db, publisher: { async publish() {} } });
  const recordings = new MemoryRecordingStore();
  // Work Context も本番同様に積む（Home の面と chat lane の注入を試験が見る）。
  const world = new WorldModelService({ db });
  const work = new WorkContextService({ db, world });
  if (options.seedPlugins) {
    await registry.seedBuiltins(
      fileURLToPath(new URL('../../../plugins/builtin', import.meta.url)),
    );
  }

  const config: GatewayConfig = {
    env: options.env ?? 'test',
    port: 0,
    host: '127.0.0.1',
    logLevel: 'silent',
    redisUrl: undefined,
    version: '0.1.0',
    db: options.dbConfig,
    builtinPluginsDir: fileURLToPath(new URL('../../../plugins/builtin', import.meta.url)),
    objectStoreRoot: storeRoot,
    recordingRoot: storeRoot,
    allowedOrigins: options.allowedOrigins ?? [],
    shareHost: 'http://localhost:1430',
    requesterSalt: 'test-salt',
    idp: { google: null, apple: null, line: null, publicUrl: null },
  };

  const app = buildApp({
    config,
    db,
    redis: null,
    rateLimiter: new MemoryRateLimiter(),
    logger: createLogger({ service: 'test', level: 'silent' }, sink),
    tokens: options.tokens,
    tasks,
    conversations,
    library,
    registry,
    shares,
    ...(options.identityVerifier ? { identityVerifier: options.identityVerifier } : {}),
    // UI/UX §15 の Evidence。本番と同じく db だけで読む。
    evidence: new ResearchLedgerService(db),
    // 正本 §4.4: Dock を閉じても仕事が続くための調整役
    agentHosts: new AgentHostService({ db }),
    // 受け渡しも繋ぐ。繋がない harness だと、経路の欠落を試験が見逃す。
    hostBridge: new HostStepBridge({ db }),
    ...(options.dataSources === undefined ? {} : { dataSources: options.dataSources }),
    meetings: {
      meetings,
      recordings,
      ...(options.script ? { transcriber: new ScriptedStreamingTranscriber(options.script) } : {}),
    },
    world,
    work,
    ...(options.bridge === undefined ? {} : { bridge: options.bridge }),
    // テストは待ちたくないので短く回す
    ssePollIntervalMs: 20,
  });
  options.configure?.(app);
  await app.ready();

  return {
    app,
    db,
    tasks,
    library,
    runtime,
    registry,
    shares,
    meetings,
    recordings,
    async close() {
      await app.close();
      if (owned) await db.close();
    },
  };
}
