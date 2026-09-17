import { z } from 'zod';
import type { CapabilityRouter } from '@genie/service-capabilities';
import type { App } from '../fastify.js';
import { requirePrincipal } from '../auth/middleware.js';

export interface ReachmadeRouteDeps {
  readonly router: CapabilityRouter;
}

const Intent = z.object({
  id: z.string().min(1).max(160),
  objective: z.string().min(1).max(8000),
  preferredCapability: z.string().min(1).max(120).optional(),
  inputs: z.record(z.string(), z.unknown()).optional(),
  maxWaitMs: z.number().int().positive().max(60 * 60 * 1000).optional(),
  dryRun: z.boolean().optional(),
}).strict();

export function registerReachmadeRoutes(app: App, deps: ReachmadeRouteDeps): void {
  app.get('/v1/reachmade/capabilities', async () => {
    requirePrincipal();
    return {
      items: deps.router.list().map((capability) => ({
        id: capability.id,
        display_name: capability.displayName,
        version: capability.version,
      })),
    };
  });

  app.post('/v1/reachmade/route', async (request) => {
    requirePrincipal();
    const intent = Intent.parse(request.body ?? {});
    const decision = deps.router.route(intent);
    return {
      capability: {
        id: decision.capability.id,
        display_name: decision.capability.displayName,
        version: decision.capability.version,
      },
      match: decision.match,
      considered: decision.considered,
    };
  });

  app.post('/v1/reachmade/plan', async (request) => {
    requirePrincipal();
    const intent = Intent.parse(request.body ?? {});
    const { decision, plan } = await deps.router.plan(intent);
    return {
      capability: {
        id: decision.capability.id,
        display_name: decision.capability.displayName,
        version: decision.capability.version,
      },
      match: decision.match,
      plan,
    };
  });

  app.post('/v1/reachmade/execute', async (request) => {
    requirePrincipal();
    const intent = Intent.parse(request.body ?? {});
    // The adapters themselves enforce the final side-effect boundary. In particular,
    // Launchloom never calls release/publication/submit and stops at its review gate
    // unless approvePlan was explicitly provided by the caller.
    return deps.router.execute(intent);
  });
}
