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
import { registerTransactionAuthorizationRoutes } from './routes/transaction-authorizations.js';
import { registerAgentHostRoutes } from './routes/agent-host.js';
import { registerAgentSessionRoutes } from './routes/agent-sessions.js';
import { registerWorkDeskRoutes } from './routes/work-desk.js';
import { registerWorkHomeRoutes } from './routes/work-home.js';
import {
  registerHandoffHostRoutes,
  registerHandoffViewerRoutes,
} from './routes/browser-handoff.js';
import { registerConnectorReconnectRoutes } from './connector-reconnect.js';
import { registerArtifactRoutes } from './routes/artifacts.js';
import { registerPluginRoutes } from './routes/plugins.js';
import { registerShareRoutes } from './routes/shares.js';
import { registerDomainRoutes, type DomainRouteDeps } from './routes/domain.js';
import { registerBriefRoutes } from './routes/brief.js';
import { registerConversationRoutes, type ConversationRouteDeps } from './routes/conversations.js';
import {
  registerChannelRoutes,
  registerUnconfiguredChannelStatus,
  type ChannelRouteDeps,
} from './routes/channels.js';
import { registerScheduleRoutes } from './routes/schedules.js';
import { registerVocabularyRoutes } from './routes/vocabulary.js';
import type { TurnDeps } from '@genie/service-conversation';
import { registerPhoneRoutes, type PhoneRouteDeps } from './routes/phone.js';
import { registerOnboardingRoutes } from './routes/onboarding.js';
import { registerVoiceRoutes, type VoiceRouteDeps } from './routes/voice.js';
import { registerCallRoutes } from './routes/call.js';
import { registerBoardRoutes } from './routes/board.js';
import { registerMediaRoutes } from './routes/media.js';
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
  /** 「電話して」を Oathra 経由の仕事にする。無ければ電話の頼みは受けない。 */
  readonly phone?: ConversationRouteDeps['phone'];
  /**
   * チャット（Slack / LINE）。発話の入口は Task Dock と同じ handleTurn なので、
   * ここで組んだ TurnDeps を受け取って受け口の依存を返す。null なら受け口を開かない。
   */
  readonly channels?: (turnDeps: TurnDeps) => ChannelRouteDeps | null;
  /**
   * 予約（「明日 9 時に〜教えて」）。会話で作り・一覧し・取り消す。無ければ予約の言い方は受けない。
   * 時間になったら動かす見回り（ScheduleRunner）は、組んだ TurnDeps を受け取って呼ぶ側が作る
   * （`onTurnDeps`）。
   */
  readonly schedules?: import('@genie/service-schedule').ScheduleService;
  /**
   * 締切のある「やること」（「金曜までに見積書を出す」「やることは？」「見積書出した」）。予約より先に読む。
   * 無ければ受けない（予約の言い方だけ）。
   */
  readonly todos?: import('@genie/service-schedule').TodoService;
  /** 仕事の見通し（Task Dock の件数と、「今の作業どうなってる？」の答え）。 */
  readonly workDesk?: import('./work-desk.js').WorkDesk;
  /** 仕事のホームのリンク（LINE から開くページ）。 */
  readonly workLinks?: import('./work-home.js').WorkLinkStore;
  /** Claude Code の承認を LINE から（agent-approvals.ts）。 */
  readonly agentApprovals?: import('./agent-approvals.js').AgentApprovals;
  /** エージェントの仕事（agent-jobs.ts）。 */
  readonly agentJobs?: import('./agent-jobs.js').AgentJobs;
  /** メール・予定の接続が切れたときの知らせと、LINE からのつなぎ直し。 */
  readonly connectorReconnects?: import('./connector-reconnect.js').ConnectorReconnects;
  /** ブラウザの引き継ぎ（つまずいた Genie 専用のブラウザを、本人が LINE から操作する）。 */
  readonly handoffs?: Omit<
    import('./routes/browser-handoff.js').HandoffRouteDeps,
    'bridge' | 'tasks'
  >;
  /** 個人の辞書。会話で登録し、Mac の音声入力が取りに来る（GET /v1/vocabulary）。 */
  readonly vocabulary?: import('@genie/service-vocabulary').VocabularyService;
  /** グループの計画（Action Board）のページ。リンクで開く（読むだけ）。 */
  readonly boards?: import('./board.js').BoardStore;
  /** カードの画像（店の写真・地図）の中継。 */
  readonly media?: import('./media.js').MediaResolver;
  /** 送った写真・外国語の文のあと（「はい」「取り消して」「家計簿を見せて」「これに返信して」）。 */
  readonly understand?: import('@genie/service-conversation').TurnSchedules;
  /** 予定を読む・ずらす・元に戻す（calendar-turn.ts）。 */
  readonly calendar?: import('@genie/service-conversation').TurnCalendar;
  /** 組み上がった TurnDeps を受け取る（予約の見回りが、同じ入口で頼むため）。 */
  readonly onTurnDeps?: (turnDeps: TurnDeps) => void;
  /** 利用者ごとの電話の接続（PUT / GET / DELETE /v1/phone/connection）。 */
  readonly phoneConnections?: PhoneRouteDeps;
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
  registerTransactionAuthorizationRoutes(app, { db: deps.db, tasks: deps.tasks });
  // ほかの AI（Claude Code）に頼んだ仕事の見守り。hooks の受け口と Task Dock の一覧
  registerAgentSessionRoutes(app, {
    db: deps.db,
    ...(deps.agentApprovals ? { approvals: deps.agentApprovals } : {}),
    ...(deps.agentJobs ? { jobs: deps.agentJobs } : {}),
  });
  if (deps.workDesk) registerWorkDeskRoutes(app, deps.workDesk);
  if (deps.workDesk && deps.workLinks)
    registerWorkHomeRoutes(app, {
      desk: deps.workDesk,
      links: deps.workLinks,
      ...(deps.agentApprovals ? { approvals: deps.agentApprovals } : {}),
    });
  const handoffs =
    deps.handoffs && deps.hostBridge
      ? { ...deps.handoffs, bridge: deps.hostBridge, tasks: deps.tasks }
      : null;
  if (handoffs) registerHandoffHostRoutes(app, handoffs);
  if (deps.connectorReconnects) registerConnectorReconnectRoutes(app, deps.connectorReconnects);
  if (deps.agentHosts) {
    registerAgentHostRoutes(app, {
      hosts: deps.agentHosts,
      tasks: deps.tasks,
      ...(deps.hostBridge === undefined ? {} : { bridge: deps.hostBridge }),
    });
  }
  registerArtifactRoutes(app, { library: deps.library });
  registerVoiceRoutes(app, deps.voice ?? {});
  // §3 の初期セットアップ。catalog を見るので registry の後。
  registerOnboardingRoutes(app, { db: deps.db, registry: deps.registry, tasks: deps.tasks });
  registerPluginRoutes(app, {
    registry: deps.registry,
    ...(deps.connections === undefined ? {} : { connections: deps.connections }),
    ...(deps.dataSources === undefined ? {} : { dataSources: deps.dataSources }),
  });
  if (deps.domain) registerDomainRoutes(app, deps.domain);
  if (deps.phoneConnections) registerPhoneRoutes(app, deps.phoneConnections);
  // 通話のページ（WebSocket）。チャネルを組んだあと、websocket のスコープで登録する
  let callRoutes: import('./routes/call.js').CallRouteDeps | null = null;
  if (deps.conversations) {
    /*
     * 発話から仕事へ（handleTurn）の依存。Task Dock（HTTP）とチャットで**同じものを使う。**
     * 別々に組むと、片方だけ電話や Work Context が効かない、ということが起きる。
     */
    const turnDeps: TurnDeps = {
      conversations: deps.conversations,
      tasks: deps.tasks,
      ...(deps.phone ? { phone: deps.phone } : {}),
      /*
       * やること（締切つき）は、ほかの言い方より先に読む。期限なしの TODO（understand）の「やることは？」に
       * 先に取られると、締切つきのものが一覧に出ない（2026-11-06 に見つけた）。一覧は両方を 1 つにして返す。
       * 読めなければ（null）いつもの順（understand → 辞書 → 予約）へ。
       */
      ...(deps.schedules
        ? {
            schedules:
              deps.todos && !deps.understand
                ? {
                    handle: async (principal, conversationId, text) =>
                      (await deps.todos!.handle(principal, conversationId, text)) ??
                      deps.schedules!.handle(principal, conversationId, text),
                  }
                : deps.schedules,
          }
        : {}),
      ...(deps.vocabulary ? { vocabulary: deps.vocabulary } : {}),
      ...(deps.understand
        ? {
            understand: deps.todos
              ? {
                  handle: async (principal, conversationId, text) =>
                    (await deps.todos!.handle(principal, conversationId, text)) ??
                    deps.understand!.handle(principal, conversationId, text),
                }
              : deps.understand,
          }
        : {}),
      ...(deps.calendar ? { calendar: deps.calendar } : {}),
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
    };
    registerConversationRoutes(app, {
      ...turnDeps,
      conversations: deps.conversations,
      redis: deps.redis,
      ...(deps.ssePollIntervalMs === undefined
        ? {}
        : { ssePollIntervalMs: deps.ssePollIntervalMs }),
    });
    const channels = deps.channels?.(turnDeps) ?? null;
    if (channels) registerChannelRoutes(app, channels);
    else registerUnconfiguredChannelStatus(app);
    callRoutes = channels?.call ?? null;
    deps.onTurnDeps?.(turnDeps);
  }
  if (deps.schedules) registerScheduleRoutes(app, { schedules: deps.schedules });
  if (deps.boards) registerBoardRoutes(app, { boards: deps.boards });
  if (deps.media) registerMediaRoutes(app, { media: deps.media });
  if (deps.vocabulary) registerVocabularyRoutes(app, { vocabulary: deps.vocabulary });
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
    if (callRoutes) registerCallRoutes(instance as unknown as App, callRoutes);
    if (handoffs) registerHandoffViewerRoutes(instance as unknown as App, handoffs);
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
