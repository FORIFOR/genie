/** 起動エントリ。 */
import { Redis } from 'ioredis';
import { createDb } from '@genie/db';
import { createLogger } from '@genie/telemetry';
import { FsObjectStore, LibraryService } from '@genie/service-library';
import { TaskService, TemporalTaskRuntime } from '@genie/service-task';
import {
  ConnectionService,
  PluginRegistryService,
  agentResolver,
  assetReader,
  composeDataSources,
} from '@genie/service-plugin-registry';
import {
  DomainService,
  entityDefinitions,
  architectureDataSources,
  careDataSources,
  ehrDataSources,
  salesCrmDataSources,
  stockDataSources,
  videoDataSources,
} from '@genie/service-agent-runtime';
import { AgentHostService, HostBridge, HostStepExecutor } from '@genie/service-agent-host';
import { WorkContextService, WorldModelService } from '@genie/service-world-model';
import { ConversationService, handleTurn } from '@genie/service-conversation';
import {
  ResearchLedgerService,
  researchDataSources,
  researchProvidersFromEnv,
} from '@genie/service-research';
import { meetingDataSources } from '@genie/service-meeting';
import { ShareService } from '@genie/service-share';
import {
  FsRecordingStore,
  GoogleTtsProvider,
  MeetingService,
  meetingProvidersFromEnv,
} from '@genie/service-meeting';
// 代役の判定は contracts が正。service ごとに数えると、片方だけ見落とす。
import { SendTurnRequest, assertReadyForProduction } from '@genie/contracts';
import { capabilityReport, capabilitySummary } from '@genie/service-capabilities';
import { buildApp } from './app.js';
import { phoneFromEnv } from './phone.js';
import { channelsFromEnv, type GatewayChannels } from './channels.js';
import { scheduleRunner, scheduleServiceFromEnv } from './schedules.js';
import { householdChannels, personalCommands, understandServiceFromEnv } from './understand.js';
import { OpencodeWatchService } from './opencode-watch.js';
import { WorkDesk, WorkDeskWatch } from './work-desk.js';
import { AgentSessionWatch } from './agent-session-watch.js';
import { calendarTurnDeps } from './calendar-turn.js';
import { PlacesSearch } from './places.js';
import { RestaurantGoals } from './restaurant.js';
import { CallStore, callConfigFromEnv } from './call.js';
import type { ScheduleRunner } from '@genie/service-schedule';
import { VocabularyService, VocabularyStore } from '@genie/service-vocabulary';
import type { TurnDeps } from '@genie/service-conversation';
import { assertPathsExist, gatewayConfigFromEnv } from './config.js';
import { keyConfigFromEnv, loadSigningKeys } from './auth/keys.js';
import { JwtTokens } from './auth/tokens.js';
import { BoardStore } from './board.js';
import { boardUrlFor } from './routes/board.js';
import { WorkLinkStore, homeLinkFor, openHomeAnswer, workUrlFor } from './work-home.js';
import { HandoffHub, HandoffStore, handoffUrlFor } from './browser-handoff.js';
import { MediaResolver } from './media.js';
import { MemoryRateLimiter, RedisRateLimiter, type RateLimiter } from './rate-limit/index.js';

async function main(): Promise<void> {
  const config = gatewayConfigFromEnv();
  assertPathsExist(config);
  const logger = createLogger({
    service: 'api-gateway',
    version: config.version,
    level: config.logLevel,
    pretty: config.env === 'development',
  });

  const db = createDb(config.db);
  const redis = config.redisUrl ? new Redis(config.redisUrl) : null;

  if (!redis && config.env === 'production') {
    // プロセス内カウンタは水平スケールすると実質無制限になる
    throw new Error('REDIS_URL is required in production (in-memory rate limiting does not scale)');
  }
  const rateLimiter: RateLimiter = redis ? new RedisRateLimiter(redis) : new MemoryRateLimiter();

  const keys = await loadSigningKeys(keyConfigFromEnv(), logger);
  if (keys.ephemeral && config.env === 'production') {
    // 再起動のたびに全トークンが無効になる
    throw new Error('ASTRA_JWT_PRIVATE_KEY / ASTRA_JWT_PUBLIC_KEY are required in production');
  }
  const tokens = new JwtTokens({
    issuer: process.env['ASTRA_JWT_ISSUER'] ?? 'https://auth.astra.local',
    keys,
  });

  const library = new LibraryService(db, new FsObjectStore(config.objectStoreRoot));
  const runtime = await TemporalTaskRuntime.connect({
    address: process.env['TEMPORAL_ADDRESS'] ?? 'localhost:7233',
    namespace: process.env['TEMPORAL_NAMESPACE'] ?? 'default',
    // 環境ごとに分ける。同じ queue を共有すると、片方の使い捨て DB に紐づく
    // ワークフローがもう片方の worker の枠を食う（実際に踏んだ）。
    ...(process.env['ASTRA_TASK_QUEUE'] ? { taskQueue: process.env['ASTRA_TASK_QUEUE'] } : {}),
  });
  const registry = new PluginRegistryService({
    db,
    coreVersion: config.version,
    // 本番で未実装のゲートに寄りかからないための判定に使う
    env: config.env,
  });
  // install した plugin の agent を task として実行できるようにする（Phase 5 §2）
  const tasks = new TaskService(db, runtime, agentResolver(registry));
  const shares = new ShareService({ db, library, shareHost: config.shareHost });

  /*
   * 設定されていれば本物、無ければ代役（Phase 2 §1.1 / Phase 3 §10）。
   *
   * **数え漏らさない。**以前は会議の提供者しか見ておらず、
   * 代役の言語モデルのまま本番が起動できた。
   * いまは能力の一覧（contracts）が過不足を型で塞ぐ。
   */
  const hostStepBridge = new HostBridge({ db });
  const meetingProviders = await meetingProvidersFromEnv(process.env);
  /*
   * worker と**同じ関数を通す。**片方だけ端末の口を渡していた間、
   * 同じ構成で worker は「言語モデルは本物」、gateway は「代役」と言っていた。
   * gateway はモデルを呼ばないが、**何が使える構成かは同じでなければならない。**
   */
  const researchProviders = researchProvidersFromEnv(process.env, {
    host: new HostStepExecutor({ bridge: hostStepBridge }),
  });
  /*
   * 接続の有無だけは、設定ではなく**実際に起きたこと**で見る。
   * 繋がった実績が 1 つも無いなら、繋げるかどうかは分からない。
   */
  const connections = new ConnectionService({ db });
  const report = capabilityReport({
    research: researchProviders,
    meeting: meetingProviders,
    env: process.env,
    observed: { oauthConnected: await connections.anyConnected() },
  });
  const { warn, blocked } = assertReadyForProduction(report, config.env);
  /*
   * **全部を数え上げて出す。**代役だけを出していた間、
   * 本物になった能力はどこにも現れなかった。片方の面だけが
   * 本物になっても気づけない — 実際、worker と gateway が
   * 違うことを言っている状態が生まれていた。
   */
  logger.info({ capabilities: capabilitySummary(report) }, 'external capabilities');
  if (warn) logger.warn({ not_ready: blocked.map((r) => r.capability) }, warn);
  const meetings = new MeetingService({
    db,
    publisher: { async publish() {} },
    translator: meetingProviders.translation,
  });
  // 同梱プラグインは起動のたびに読み直す。バンドルが正、DB はその写し。
  await registry.seedBuiltins(config.builtinPluginsDir);

  // dashboard の bind を解決する先。**引くのは所有サービス**で、
  // gateway は束ねるだけ（実装仕様 §5.1）。
  const domain = new DomainService({ db });
  const world = new WorldModelService({ db });
  const work = new WorkContextService({ db, world });
  const conversations = new ConversationService({
    db,
    findAcceptedTask: tasks.findByConversationTurn.bind(tasks),
  });
  const dataSources = composeDataSources(
    researchDataSources(db),
    meetingDataSources(db),
    salesCrmDataSources(domain),
    // 正本 §15.2 の timeline/projects・render queue・assets
    videoDataSources(domain),
    // 正本 §15.4 の申し送り面
    careDataSources(domain),
    // 正本 §15.5 の診療面
    ehrDataSources(domain),
    // 正本 §15.6 の案件面
    architectureDataSources(domain),
    // 正本 §15.7 の銘柄面
    stockDataSources(domain),
  );

  // Oathra 経由の電話。設定が無ければ、電話の頼みには「繋がっていない」と答える
  const phone = phoneFromEnv(process.env, { db, tasks, logger });
  // チャット（Slack / LINE）。設定された提供者だけ受け口が開く
  const chat: { current: GatewayChannels | null } = { current: null };
  // 予約: 会話で作り、時間になったら同じ入口（handleTurn）で頼む
  const schedules = scheduleServiceFromEnv(process.env, db);
  // 写真・外国語の文を読む（家計簿・料理の目安・予定・訳）。チャットと handleTurn で同じものを使う
  const understand = understandServiceFromEnv(process.env, { db, logger, timeZone: schedules.tz });
  // 1:1・通話・Task Dock の決まった言い方（家族の家計簿・グループへ送る）。グループへの口はチャネルを組んだあとで入る
  const groups: Parameters<typeof personalCommands>[0]['groups'] = { current: null };
  // opencode のセッションの見守り。知らせはチャット（無ければ本人の LINE）へ。チャネルを組んだあとで口が入る
  const watches = new OpencodeWatchService({
    db,
    notify: async (tenantId, userId, conversationId, text) => {
      await chat.current?.service.notifyUser(tenantId, userId, conversationId, text);
    },
    log: (event, detail) => logger.info(detail, event),
  });
  // ほかの AI（Claude Code）の承認待ち・停滞の知らせ。Mac の通知と、つないでいれば本人の LINE へ
  const agentWatch = new AgentSessionWatch({
    db,
    notifyChat: async (tenantId, userId, text) => {
      await chat.current?.service.notifyUser(tenantId, userId, null, text);
    },
    log: (event, detail) => logger.info(detail, event),
  });
  // カードの画像（店の写真・地図）は gateway が中継する（キーを外へ出さない・写真を保存しない）
  const placesKey = process.env['GENIE_PLACES_API_KEY']?.trim() || null;
  const media = new MediaResolver({
    db,
    apiKey: placesKey,
    publicUrl: callConfigFromEnv(process.env).publicUrl,
    monthlyPhotos: Number(process.env['GENIE_PLACES_MONTHLY_PHOTOS'] ?? '900') || 900,
    monthlyMaps: Number(process.env['GENIE_MAPS_MONTHLY_STATIC'] ?? '300') || 300,
  });
  // お店探し（Google Places。キーはキーチェーンの google-maps を preview が渡す。無ければ「探せない」と言う）
  const restaurants = {
    goals: new RestaurantGoals(db),
    ...(media.available ? { media } : {}),
    places: new PlacesSearch({
      ...(media.available
        ? {
            photoLink: (tenantId: string, placeId: string, photoName: string) =>
              media.link(tenantId, { kind: 'place_photo', placeId, photoName }),
          }
        : {}),
      apiKey: placesKey,
      monthlySearches: Number(process.env['GENIE_PLACES_MONTHLY_SEARCHES'] ?? '300') || 300,
      monthlyPhotos: Number(process.env['GENIE_PLACES_MONTHLY_PHOTOS'] ?? '900') || 900,
      db,
    }),
    timeZone: schedules.tz,
  };
  const callConfig = callConfigFromEnv(process.env);
  const callStore = new CallStore(db);
  // グループの計画（Action Board）。LIFF の ID があれば LINE の中で開くリンク、無ければ公開の先頭（GENIE_PUBLIC_URL）の直のリンク
  const boards = new BoardStore(db);
  const boardUrl = boardUrlFor({
    publicUrl: callConfig.publicUrl,
    liffId: process.env['GENIE_LINE_LIFF_ID'] ?? null,
  });
  // 仕事の見通し（「今の作業どうなってる？」・保留・「これが終わったら〇〇して」）
  // 仕事のホーム（LINE から開くページ）。計画ボードと同じ LIFF の入口・公開の先頭を使う
  const workLinks = new WorkLinkStore(db);
  const workUrl = workUrlFor({
    publicUrl: callConfig.publicUrl,
    liffId: process.env['GENIE_LINE_LIFF_ID'] ?? null,
  });
  const desk = new WorkDesk({
    db,
    tasks,
    library,
    schedules: schedules.store,
    tz: schedules.tz,
    openHome: (principal) =>
      openHomeAnswer({ links: workLinks, urlFor: workUrl, principal, now: new Date() }),
    // 「今の作業どうなってる？」のカードのボタン
    homeLink: (principal) =>
      homeLinkFor({ links: workLinks, urlFor: workUrl, principal, now: new Date() }),
  });
  const personal = personalCommands({
    db,
    understand,
    timeZone: schedules.tz,
    groups,
    watches,
    desk,
    restaurants,
    callUsage: async ({ tenantId, userId }) =>
      callConfig.monthlyMinutes > 0
        ? {
            usedSeconds: await callStore.usedSeconds(tenantId, userId),
            monthlyMinutes: callConfig.monthlyMinutes,
          }
        : null,
  });
  const turnDepsRef: { current: TurnDeps | null } = { current: null };

  const app = buildApp({
    config,
    db,
    redis,
    rateLimiter,
    logger,
    tokens,
    tasks,
    library,
    registry,
    // Phase 2 の共有経路。渡し忘れると本番だけ 404 になる（実際に抜けていた）。
    shares,
    // UI/UX §15 の Evidence。読むだけなので db だけで足りる。
    evidence: new ResearchLedgerService(db),
    // 正本 §4.4: Dock を閉じても仕事が続くための調整役
    agentHosts: new AgentHostService({ db }),
    hostBridge: hostStepBridge,
    meetings: {
      meetings,
      recordings: new FsRecordingStore(config.recordingRoot),
      transcriber: meetingProviders.streaming,
    },
    dataSources,
    domain: { domain, definitions: entityDefinitions(assetReader(registry)) },
    world,
    work,
    conversations,
    connections,
    phone: phone.phone,
    channels: (turnDeps) => {
      chat.current = channelsFromEnv(process.env, {
        db,
        tasks,
        conversations,
        library,
        turnDeps,
        logger,
        understand,
        // グループ: 会話を覚え、呼ばれたら流れを踏まえて答える。場所・お店は実際に探す（個人の予定・メールは使わない）
        shared: householdChannels({
          db,
          understand,
          timeZone: schedules.tz,
          conversations,
          restaurants,
          boards: { store: boards, urlFor: boardUrl },
        }),
        onSpoken: (conversationId, text) => personal.rememberSpoken(conversationId, text),
        // 終わりの知らせから仕事のホームを開ける（公開の場所が無ければ Mac の作業一覧へ案内する）
        homeLink: (tenantId, userId) =>
          homeLinkFor({
            links: workLinks,
            urlFor: workUrl,
            principal: { tenantId, userId },
            now: new Date(),
          }),
      });
      if (chat.current) {
        const { service, routes } = chat.current;
        groups.current = {
          postToGroup: (tenantId, ownerUserId, text) =>
            service.postToGroup(tenantId, ownerUserId, text),
          lastSaid: (tenantId, conversationId) => routes.store.lastSaid(tenantId, conversationId),
        };
      }
      return chat.current?.routes ?? null;
    },
    phoneConnections: { store: phone.store, clientOf: phone.clientOf },
    schedules,
    vocabulary: new VocabularyService(new VocabularyStore(db)),
    boards,
    media,
    understand: personal,
    workDesk: desk,
    workLinks,
    // ブラウザの引き継ぎ（Genie 専用のブラウザがログインの壁で止まったら、本人が LINE から操作する）
    handoffs: {
      store: new HandoffStore(db),
      hub: new HandoffHub(),
      urlFor: handoffUrlFor({
        publicUrl: callConfig.publicUrl,
        liffId: process.env['GENIE_LINE_LIFF_ID'] ?? null,
      }),
      notify: async (tenantId, userId, text) =>
        (await chat.current?.service.notifyUser(tenantId, userId, null, text)) === 'delivered',
    },
    // 予定を読む・ずらす・元に戻す（直前の一覧と変更は、この会話の仕事と成果物から引く）
    calendar: calendarTurnDeps({ tasks, library, timeZone: schedules.tz }),
    onTurnDeps: (turnDeps) => {
      turnDepsRef.current = turnDeps;
    },
    voice: {
      ...(meetingProviders.batch.isStandIn ? {} : { transcriber: meetingProviders.batch }),
      ...(process.env['GOOGLE_CLOUD_PROJECT']
        ? { tts: new GoogleTtsProvider({ projectId: process.env['GOOGLE_CLOUD_PROJECT'] }) }
        : {}),
    },
  });

  const runner: ScheduleRunner | null = turnDepsRef.current
    ? scheduleRunner({
        schedules,
        turnDeps: turnDepsRef.current,
        tasks,
        channels: chat.current?.service ?? null,
        logger,
      })
    : null;

  // 保留の日の知らせと、前の仕事が終わった頼みを始める見回り。頼むときは予約と同じ入口（handleTurn）
  const deskWatch: WorkDeskWatch | null = turnDepsRef.current
    ? new WorkDeskWatch({
        db,
        tz: schedules.tz,
        run: async ({ tenantId, userId, conversationId, text, turnId }) => {
          const result = await handleTurn(turnDepsRef.current!, {
            principal: { tenantId, userId },
            conversationId,
            body: SendTurnRequest.parse({ text: text.slice(0, 8_000), modality: 'text' }),
            turnId,
            scheduled: true,
          });
          return result.kind === 'clarification' || result.kind === 'answered'
            ? { taskId: null, answer: result.answer.text }
            : { taskId: result.taskId ?? null, answer: null };
        },
        notifyChat: async (tenantId, userId, conversationId, text) => {
          await chat.current?.service.notifyUser(tenantId, userId, conversationId, text);
        },
        log: (event, detail) => logger.info(detail, event),
      })
    : null;

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, 'shutting down');
    runner?.stop();
    deskWatch?.stop();
    watches.stop();
    agentWatch.stop();
    phone.inbound?.stop();
    chat.current?.stop();
    await app.close();
    await rateLimiter.close();
    await runtime.close();
    await db.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  await app.listen({ port: config.port, host: config.host });
  // 受けた電話を仕事にする。60 秒ごと（Oathra の着信は数分単位なので十分）
  phone.inbound?.start(60_000);
  // 受け付けた仕事の区切り（承認待ち・終わり）をチャットへ返す。5 秒ごと
  chat.current?.start(5_000);
  // 予約の見回り。15 秒ごと（寝ていた Mac が起きたら、最初の見回りで追いつく）
  runner?.start(15_000);
  // opencode の見守り。30 秒ごとに、時間が来たものだけ見る
  watches.start(30_000);
  // ほかの AI の知らせ。15 秒ごとに、見る時刻が来たセッションだけ見る
  agentWatch.start(15_000);
  // 保留の日・前の仕事を待つ頼み。15 秒ごと
  deskWatch?.start(15_000);
  logger.info({ schedules: runner ? 'on' : 'off', tz: schedules.tz }, 'schedules');
  logger.info({ channels: chat.current ? 'on' : 'off' }, 'chat channels');
  logger.info(
    {
      port: config.port,
      env: config.env,
      plugins_dir: config.builtinPluginsDir,
      object_store: config.objectStoreRoot,
    },
    'api-gateway listening',
  );
}

main().catch((error: unknown) => {
  // ここで落ちるのは起動不能。握りつぶさず終了コードで知らせる。
  console.error(error);
  process.exit(1);
});
