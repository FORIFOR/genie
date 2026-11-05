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
import { AgentApprovals } from '../src/agent-approvals.js';
import { buildApp } from '../src/app.js';
import { channelsFromEnv } from '../src/channels.js';
import { HandoffStore } from '../src/browser-handoff.js';
import { scheduleRunner } from '../src/schedules.js';
import { householdChannels, personalCommands, sharedSpaceService } from '../src/understand.js';
import { calendarTurnDeps } from '../src/calendar-turn.js';
import { PlacesSearch } from '../src/places.js';
import { BoardStore } from '../src/board.js';
import { MediaResolver } from '../src/media.js';
import { RestaurantGoals } from '../src/restaurant.js';
import {
  CandidateService,
  CandidateStore,
  ScheduleService,
  ScheduleStore,
  TodoService,
  TodoStore,
} from '@genie/service-schedule';
import { TodoStore as UndatedTodoStore } from '@genie/service-understand';
import { previousUserText } from '../src/todo-context.js';
import { VocabularyService, VocabularyStore } from '@genie/service-vocabulary';
import {
  ExpenseStore,
  PendingStore,
  ScriptedUnderstander,
  UnderstandService,
} from '@genie/service-understand';
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
  /** チャットの見回り（pump）を手で回すため。channels を渡したときだけ。 */
  readonly channels: import('../src/channels.js').GatewayChannels | null;
  /** 予約の見回りを手で回すため。schedules を渡したときだけ。 */
  readonly schedules: import('@genie/service-schedule').ScheduleRunner | null;
  /** 台本どおりに読む代役（グループの答え groupAnswer を差し替える）。understand を渡したときだけ。 */
  readonly understander: ScriptedUnderstander | null;
  /** Claude Code の承認を LINE から。agentApprovals を渡したときだけ。 */
  readonly agentApprovals: AgentApprovals | null;
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
  /** 個人の辞書を有効にする。 */
  readonly vocabulary?: boolean;
  /** 写真・外国語の文を読む。モデルの代わりに、この答えを順に返す。 */
  readonly understand?: import('@genie/service-understand').Understanding[];
  /** 予約を有効にする（時計は差し替えられる）。 */
  readonly schedules?: { readonly tz?: string; readonly now?: () => number };
  /** お店探し（restaurant.ts）。Google Places の代役。 */
  readonly restaurants?: { readonly fetchImpl: typeof fetch; readonly now?: () => Date };
  /** カードの画像の中継（Google の代役）。渡したときだけ、地図・写真をリンクで出す。 */
  readonly media?: { readonly fetchImpl: typeof fetch; readonly monthlyPhotos?: number };
  /** 予定を読む・ずらす・元に戻す（calendar-turn.ts）。now は予定の「明日」を決める時計。 */
  readonly calendar?: { readonly now?: () => Date };
  /** 外部 IdP の検証を差し替える（実物の鍵を持たないテストのため）。 */
  readonly identityVerifier?: import('../src/auth/idp.js').IdentityVerifier;
  /** live STT の代役に読ませる台本。省略すると録音だけになる。 */
  readonly script?: readonly ScriptLine[];
  /** dashboard の bind を解決する先。 */
  readonly dataSources?: DataSourceResolver;
  /** 電話（Oathra）の代役。省略すると電話の頼みは受けない。 */
  readonly phone?: import('../src/app.js').AppDeps['phone'];
  /** チャット（Slack / LINE）。env は本番と同じ名前、外への送信は fetchImpl が受ける。 */
  readonly channels?: {
    readonly env: NodeJS.ProcessEnv;
    readonly fetchImpl: typeof fetch;
    readonly connectSocket?: (url: string) => import('@genie/service-channels').SocketLike;
    /** 通話の Gemini Live の代役（ループバック）。 */
    readonly callEndpoint?: string;
    /** 仕事のホームのリンク（終わりの知らせに付ける）。 */
    readonly homeLink?: import('@genie/service-channels').ChannelServiceDeps['homeLink'];
    /** 予定を作る許可の知らせ（connector-reconnect の代役。null なら許可済み）。 */
    readonly calendarWriteNotice?: (tenantId: string, userId: string) => Promise<string | null>;
  };
  /** Claude Code の承認を LINE から（本番と同じくチャットの service へつなぐ）。 */
  readonly agentApprovals?: {
    readonly humanWait?: import('../src/agent-approvals.js').AgentApprovalDeps['humanWait'];
    readonly now?: () => Date;
    readonly projectOf?: import('../src/agent-approvals.js').AgentApprovalDeps['projectOf'];
  };
  /** ブラウザの引き継ぎ（store はここで作る）。省略すると /v1/browser-handoffs は生えない。 */
  readonly handoffs?: Omit<
    import('../src/routes/browser-handoff.js').HandoffRouteDeps,
    'bridge' | 'tasks' | 'store'
  >;
  /** 電話の接続の預かり先。省略すると /v1/phone/connection は生えない。 */
  readonly phoneConnections?: import('../src/app.js').AppDeps['phoneConnections'];
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

  const chat: { current: import('../src/channels.js').GatewayChannels | null } = { current: null };
  const understander = options.understand
    ? new ScriptedUnderstander(options.understand, 'Sure, see you then.')
    : null;
  const understandService = understander
    ? new UnderstandService({
        understander,
        expenses: new ExpenseStore(db),
        timeZone: 'Asia/Tokyo',
        lists: sharedSpaceService(db, 'Asia/Tokyo'),
        // 本番と同じく確かめ中のことを DB に置く（会話の ID は UUID。2026-10-28 グループで失敗したのはここ）
        pending: new PendingStore(db),
      })
    : null;
  const groupsRef: Parameters<typeof personalCommands>[0]['groups'] = { current: null };
  // グループの計画（Action Board）。リンクの先頭は試験用の固定の名前
  const boards = new BoardStore(db);
  const boardUrl = (token: string) => `https://genie.test/v1/channels/board/${token}`;
  const media = options.media
    ? new MediaResolver({
        db,
        apiKey: 'test-key',
        publicUrl: 'https://genie.test',
        monthlyPhotos: options.media.monthlyPhotos ?? 900,
        monthlyMaps: 300,
        fetchImpl: options.media.fetchImpl,
      })
    : null;
  const restaurants = options.restaurants
    ? {
        goals: new RestaurantGoals(db),
        ...(media ? { media } : {}),
        places: new PlacesSearch({
          ...(media
            ? {
                photoLink: (tenantId: string, placeId: string, photoName: string) =>
                  media.link(tenantId, { kind: 'place_photo', placeId, photoName }),
              }
            : {}),
          apiKey: 'test-key',
          monthlySearches: 300,
          db,
          fetchImpl: options.restaurants.fetchImpl,
        }),
        timeZone: 'Asia/Tokyo',
        ...(options.restaurants.now ? { now: options.restaurants.now } : {}),
      }
    : null;
  const personal = understandService
    ? personalCommands({
        db,
        understand: understandService,
        timeZone: 'Asia/Tokyo',
        groups: groupsRef,
        ...(restaurants ? { restaurants } : {}),
      })
    : null;
  const scheduleService = options.schedules
    ? new ScheduleService(new ScheduleStore(db), {
        tz: options.schedules.tz ?? 'Asia/Tokyo',
        ...(options.schedules.now ? { now: options.schedules.now } : {}),
      })
    : null;
  // 本番（server.ts）と同じく、期限なしの TODO も一覧に並べ、「これ」は直前の文から決める
  const todoService = scheduleService
    ? new TodoService(new TodoStore(db), scheduleService.store, {
        tz: options.schedules?.tz ?? 'Asia/Tokyo',
        ...(options.schedules?.now ? { now: options.schedules.now } : {}),
        undated: (p) =>
          new UndatedTodoStore(db).open({
            tenantId: p.tenantId,
            userId: p.userId,
            householdId: null,
          }),
        previousText: previousUserText(conversations),
      })
    : null;
  const candidateService = todoService
    ? new CandidateService(new CandidateStore(db), todoService, {
        tz: options.schedules?.tz ?? 'Asia/Tokyo',
        ...(options.schedules?.now ? { now: options.schedules.now } : {}),
      })
    : null;
  let turnDepsSeen: import('@genie/service-conversation').TurnDeps | null = null;
  const agentApprovals = options.agentApprovals
    ? new AgentApprovals({
        db,
        available: () => chat.current !== null,
        ask: async (tenantId, userId, view) =>
          (await chat.current?.service.askAgentApproval(
            tenantId,
            userId,
            view.id,
            view,
            'Asia/Tokyo',
          )) ?? false,
        tell: async (tenantId, userId, text) => {
          await chat.current?.service.notifyUser(tenantId, userId, null, text);
        },
        ...(options.agentApprovals.projectOf
          ? { projectOf: options.agentApprovals.projectOf }
          : {}),
        ...(options.agentApprovals.now ? { now: options.agentApprovals.now } : {}),
        ...(options.agentApprovals.humanWait
          ? { humanWait: options.agentApprovals.humanWait }
          : {}),
      })
    : null;
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
    ...(agentApprovals ? { agentApprovals } : {}),
    ...(options.handoffs === undefined
      ? {}
      : { handoffs: { ...options.handoffs, store: new HandoffStore(db) } }),
    ...(options.dataSources === undefined ? {} : { dataSources: options.dataSources }),
    ...(options.phone === undefined ? {} : { phone: options.phone }),
    ...(options.channels === undefined
      ? {}
      : {
          channels: (turnDeps: import('@genie/service-conversation').TurnDeps) => {
            chat.current = channelsFromEnv(options.channels!.env, {
              db,
              tasks,
              conversations,
              library,
              turnDeps,
              logger: createLogger({ service: 'test', level: 'silent' }),
              fetchImpl: options.channels!.fetchImpl,
              ...(options.channels!.connectSocket
                ? { connectSocket: options.channels!.connectSocket }
                : {}),
              ...(options.channels!.callEndpoint
                ? { callEndpoint: options.channels!.callEndpoint }
                : {}),
              ...(options.channels!.homeLink ? { homeLink: options.channels!.homeLink } : {}),
              ...(options.channels!.calendarWriteNotice
                ? { calendarWriteNotice: options.channels!.calendarWriteNotice }
                : {}),
              ...(scheduleService
                ? {
                    remindBefore: (principal, conversationId, event) =>
                      scheduleService.remindBefore(principal, conversationId, event),
                    proposeCandidates: (principal, conversationId, text, source) =>
                      candidateService!.propose(principal, conversationId, text, source),
                  }
                : {}),
              ...(agentApprovals
                ? {
                    agentApprovals: {
                      decide: (t, u, id, choice) => agentApprovals.decide(t, u, id, choice),
                      instruct: (t, u, text) => agentApprovals.instruct(t, u, text),
                      command: (t, u, text) => agentApprovals.command(t, u, text),
                    },
                  }
                : {}),
              ...(understandService
                ? {
                    understand: understandService,
                    shared: householdChannels({
                      db,
                      understand: understandService,
                      timeZone: 'Asia/Tokyo',
                      conversations,
                      ...(restaurants ? { restaurants } : {}),
                      boards: { store: boards, urlFor: boardUrl },
                      ...(options.restaurants?.now ? { now: options.restaurants.now } : {}),
                    }),
                    onSpoken: (conversationId: string, text: string) =>
                      personal?.rememberSpoken(conversationId, text),
                  }
                : {}),
            });
            if (chat.current) {
              const { service, routes } = chat.current;
              groupsRef.current = {
                postToGroup: (t, u, text) => service.postToGroup(t, u, text),
                lastSaid: (t, c) => routes.store.lastSaid(t, c),
              };
            }
            return chat.current?.routes ?? null;
          },
        }),
    ...(options.phoneConnections === undefined
      ? {}
      : { phoneConnections: options.phoneConnections }),
    meetings: {
      meetings,
      recordings,
      ...(options.script ? { transcriber: new ScriptedStreamingTranscriber(options.script) } : {}),
    },
    world,
    work,
    ...(options.bridge === undefined ? {} : { bridge: options.bridge }),
    ...(options.vocabulary ? { vocabulary: new VocabularyService(new VocabularyStore(db)) } : {}),
    ...(personal ? { understand: personal } : {}),
    boards,
    ...(media ? { media } : {}),
    ...(options.calendar
      ? {
          calendar: calendarTurnDeps({
            tasks,
            library,
            timeZone: 'Asia/Tokyo',
            ...(options.calendar.now ? { now: options.calendar.now } : {}),
          }),
        }
      : {}),
    ...(scheduleService
      ? {
          schedules: scheduleService,
          todos: todoService!,
          candidates: candidateService!,
          onTurnDeps: (turnDeps: import('@genie/service-conversation').TurnDeps) => {
            turnDepsSeen = turnDeps;
          },
        }
      : {}),
    // テストは待ちたくないので短く回す
    ssePollIntervalMs: 20,
  });
  options.configure?.(app);
  await app.ready();
  const schedules =
    scheduleService && turnDepsSeen
      ? scheduleRunner({
          schedules: scheduleService,
          turnDeps: turnDepsSeen,
          tasks,
          channels: chat.current?.service ?? null,
          logger: createLogger({ service: 'test', level: 'silent' }),
          ...(options.schedules?.now ? { now: options.schedules.now } : {}),
        })
      : null;

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
    channels: chat.current,
    schedules,
    understander,
    agentApprovals,
    async close() {
      await app.close();
      if (owned) await db.close();
    },
  };
}
