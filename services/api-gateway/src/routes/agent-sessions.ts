/**
 * ほかの AI に頼んだ仕事の見守りの HTTP 表面（agent-sessions.ts）。
 *
 *   POST   /v1/agent-connections               hooks の鍵を発行する（本人。平文はこの応答だけ）
 *   GET    /v1/agent-connections               発行した鍵の一覧（平文は出さない）
 *   DELETE /v1/agent-connections/:id           鍵を取り消す
 *   POST   /v1/agent-events/claude-code        Claude Code の hooks の受け口（鍵で名乗る。ログインは要らない）
 *   GET    /v1/agent-sessions                  Task Dock が見る一覧
 *   PATCH  /v1/agent-sessions/:id              本人が止める（paused_by_user）・見守りに戻す（watch）
 *
 * 受け口は hooks の入力をそのまま受けるが、読むのは名前の決まった項目だけ（agent-sessions.ts の HookEvent）。
 * 受け口は常に速く返す。Claude Code の作業を Genie の都合で待たせない。
 */
import { GenieError } from '@genie/contracts';
import type { DbHandle } from '@genie/db';
import { z } from 'zod';
import type { App } from '../fastify.js';
import { requirePrincipal } from '../auth/middleware.js';
import { bearerToken } from '../auth/tokens.js';
import { AgentSessionStore, attentionFor, type AgentSession } from '../agent-sessions.js';

export interface AgentSessionRouteDeps {
  readonly db: DbHandle;
  readonly now?: () => Date;
}

const Connect = z.object({
  source: z.literal('claude_code'),
  label: z.string().trim().min(1).max(80).default('Claude Code'),
});
const Patch = z.object({ user_policy: z.enum(['watch', 'paused_by_user']) });

/** hooks の入力のうち読む項目だけ。ほかの項目（道具の入出力・応答の本文など）は読まずに捨てる。 */
const ClaudeHook = z.object({
  hook_event_name: z.string().min(1).max(40),
  session_id: z.string().min(1).max(128),
  cwd: z.string().max(4096).optional(),
  prompt: z.string().optional(),
  notification_type: z.string().max(80).optional(),
  message: z.string().optional(),
  reason: z.string().optional(),
  error: z.string().optional(),
  // 確かめ（変更・テスト）の判定にだけ読む。コマンドの文は残さない
  tool_name: z.string().max(80).optional(),
  // 形は道具ごとに違う。形が合わなくても出来事ごと捨てない
  tool_input: z.unknown().optional(),
});

const commandOf = (input: unknown): string | undefined => {
  const command = (input as { command?: unknown } | null)?.command;
  return typeof command === 'string' ? command : undefined;
};

/** hooks の入力は道具の出力を含むので大きくなり得る。読まない部分も受けきってから捨てる。 */
const HOOK_BODY_LIMIT = 16 * 1024 * 1024;

function view(s: AgentSession, now: number) {
  return {
    id: s.id,
    source: s.source,
    external_session_id: s.externalSessionId,
    project: s.project,
    title: s.title,
    state: s.state,
    waiting_reason: s.waitingReason,
    user_policy: s.userPolicy,
    attention: attentionFor(s, now),
    // hooks で届いた出来事から決めた状態は confirmed。静かさから推した「止まっているかも」は inferred
    confidence: ['stalled_suspected', 'unknown'].includes(attentionFor(s, now))
      ? 'inferred'
      : 'confirmed',
    // none / changed（変えたが確かめていない）/ passed / failed
    check_state: s.checkState,
    held: s.heldBy !== null,
    last_event: s.lastEvent,
    last_activity_at: s.lastActivityAt.toISOString(),
    ended_at: s.endedAt?.toISOString() ?? null,
    end_reason: s.endReason,
    created_at: s.createdAt.toISOString(),
  };
}

export function registerAgentSessionRoutes(app: App, deps: AgentSessionRouteDeps): void {
  const store = new AgentSessionStore(deps.db, deps.now);
  const now = () => (deps.now ?? (() => new Date()))().getTime();

  app.post('/v1/agent-connections', async (request, reply) => {
    const principal = requirePrincipal();
    const body = Connect.parse(request.body ?? {});
    const issued = await store.connect({
      tenantId: principal.tenantId,
      userId: principal.userId,
      source: body.source,
      label: body.label,
    });
    reply.code(201);
    return { id: issued.id, source: body.source, label: body.label, token: issued.token };
  });

  app.get('/v1/agent-connections', async () => {
    const principal = requirePrincipal();
    const rows = await store.connections(principal.tenantId, principal.userId);
    return {
      items: rows.map((r) => ({
        id: r.id,
        source: r.source,
        label: r.label,
        last_seen_at: r.last_seen_at ? new Date(r.last_seen_at).toISOString() : null,
        created_at: new Date(r.created_at).toISOString(),
      })),
    };
  });

  app.delete<{ Params: { id: string } }>('/v1/agent-connections/:id', async (request, reply) => {
    const principal = requirePrincipal();
    const id = z.uuid().parse(request.params.id);
    if (!(await store.revoke(principal.tenantId, principal.userId, id)))
      throw new GenieError('common.not_found', 'connection not found');
    reply.code(204);
    return null;
  });

  app.post(
    '/v1/agent-events/claude-code',
    { config: { auth: false, rateLimit: false }, bodyLimit: HOOK_BODY_LIMIT },
    async (request, reply) => {
      const token = bearerToken(request.headers.authorization);
      const connection = token ? await store.identify(token) : null;
      if (!connection || connection.source !== 'claude_code')
        throw new GenieError('auth.invalid_token', 'unknown agent connection');
      const parsed = ClaudeHook.safeParse(request.body);
      // 形の違う出来事は受け取ったことにして捨てる（hooks を失敗させて Claude Code に何かを出させない）
      if (!parsed.success) {
        reply.code(202);
        return { accepted: false };
      }
      const h = parsed.data;
      await store.record(connection, {
        event: h.hook_event_name,
        sessionId: h.session_id,
        ...(h.cwd === undefined ? {} : { cwd: h.cwd }),
        ...(h.prompt === undefined ? {} : { prompt: h.prompt }),
        ...(h.notification_type === undefined ? {} : { notificationType: h.notification_type }),
        ...(h.message === undefined ? {} : { message: h.message }),
        ...(h.reason === undefined ? {} : { reason: h.reason }),
        ...(h.error === undefined ? {} : { error: h.error }),
        ...(h.tool_name === undefined ? {} : { toolName: h.tool_name }),
        ...(typeof commandOf(h.tool_input) === 'string'
          ? { command: commandOf(h.tool_input)! }
          : {}),
      });
      reply.code(202);
      return { accepted: true };
    },
  );

  app.get('/v1/agent-sessions', async () => {
    const principal = requirePrincipal();
    const sessions = await store.list(principal.tenantId, principal.userId);
    const at = now();
    return { items: sessions.map((s) => view(s, at)) };
  });

  app.patch<{ Params: { id: string } }>('/v1/agent-sessions/:id', async (request) => {
    const principal = requirePrincipal();
    const id = z.uuid().parse(request.params.id);
    const body = Patch.parse(request.body ?? {});
    const session = await store.setPolicy(
      principal.tenantId,
      principal.userId,
      id,
      body.user_policy,
    );
    if (!session) throw new GenieError('common.not_found', 'session not found');
    return view(session, now());
  });
}
