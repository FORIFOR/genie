/**
 * 予約を gateway に繋ぐ。
 *
 *   GENIE_TIMEZONE   予約の時刻を読むタイムゾーン（既定 Asia/Tokyo）
 *
 * 会話で作った予約を、時間になったら動かす（15 秒ごとに見回る）。頼むときは Task Dock と同じ
 * handleTurn を予約の持ち主として呼ぶ。チャットで頼まれた予約の結果はチャットへ、そうでなければ
 * Mac へのお知らせ（GET /v1/notices）に残す。
 */
import { SendTurnRequest } from '@genie/contracts';
import type { ChannelService } from '@genie/service-channels';
import { handleTurn, type TurnDeps } from '@genie/service-conversation';
import {
  ScheduleRunner,
  ScheduleService,
  ScheduleStore,
  isValidTimeZone,
} from '@genie/service-schedule';
import type { TaskService } from '@genie/service-task';
import type { DbHandle } from '@genie/db';
import type { Logger } from '@genie/telemetry';

export function scheduleServiceFromEnv(env: NodeJS.ProcessEnv, db: DbHandle): ScheduleService {
  const tz = env['GENIE_TIMEZONE']?.trim() || 'Asia/Tokyo';
  if (!isValidTimeZone(tz)) throw new Error(`GENIE_TIMEZONE（${tz}）は IANA のタイムゾーン名にしてください。`);
  return new ScheduleService(new ScheduleStore(db), { tz });
}

export function scheduleRunner(deps: {
  readonly schedules: ScheduleService;
  readonly turnDeps: TurnDeps;
  readonly tasks: TaskService;
  readonly channels: ChannelService | null;
  readonly logger: Logger;
  readonly now?: () => number;
}): ScheduleRunner {
  return new ScheduleRunner({
    store: deps.schedules.store,
    turn: async (job, text, turnId) => {
      const result = await handleTurn(deps.turnDeps, {
        principal: { tenantId: job.tenantId, userId: job.userId },
        conversationId: job.conversationId,
        body: SendTurnRequest.parse({ text: text.slice(0, 8_000), modality: 'text' }),
        turnId,
        scheduled: true,
      });
      if (result.kind === 'clarification' || result.kind === 'answered')
        return { kind: 'answered', answer: result.answer.text };
      const task = result.taskId
        ? await deps.tasks.get(job.tenantId, result.taskId).catch(() => null)
        : null;
      return {
        kind: 'started',
        taskId: result.taskId,
        notice: result.notice,
        title: task?.title ?? null,
      };
    },
    ...(deps.channels
      ? {
          channels: {
            notify: (tenantId, conversationId, text) =>
              deps.channels!.notifyConversation(tenantId, conversationId, text),
            followTask: (tenantId, conversationId, taskId, title) =>
              deps.channels!.followTask(tenantId, conversationId, taskId, title),
          },
        }
      : {}),
    log: (event, detail) => deps.logger.info(detail, event),
    ...(deps.now ? { now: deps.now } : {}),
  });
}
