/**
 * Temporal worker の起動口。実装仕様 §6.2。
 *
 * 制御プレーン（api-gateway）とは別プロセスで動かす。ADR 0001 は
 * サービスを 1 プロセスに畳むと決めているが、worker は別枠にしてある:
 * ワークフローのサンドボックスと activity の実行を、HTTP の応答性と
 * 同じイベントループに乗せたくないため。
 */
import path from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';
import { NativeConnection } from '@temporalio/worker';
import { createDb, dbConfigFromEnv, withTenant, type DbHandle } from '@genie/db';
import { createLogger } from '@genie/telemetry';
import { FsObjectStore, LibraryService } from '@genie/service-library';
import {
  ResearchService,
  researchExecutors,
  generalExecutors,
  researchProvidersFromEnv,
  withModelContext,
} from '@genie/service-research';
import {
  FsRecordingStore,
  MeetingService,
  meetingExecutors,
  meetingProvidersFromEnv,
  HostMeetingSummarizer,
} from '@genie/service-meeting';
import {
  meetingArtifacts,
  WorkContextService,
  WorldModelService,
} from '@genie/service-world-model';
// 数え方は gateway と同じものを使う。別々に数えると片方だけ見落とす。
import { assertReadyForProduction, canonicalSha256 } from '@genie/contracts';
import { capabilityReport, capabilitySummary } from '@genie/service-capabilities';
import { ConnectionService } from '@genie/service-plugin-registry';
import { createTaskWorker, TASK_QUEUE, NoopPublisher } from '@genie/service-task';
import { HostBridge, HostStepExecutor, type ApprovalProof } from '@genie/service-agent-host';
import {
  DomainService,
  architectureExecutors,
  careExecutors,
  ehrExecutors,
  salesCrmExecutors,
  stockExecutors,
  videoExecutors,
} from '@genie/service-agent-runtime';

async function main(): Promise<void> {
  const logger = createLogger({
    service: 'task-worker',
    level: process.env['ASTRA_LOG_LEVEL'] ?? 'info',
    pretty: process.env['ASTRA_ENV'] === 'development',
  });

  const db = createDb(dbConfigFromEnv());
  // 相対パスは cwd 依存なので絶対化してから使う。gateway と同じ場所を指す必要がある。
  const objectStoreRoot = path.resolve(process.env['ASTRA_OBJECT_STORE_ROOT'] ?? './.data/objects');
  const library = new LibraryService(db, new FsObjectStore(objectStoreRoot));

  const address = process.env['TEMPORAL_ADDRESS'] ?? 'localhost:7233';
  const namespace = process.env['TEMPORAL_NAMESPACE'] ?? 'default';
  const taskQueue = process.env['ASTRA_TASK_QUEUE'] ?? TASK_QUEUE;

  /*
   * 手元でしか動かせない step の受け渡し。正本 §4.4・§16.1・§21。
   *
   * **cloud はここで実行しない。**connector のトークンも、利用者が
   * 持ち込んだモデルの利用権も、端末の側にある。cloud は置いて待つだけ。
   * 端末が居なければ `PAUSED_HOST_OFFLINE` で止まる（失敗にしない）。
   */
  const hostBridge = new HostBridge({ db });

  /**
   * いまどの step の中に居るか。
   *
   * 会議の要約は step の中で起きるので、受け渡しに載せる先が要る。
   * 調査の側は `setModelContext` が同じものを持つ。
   */
  type StepContext = { taskId: string; tenantId: string; userId: string; stepIndex: number };
  const here = new AsyncLocalStorage<StepContext>();
  const modelContext = (): StepContext | null => here.getStore() ?? null;

  const hostExecutor = new HostStepExecutor({
    bridge: hostBridge,
    // 承認の跡を持たせて、端末側にももう一度確かめさせる
    approvalFor: (where) => approvalProof(db, where),
  });

  /*
   * 設定されたものだけ本物になる。決まっていないものは代役のまま名乗る
   * （Phase 2 実装仕様 §1.1 / Phase 3 実装仕様 §1.1）。
   *
   * 言語モデルの行き先は factory が決める。**gateway と同じ関数を通す** —
   * ここで独自に決めていた間、worker は「本物」、gateway は「代役」と
   * 報告していた。同じ構成で二つの答えが出るなら、報告の意味が無い。
   */
  const researchProviders = researchProvidersFromEnv(process.env, { host: hostExecutor });
  const meetingProviders = await meetingProvidersFromEnv(process.env);

  /*
   * 本番で代役のまま動かさない。**何が代役なのかを名指しで言う。**
   *
   * 数え方は gateway と同じものを使う。別々に数えると、
   * 片方だけ新しい能力を見落とす（実際、gateway は言語モデルを見ていなかった）。
   */
  /*
   * gateway と同じものを見る。片方だけ観測すると、
   * 同じ構成で二つの面が違うことを言う（前に実際に起きた）。
   */
  const report = capabilityReport({
    research: researchProviders,
    meeting: meetingProviders,
    env: process.env,
    observed: { oauthConnected: await new ConnectionService({ db }).anyConnected() },
  });
  const { warn, blocked } = assertReadyForProduction(
    report,
    process.env['ASTRA_ENV'] ?? 'development',
  );
  /*
   * **全部を数え上げて出す。**代役だけを出していた間、
   * 本物になった能力はどこにも現れなかった。片方の面だけが
   * 本物になっても気づけない — 実際、worker と gateway が
   * 違うことを言っている状態が生まれていた。
   */
  logger.info({ capabilities: capabilitySummary(report) }, 'external capabilities');
  if (warn) logger.warn({ not_ready: blocked.map((r) => r.capability) }, warn);

  const research = new ResearchService({
    db,
    search: researchProviders.search,
    model: researchProviders.model,
  });

  const recordingRoot = path.resolve(process.env['ASTRA_RECORDING_ROOT'] ?? './.data/recordings');
  const meetings = new MeetingService({ db, publisher: NoopPublisher });

  const connection = await NativeConnection.connect({ address });
  const worker = await createTaskWorker(
    {
      db,
      library,
      publisher: NoopPublisher,
      hostExecutor,
      hosts: hostBridge,
      // step ごとに「いまここ」を置く。言語モデルはこの中から呼ばれる。
      withStepContext: (where, run) => here.run(where, () => withModelContext(where, run)),
      executors: {
        ...researchExecutors(research),
        /*
         * 正本 §2.2・§29。何をする話か決まらないときの受け皿。
         * **モデルは同じもの**を使う（利用者が持ち込んだ利用権）。
         */
        ...generalExecutors(researchProviders.model),
        /*
         * 正本 §15.2。**renderer は渡していない。**
         * 生成モデルが未決（OQ-19）なので、書き出しは
         * 「繋がっていない」と言って止まる。構成と字幕はそれでも作れる。
         */
        ...videoExecutors(new DomainService({ db })),
        // 正本 §15.4。書き込みは CARE profile の規則で確認と読み上げを通る。
        ...careExecutors(new DomainService({ db })),
        // 正本 §15.5。下書きが線を越えていたら、残さずに止める。
        ...ehrExecutors(new DomainService({ db })),
        // 正本 §15.6。どちらの版が正しいかは決めない。
        ...architectureExecutors(new DomainService({ db })),
        // 正本 §15.7。既定は下書きまで。証券会社へは繋がっていない。
        ...stockExecutors(new DomainService({ db })),
        /*
         * 正本 §15.3。**手元の記録だけ。**外部 CRM への接続は未決（OQ-20）。
         * 繋いでいないので、外から取ってきたふりはしない。
         */
        ...salesCrmExecutors(new DomainService({ db })),
        ...meetingExecutors({
          meetings,
          library,
          // 会議の結論を Work Graph へ（MEETING_WORK_LOOP）。id は安定、再 finalize でも増えない。
          sink: meetingArtifactSink(
            new WorkContextService({ db, world: new WorldModelService({ db }) }),
          ),
          recordings: new FsRecordingStore(recordingRoot),
          batch: meetingProviders.batch,
          /*
           * 要約も端末で。正本 §21、UI/UX §22。
           *
           * **会議の中身は、その会議に出た人のもの。**
           * Genie が預かる利用権で処理してよいものではない。
           * 自分の鍵が設定してあるならそちらを使う。
           */
          summarizer: meetingProviders.summarizer.isStandIn
            ? new HostMeetingSummarizer({
                host: hostExecutor,
                context: () => modelContext(),
                keyOf: canonicalSha256,
              })
            : meetingProviders.summarizer,
        }),
      },
    },
    { connection, namespace, taskQueue },
  );

  const shutdown = (signal: string): void => {
    logger.info({ signal }, 'shutting down the task worker');
    worker.shutdown();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  logger.info(
    { address, namespace, taskQueue, object_store: objectStoreRoot, recordings: recordingRoot },
    'task worker listening',
  );
  await worker.run();

  await connection.close();
  await db.close();
}

/**
 * その step の承認の跡を引く。正本 §9。
 *
 * **無ければ null。**作らない。ここで嘘の跡を組み立てると、
 * 端末側の検査が意味を失い、二重の錠が一重になる。
 */
async function approvalProof(
  db: DbHandle,
  where: { tenantId: string; taskId: string; stepIndex: number; toolId: string },
): Promise<ApprovalProof | null> {
  /*
   * 対応の無い tool には承認を渡さない。
   *
   * **渡してしまうと、端末側の検査が「承認あり」で素通しになる。**
   * 知らない tool は、そもそも端末が実行を断る側に倒す。
   */
  const operationId = OPERATION_FOR[where.toolId];
  if (!operationId) return null;

  const row = await withTenant(db, where.tenantId, (tx) =>
    tx
      .selectFrom('approvals')
      .select(['id', 'decided_by', 'decided_at', 'expires_at'])
      .where('task_id', '=', where.taskId)
      .where('step_index', '=', where.stepIndex)
      .where('status', '=', 'APPROVED')
      .executeTakeFirst(),
  );
  if (!row?.decided_by || !row.decided_at) return null;

  return {
    approvalId: row.id,
    operationId,
    decision: 'APPROVED',
    decidedBy: row.decided_by,
    decidedAt: row.decided_at.toISOString(),
    expiresAt: row.expires_at.toISOString(),
  };
}

/**
 * manifest の tool 名と、端末側の操作名の対応。
 *
 * 2 つの名前があるのは、manifest が製品の語彙（`mail.send`）で書かれ、
 * connector が提供者の語彙（`gmail.send`）で書かれているから。
 * **対応はここ 1 箇所に置く。**散らばると、承認が黙って効かなくなる。
 */
const OPERATION_FOR: Readonly<Record<string, string>> = {
  'mail.send': 'gmail.send',
  'outlook.mail.reply': 'outlook.mail.reply',
  'mail.trash': 'gmail.trash',
  'calendar.create_event': 'calendar.create',
  'computer.click': 'computer.click',
  'computer.type': 'computer.type',
  'computer.key': 'computer.key',
  'computer.run': 'computer.run',
  'intent.execute': 'intent.execute',
};

main().catch((error: unknown) => {
  // 起動不能。握りつぶさず終了コードで知らせる。
  console.error(error);
  process.exit(1);
});

/** 会議の bundle → 安定 id の artifact → work_artifacts（upsert）。 */
function meetingArtifactSink(work: WorkContextService) {
  return {
    async publish(input: {
      tenantId: string;
      userId: string;
      meeting: {
        id: string;
        title: string;
        started_at: string;
        ended_at: string | null;
        recording_artifact_id: string | null;
      };
      bundle: Parameters<typeof meetingArtifacts>[0]['bundle'];
      segments: Parameters<typeof meetingArtifacts>[0]['segments'];
      speakers: Parameters<typeof meetingArtifacts>[0]['speakers'];
    }): Promise<{ published: number }> {
      const artifacts = meetingArtifacts({
        meetingId: input.meeting.id,
        title: input.meeting.title,
        startedAt: input.meeting.started_at,
        endedAt: input.meeting.ended_at,
        bundle: input.bundle,
        segments: input.segments,
        speakers: input.speakers,
        projectHint: null,
        recordingArtifactId: input.meeting.recording_artifact_id,
        transcriptArtifactId: null,
        observedAt: new Date().toISOString(),
      });
      if (artifacts.length === 0) return { published: 0 };
      await work.ingest(input.tenantId, input.userId, {
        source: 'meeting',
        cursor: null,
        watermark: null,
        artifacts,
      });
      return { published: artifacts.length };
    },
  };
}
