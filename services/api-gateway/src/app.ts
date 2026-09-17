/**
 * api-gateway の組み立て。実装仕様 §2.3・§11。
 *
 * ADR 0001 のとおり Phase 0〜3 は各サービスを in-process で composition する。
 * 依存は引数で受け取る（テストが実物と同じ経路を通れるようにするため）。
 */
import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import cors from '@fastify/cors';
import { HEADER_REQUEST_ID } from '@genie/contracts';
import type { Redis } from 'ioredis';
import type { DbHandle } from '@genie/db';
import type { TaskService } from '@genie/service-task';
import type { LibraryService } from '@genie/service-library';
import type { PluginRegistryService } from '@genie/service-plugin-registry';
import type { ShareService } from '@genie/service-share';
import type { Logger } from '@genie/telemetry';
import { allowsDevelopmentRoutes, type GatewayConfig } from './config.js';
import { installErrorHandlers } from './errors.js';
import { normalizeRequestId, registerRequestId } from './plugins/request-id.js';
import { registerRateLimit } from './plugins/rate-limit.js';
import { registerHealthRoutes } from './routes/health.js';
import { registerAuth } from './auth/middleware.js';
import { registerAuthRoutes } from './auth/routes.js';
import { registerIdpRoutes } from './auth/idp-routes.js';
import { IdpVerifiers, type IdentityVerifier } from './auth/idp.js';
import type { JwtTokens } from './auth/tokens.js';
import { registerTaskRoutes, type EvidenceReader } from './routes/tasks.js';
import { registerAgentHostRoutes } from './routes/agent-host.js';
import { registerArtifactRoutes } from './routes/artifacts.js';
import { registerPluginRoutes } from './routes/plugins.js';
import { registerShareRoutes } from './routes/shares.js';
import { registerDomainRoutes, type DomainRouteDeps } from './routes/domain.js';
import { registerBriefRoutes } from './routes/brief.js';
import { registerConversationRoutes } from './routes/conversations.js';
import { registerOnboardingRoutes } from './routes/onboarding.js';
import { registerVoiceRoutes, type VoiceRouteDeps } from './routes/voice.js';
import { reachmadeRouterFromEnv, registerReachmadeRoutes } from './routes/reachmade.js';
import type { ConversationService } from '@genie/service-conversation';
import type { WorkContextService, WorldModelService } from '@genie/service-world-model';
import { localArtifacts, registerWorkRoutes } from './routes/work.js';
import type { ConnectionService, DataSourceResolver } from '@genie/service-plugin-registry';
import {
  registerMeetingAudioRoute,
  registerMeetingRoutes,
  type MeetingRuntime,
} from './routes/meetings.js';
import { HostBridge } from './host/bridge.js';
import { registerHostRoutes } from './host/routes.js';
import type { RateLimiter } from './rate-limit/index.js';
import type { App } from './fastify.js';

export interface AppDeps {
  readonly config: GatewayConfig;
  readonly db: DbHandle;
  readonly redis: Redis | null;
  readonly rateLimiter: RateLimiter;
  readonly logger: Logger;
  readonly tokens: JwtTokens;
  readonly tasks: TaskService;
  readonly library: LibraryService;
  readonly registry: PluginRegistryService;
  readonly shares?: ShareService;
  /** UI/UX §15 の Evidence Ledger を引く先。 */
  readonly evidence?: EvidenceReader;
  /** 手元の実行基盤の調整役。無ければその経路は生えない（§4.4）。 */
  readonly agentHosts?: import('@genie/service-agent-host').AgentHostService;
  /** 手元でしか動かせない step の受け渡し。§4.4。 */
  readonly hostBridge?: import('@genie/service-agent-host').HostBridge;
  readonly meetings?: MeetingRuntime;
  /** dashboard の bind を解決する先。gateway が各サービスの束を合成して渡す。 */
  readonly dataSources?: DataSourceResolver;
  /** plugin が持ち込む entity。定義を引く先ごと渡す（Phase 5 §5）。 */
  readonly domain?: DomainRouteDeps;
  /** 「今日気にすべきこと」を組む先（Phase 6 §4）。 */
  readonly world?: WorldModelService;
  /** Work Context / Personalization（正本 §6・§10）。無ければ route も注入も生えない。 */
  readonly work?: WorkContextService;
  /** Conversation Engine。Task Dock の入口（Phase 7 §3）。 */
  readonly conversations?: ConversationService;
  /** connector の接続状態（正本 §2.4・§21）。 */
  readonly connections?: ConnectionService;
  /** Voice OS の Google STT / TTS。未設定でも route は明示的に 503 を返す。 */
  readonly voice?: VoiceRouteDeps;
  readonly bridge?: HostBridge;
  /** 外部の身元提供者の検証。テストでは差し替える。無ければ config から組む。 */
  readonly identityVerifier?: IdentityVerifier;
  /** SSE のポーリング間隔。テストは短くする。 */
  readonly ssePollIntervalMs?: number;
}

export function buildApp(deps: AppDeps): App {
  const app = Fastify({
    loggerInstance: deps.logger,
    // request id は Fastify の reqId として一度だけ確定させる。
    // フック側で採番し直すと、Fastify のログ行と自前のログ行で id がずれる。
    genReqId: (req) => normalizeRequestId(req.headers[HEADER_REQUEST_ID]),
    // プロキシ配下で client IP を正しく取る。レート制限のキーになるので重要。
    trustProxy: true,
    bodyLimit: 1024 * 1024,
  });

  // CORS はフックより前。preflight は認証もレート制限も通さない。
  void app.register(cors, {
    origin: deps.config.allowedOrigins.length > 0 ? [...deps.config.allowedOrigins] : false,
    credentials: false,
    // 明示しないと DELETE が preflight の許可に載らず、ブラウザからの
    // uninstall が弾かれる（実際に踏んだ）。
    // PATCH も同じ。載せていなかったので、onboarding の保存（PATCH /v1/onboarding）が
    // preflight で落ち、**初期セットアップが毎回最初からになっていた**（実機で踏んだ）。
    methods: ['GET', 'HEAD', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    // SSE の再開に要る。露出させないとクライアントが読めない。
    exposedHeaders: ['x-request-id', 'x-ratelimit-limit', 'x-ratelimit-remaining', 'retry-after'],
    allowedHeaders: [
      'authorization',
      'content-type',
      'idempotency-key',
      'x-request-id',
      'last-event-id',
    ],
  });

  // フックの登録順が実行順。認証はレート制限より前でなければならない
  // （user 単位で数えるには user が確定している必要がある。実装仕様 §11.1）
  registerRequestId(app);
  registerAuth(app, deps.tokens);
  registerRateLimit(app, deps.rateLimiter);
  installErrorHandlers(app);

  registerHealthRoutes(app, {
    db: deps.db,
    redis: deps.redis,
    version: deps.config.version,
  });
  registerAuthRoutes(app, {
    db: deps.db,
    tokens: deps.tokens,
    enableDevTokens: allowsDevelopmentRoutes(deps.config),
  });
  registerIdpRoutes(app, {
    db: deps.db,
    tokens: deps.tokens,
    verifier: deps.identityVerifier ?? new IdpVerifiers(deps.config.idp),
    enableDevTokens: allowsDevelopmentRoutes(deps.config),
  });
  registerTaskRoutes(app, {
    tasks: deps.tasks,
    redis: deps.redis,
    ...(deps.evidence === undefined ? {} : { evidence: deps.evidence }),
    ...(deps.ssePollIntervalMs === undefined ? {} : { ssePollIntervalMs: deps.ssePollIntervalMs }),
  });
  if (deps.agentHosts) {
    registerAgentHostRoutes(app, {
      hosts: deps.agentHosts,
      tasks: deps.tasks,
      ...(deps.hostBridge === undefined ? {} : { bridge: deps.hostBridge }),
    });
  }
  registerArtifactRoutes(app, { library: deps.library });
  registerVoiceRoutes(app, deps.voice ?? {});
  // Reachmade の外部 product capability は設定されたものだけ router に登録する。
  // route 自体は常に認証下に置き、未設定時は list=[] / execute=503 とする。
  registerReachmadeRoutes(app, { router: reachmadeRouterFromEnv() });
  // §3 の初期セットアップ。catalog を見るので registry の後。
  registerOnboardingRoutes(app, { db: deps.db, registry: deps.registry, tasks: deps.tasks });
  registerPluginRoutes(app, {
    registry: deps.registry,
    ...(deps.connections === undefined ? {} : { connections: deps.connections }),
    ...(deps.dataSources === undefined ? {} : { dataSources: deps.dataSources }),
  });
  if (deps.domain) registerDomainRoutes(app, deps.domain);
  if (deps.conversations) {
    registerConversationRoutes(app, {
      conversations: deps.conversations,
      tasks: deps.tasks,
      redis: deps.redis,
      ...(deps.work
        ? {
            work: deps.work,
            extraArtifacts: (tenantId: string) =>
              localArtifacts(
                {
                  work: deps.work!,
                  tasks: deps.tasks,
                  ...(deps.meetings ? { meetings: deps.meetings.meetings } : {}),
                },
                tenantId,
              ),
          }
        : {}),
      ...(deps.ssePollIntervalMs === undefined
        ? {}
        : { ssePollIntervalMs: deps.ssePollIntervalMs }),
    });
  }
  if (deps.work) {
    registerWorkRoutes(app, {
      work: deps.work,
      tasks: deps.tasks,
      ...(deps.meetings ? { meetings: deps.meetings.meetings } : {}),
    });
  }
  if (deps.world) {
    registerBriefRoutes(app, {
      world: deps.world,
      tasks: deps.tasks,
      ...(deps.meetings ? { meetings: deps.meetings.meetings } : {}),
    });
  }
  if (deps.meetings) {
    registerMeetingRoutes(app, {
      ...deps.meetings,
      tasks: deps.tasks,
      tokens: deps.tokens,
      logger: deps.logger,
      redis: deps.redis,
      ...(deps.ssePollIntervalMs === undefined
        ? {}
        : { ssePollIntervalMs: deps.ssePollIntervalMs }),
    });
  }
  if (deps.shares) {
    registerShareRoutes(app, {
      shares: deps.shares,
      tokens: deps.tokens,
      db: deps.db,
      rateLimiter: deps.rateLimiter,
      requesterSalt: deps.config.requesterSalt,
      shareHost: deps.config.shareHost,
    });
  }

  // WebSocket のルートは、プラグインの読み込みが終わったスコープで登録する。
  // 同じ tick で app.register(websocket) の直後に足すと、まだ `websocket: true` を
  // 解釈できず通常の HTTP ルートとして登録されてしまう。
  const bridge = deps.bridge ?? new HostBridge({ logger: deps.logger });
  void app.register(async (instance) => {
    await instance.register(websocket);
    registerHostRoutes(instance as unknown as App, {
      bridge,
      tokens: deps.tokens,
      logger: deps.logger,
    });
    if (deps.meetings) {
      registerMeetingAudioRoute(instance as unknown as App, {
        ...deps.meetings,
        tasks: deps.tasks,
        tokens: deps.tokens,
        logger: deps.logger,
        redis: deps.redis,
      });
    }
  });

  return app;
}
