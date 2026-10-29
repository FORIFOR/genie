/**
 * 仕事の見通しの HTTP 表面（work-desk.ts）。
 *
 *   GET /v1/work/overview   Task Dock の件数（実行中・要対応）と、「今の作業どうなってる？」と同じ答え
 *   GET /v1/work/holds      本人の保留
 *   GET /v1/work/ledger?session=<id> | ?task=<id>   仕事の台帳（work-ledger.ts）
 */
import { GenieError } from '@genie/contracts';
import { z } from 'zod';
import type { App } from '../fastify.js';
import { requirePrincipal } from '../auth/middleware.js';
import type { WorkDesk } from '../work-desk.js';

const LedgerQuery = z.union([
  z.object({ session: z.string().uuid() }).strict(),
  z.object({ task: z.string().uuid() }).strict(),
]);

export function registerWorkDeskRoutes(app: App, desk: WorkDesk): void {
  app.get('/v1/work/overview', async () => {
    const principal = requirePrincipal();
    const overview = await desk.overview(principal.tenantId, principal.userId);
    return {
      counts: {
        running: overview.counts.running,
        needs_user: overview.counts.needsUser,
        suspected: overview.counts.suspected,
        held: overview.counts.held,
        done_today: overview.counts.doneToday,
      },
      attention: overview.attention,
      text: overview.text,
    };
  });

  app.get('/v1/work/holds', async () => {
    const principal = requirePrincipal();
    const holds = await desk.holds.active(principal.tenantId, principal.userId);
    return {
      items: holds.map((h) => ({
        id: h.id,
        subject: h.subject,
        reason: h.reason,
        until_date: h.untilDate,
        created_at: h.createdAt.toISOString(),
      })),
    };
  });

  app.get('/v1/work/ledger', async (request) => {
    const principal = requirePrincipal();
    const query = LedgerQuery.safeParse(request.query);
    if (!query.success)
      throw new GenieError('common.validation_failed', 'give exactly one of session or task');
    const ledger =
      'session' in query.data
        ? await desk.ledger.forSession(principal.tenantId, principal.userId, query.data.session)
        : await desk.ledger.forTask(principal.tenantId, principal.userId, query.data.task);
    if (!ledger) throw new GenieError('common.not_found', 'work not found');
    return ledger;
  });
}
