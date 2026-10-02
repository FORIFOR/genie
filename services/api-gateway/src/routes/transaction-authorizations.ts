/** Human-facing bounded consent. These routes are deliberately not model tools. */
import { z } from 'zod';
import {
  canonicalSha256,
  GenieError,
  TransactionAuthorizationSpec,
  validateTransactionSubmitArgs,
} from '@genie/contracts';
import { withTenant, type DbHandle } from '@genie/db';
import { TransactionAuthorizationService, type TaskService } from '@genie/service-task';
import { requirePrincipal } from '../auth/middleware.js';
import type { App } from '../fastify.js';

const Create = z
  .object({
    requestId: z.uuid(),
    spec: TransactionAuthorizationSpec,
    approvalId: z.uuid().optional(),
  })
  .strict();

export function registerTransactionAuthorizationRoutes(
  app: App,
  deps: { db: DbHandle; tasks: TaskService },
): void {
  const service = new TransactionAuthorizationService({ db: deps.db });

  app.get('/v1/transaction-authorizations', async () => {
    const { tenantId, userId } = requirePrincipal();
    return { items: await service.list(tenantId, userId) };
  });

  app.post('/v1/transaction-authorizations', async (request) => {
    const { tenantId, userId } = requirePrincipal();
    const body = Create.parse(request.body);
    // Creation, first-order quota reservation and exact approval are one transaction.
    const result = await service.create({
      tenantId,
      userId,
      requestId: body.requestId,
      spec: body.spec,
      ...(body.approvalId ? { approvalId: body.approvalId } : {}),
    });
    if (result.approvalId) {
      // Retrying the same request resumes the same approval; it never issues another grant.
      await deps.tasks.resumeAuthorizedApproval(tenantId, userId, result.approvalId);
    }
    return result;
  });

  app.post<{ Params: { authorizationId: string } }>(
    '/v1/transaction-authorizations/:authorizationId/revoke',
    async (request) => {
      const { tenantId, userId } = requirePrincipal();
      const authorizationId = z.uuid().parse(request.params.authorizationId);
      return { authorization: await service.revoke({ tenantId, userId, authorizationId }) };
    },
  );

  app.get<{ Params: { approvalId: string } }>(
    '/v1/approvals/:approvalId/transaction-context',
    async (request) => {
      const { tenantId, userId } = requirePrincipal();
      const approvalId = z.uuid().parse(request.params.approvalId);
      const row = await withTenant(deps.db, tenantId, (tx) =>
        tx
          .selectFrom('approvals as a')
          .innerJoin('tasks as t', 't.id', 'a.task_id')
          .select(['a.details', 'a.expires_at'])
          .where('a.id', '=', approvalId)
          .where('a.status', '=', 'PENDING')
          .where('a.risk', '=', 'FINANCIAL')
          .where('t.created_by', '=', userId)
          .where('t.kind', '=', 'transaction.order')
          .where('t.status', '=', 'WAITING_APPROVAL')
          .executeTakeFirst(),
      );
      if (!row || row.expires_at.getTime() <= Date.now())
        throw new GenieError('common.not_found', 'no current transaction approval');
      const details = row.details as Record<string, unknown>;
      const args = await validateTransactionSubmitArgs(
        details['transactionSubmitArgs'],
        Date.now(),
      ).catch(() => {
        throw new GenieError('common.not_found', 'no valid transaction context');
      });
      if (
        args.intent.mode !== 'simulation' ||
        (await canonicalSha256(args)) !== details['inputsHash']
      )
        throw new GenieError('common.not_found', 'no delegable transaction approval');
      return args;
    },
  );
}
