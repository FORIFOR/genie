import { z } from 'zod';
import {
  AgentTeamCapability,
  CapabilityRouter,
  LaunchloomCapability,
} from '@genie/service-capabilities';
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

export function reachmadeRouterFromEnv(env: NodeJS.ProcessEnv = process.env): CapabilityRouter {
  const capabilities = [];
  const allowRemote = env['REACHMADE_ALLOW_REMOTE_CAPABILITIES'] === 'true';
  const agentTeamUrl = env['REACHMADE_AGENT_TEAM_URL'];
  if (agentTeamUrl) {
    const authorization = env['REACHMADE_AGENT_TEAM_AUTHORIZATION'];
    capabilities.push(new AgentTeamCapability({
      baseUrl: agentTeamUrl,
      allowRemote,
      ...(authorization ? { headers: { authorization } } : {}),
    }));
  }
  const launchloomUrl = env['REACHMADE_LAUNCHLOOM_URL'];
  if (launchloomUrl) {
    const token = env['REACHMADE_LAUNCHLOOM_TOKEN'] ?? env['LAUNCHLOOM_TOKEN'];
    capabilities.push(new LaunchloomCapability({
      baseUrl: launchloomUrl,
      allowRemote,
      ...(token ? { token } : {}),
    }));
  }
  return new CapabilityRouter(capabilities);
}

export function registerReachmadeRoutes(app: App, deps: ReachmadeRouteDeps): void {
  const unavailable = (reply: { status(code: number): { send(body: unknown): unknown } }) =>
    reply.status(503).send({
      code: 'reachmade_capabilities_not_configured',
      message: 'Configure REACHMADE_AGENT_TEAM_URL and/or REACHMADE_LAUNCHLOOM_URL.',
    });

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

  app.post('/v1/reachmade/route', async (request, reply) => {
    requirePrincipal();
    if (deps.router.list().length === 0) return unavailable(reply);
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

  app.post('/v1/reachmade/plan', async (request, reply) => {
    requirePrincipal();
    if (deps.router.list().length === 0) return unavailable(reply);
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

  app.post('/v1/reachmade/execute', async (request, reply) => {
    requirePrincipal();
    if (deps.router.list().length === 0) return unavailable(reply);
    const intent = Intent.parse(request.body ?? {});
    // The adapters enforce the final side-effect boundary. Launchloom never calls
    // release/publication/submit and stops at its review gate unless approvePlan
    // was explicitly provided by the authenticated caller.
    return deps.router.execute(intent);
  });
}
