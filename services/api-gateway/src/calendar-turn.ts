/**
 * 予定の頼み（conversation の calendar-intent）に要るものを、仕事と成果物から引く（仕様 v1.0 §11）。
 *
 *   直前に出した一覧 … この会話で最後に済んだ calendar.agenda の成果物（JSON の events）
 *   直前の変更       … この会話で最後に済んだ calendar.move の入力（変える前・後）
 *
 * どちらも 2 日より前のものは使わない（「元に戻して」が先週の変更を戻さない）。
 */
import type { ListedEvent, TurnCalendar } from '@genie/service-conversation';
import type { LibraryService } from '@genie/service-library';
import type { TaskService } from '@genie/service-task';
import { readArtifactBody } from './channels.js';

const RECENT_MS = 2 * 24 * 3600 * 1000;

export function calendarTurnDeps(deps: {
  readonly tasks: Pick<TaskService, 'latestCompleted'>;
  readonly library: LibraryService;
  readonly timeZone: string;
  readonly now?: () => Date;
}): TurnCalendar {
  const now = deps.now ?? (() => new Date());
  const latest = (tenantId: string, conversationId: string, kind: string) =>
    deps.tasks.latestCompleted(
      tenantId,
      conversationId,
      kind,
      new Date(now().getTime() - RECENT_MS),
    );
  return {
    timeZone: deps.timeZone,
    now,
    async latestAgenda(tenantId, conversationId) {
      const row = await latest(tenantId, conversationId, 'calendar.agenda');
      if (!row?.result_artifact_id) return null;
      const body = await readArtifactBody(deps.library, tenantId, row.result_artifact_id);
      try {
        const card = JSON.parse(body ?? '') as { events?: ListedEvent[] };
        return Array.isArray(card.events) ? card.events : null;
      } catch {
        return null;
      }
    },
    async latestMove(tenantId, conversationId) {
      const row = await latest(tenantId, conversationId, 'calendar.move');
      return (row?.input as Record<string, unknown> | undefined) ?? null;
    },
  };
}
