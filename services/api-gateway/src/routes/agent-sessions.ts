/**
 * ほかの AI に頼んだ仕事の見守りの HTTP 表面（agent-sessions.ts）。
 *
 *   POST   /v1/agent-connections               hooks の鍵を発行する（本人。平文はこの応答だけ）
 *   GET    /v1/agent-connections               発行した鍵の一覧（平文は出さない）
 *   DELETE /v1/agent-connections/:id           鍵を取り消す
 *   POST   /v1/agent-events/claude-code        Claude Code の hooks の受け口（鍵で名乗る。ログインは要らない）
 *   POST   /v1/agent-approvals/claude-code     Claude Code が許可を求めた → 本人の LINE にカード（agent-approvals.ts）
 *   POST   /v1/agent-approvals/:id/wait        hooks が LINE の答えを取りに来る（長く待つ問い合わせ）
 *   POST   /v1/agent-jobs                      仕事を頼む（hooks の鍵で名乗る。scripts/agent-job.mjs）
 *   GET    /v1/agent-jobs                      仕事の一覧と「今どうなってる」の文
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
import { hookOutput, type AgentApprovals } from '../agent-approvals.js';
import { JobRefused, type AgentJobs } from '../agent-jobs.js';

export interface AgentSessionRouteDeps {
  readonly db: DbHandle;
  /** LINE からの承認（チャットをつないでいなければ無い。hooks は Mac の問いに任せる）。 */
  readonly approvals?: AgentApprovals;
  /** エージェントの仕事（セッションを仕事に結び付ける・仕事を頼む）。 */
  readonly jobs?: AgentJobs;
  readonly now?: () => Date;
}

const PermissionAsk = z.object({
  hook_event_name: z.literal('PermissionRequest'),
  session_id: z.string().min(1).max(128),
  cwd: z.string().max(4096).optional(),
  tool_name: z.string().min(1).max(80),
  tool_input: z.unknown(),
  prompt_id: z.string().max(128).optional(),
});
const Wait = z.object({ wait_ms: z.number().int().min(0).max(25_000) });

const Connect = z.object({
  source: z.literal('claude_code'),
  label: z.string().trim().min(1).max(80).default('Claude Code'),
});
const Patch = z.object({ user_policy: z.enum(['watch', 'paused_by_user']) });
const JobBody = z.object({
  agent: z.enum(['claude_code', 'codex', 'browser']).default('claude_code'),
  project_root: z.string().min(1).max(1024),
  request: z.string().trim().min(1).max(8000),
  title: z.string().trim().min(1).max(120).optional(),
  criteria: z
    .array(
      z.object({
        kind: z.enum(['command', 'artifact', 'manual', 'agent_review']),
        text: z.string().trim().min(1).max(200),
        spec: z.string().trim().min(1).max(1000).optional(),
      }),
    )
    .min(1)
    .max(20),
  after: z.array(z.number().int().positive()).max(20).optional(),
  max_attempts: z.number().int().min(1).max(3).optional(),
  max_minutes: z.number().int().min(1).max(240).optional(),
  max_turns: z.number().int().min(1).max(200).optional(),
  max_cost_usd: z.number().positive().max(50).optional(),
});

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
  // Stop の応答の最後の文。本人への問いかを見るだけで、残さない
  last_assistant_message: z.string().optional(),
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
      const session = await store.record(connection, {
        event: h.hook_event_name,
        sessionId: h.session_id,
        ...(h.cwd === undefined ? {} : { cwd: h.cwd }),
        ...(h.prompt === undefined ? {} : { prompt: h.prompt }),
        ...(h.notification_type === undefined ? {} : { notificationType: h.notification_type }),
        ...(h.message === undefined ? {} : { message: h.message }),
        ...(h.reason === undefined ? {} : { reason: h.reason }),
        ...(h.error === undefined ? {} : { error: h.error }),
        ...(h.last_assistant_message === undefined
          ? {}
          : { lastMessage: h.last_assistant_message }),
        ...(h.tool_name === undefined ? {} : { toolName: h.tool_name }),
        ...(typeof commandOf(h.tool_input) === 'string'
          ? { command: commandOf(h.tool_input)! }
          : {}),
      });
      // どの仕事のセッションか（本人が直接始めたものは、読むだけの仕事として取り込む）
      await deps.jobs
        ?.observe(connection.tenantId, connection.userId, session, h.cwd)
        .catch(() => undefined);
      // LINE に出した承認のうち、Mac で答え済みになったものを取り下げる
      await deps.approvals
        ?.observe(connection, {
          event: h.hook_event_name,
          sessionId: h.session_id,
          ...(h.tool_name === undefined ? {} : { toolName: h.tool_name }),
          toolInput: h.tool_input,
        })
        .catch(() => undefined);
      reply.code(202);
      return { accepted: true };
    },
  );

  /** hooks の鍵で名乗る（ログインは要らない）。 */
  const hookConnection = async (authorization: string | undefined) => {
    const token = bearerToken(authorization);
    const connection = token ? await store.identify(token) : null;
    if (!connection || connection.source !== 'claude_code')
      throw new GenieError('auth.invalid_token', 'unknown agent connection');
    return connection;
  };

  // 仕事を頼む。完了条件のない仕事は受けない
  app.post('/v1/agent-jobs', { config: { auth: false } }, async (request, reply) => {
    const connection = await hookConnection(request.headers.authorization);
    if (!deps.jobs) {
      reply.code(503);
      return { refused: 'agent jobs are off' };
    }
    const body = JobBody.parse(request.body);
    try {
      const job = await deps.jobs.create({
        tenantId: connection.tenantId,
        userId: connection.userId,
        agent: body.agent,
        projectRoot: body.project_root,
        request: body.request,
        criteria: body.criteria.map((c) => ({
          kind: c.kind,
          text: c.text,
          ...(c.spec === undefined ? {} : { spec: c.spec }),
        })),
        ...(body.title === undefined ? {} : { title: body.title }),
        ...(body.after === undefined ? {} : { after: body.after }),
        ...(body.max_attempts === undefined ? {} : { maxAttempts: body.max_attempts }),
        ...(body.max_minutes === undefined ? {} : { maxMinutes: body.max_minutes }),
        ...(body.max_turns === undefined ? {} : { maxTurns: body.max_turns }),
        ...(body.max_cost_usd === undefined ? {} : { maxCostUsd: body.max_cost_usd }),
      });
      void deps.jobs.tick();
      reply.code(201);
      return job;
    } catch (error) {
      if (error instanceof JobRefused) {
        reply.code(422);
        return { refused: error.message };
      }
      throw error;
    }
  });

  // LINE と同じ言い方で操作する（「仕事 3 を再開」。scripts/agent-job.mjs）
  app.post('/v1/agent-jobs/say', { config: { auth: false } }, async (request, reply) => {
    const connection = await hookConnection(request.headers.authorization);
    if (!deps.jobs) {
      reply.code(503);
      return { refused: 'agent jobs are off' };
    }
    const { text } = z.object({ text: z.string().trim().min(1).max(2100) }).parse(request.body);
    return { said: await deps.jobs.command(connection.tenantId, connection.userId, text) };
  });

  app.get('/v1/agent-jobs', { config: { auth: false } }, async (request, reply) => {
    const connection = await hookConnection(request.headers.authorization);
    if (!deps.jobs) {
      reply.code(503);
      return { refused: 'agent jobs are off' };
    }
    const jobs = await deps.jobs.list(connection.tenantId, connection.userId);
    return {
      summary: await deps.jobs.summary(connection.tenantId, connection.userId),
      items: jobs.map((j) => ({
        number: j.number,
        agent: j.agent,
        control: j.control,
        project: j.project,
        title: j.title,
        status: j.status,
        stop_reason: j.stop_reason,
        attempts: j.attempts,
      })),
    };
  });

  // 許可を求められた。
  //   本人の継続許可に当たれば 200 と、Claude Code へそのまま渡す JSON（その場で許可）
  //   LINE にカードを出せたら 201 と id（hooks は答えを待つ）
  //   出さないなら 204（Mac の問いだけ）
  app.post(
    '/v1/agent-approvals/claude-code',
    { config: { auth: false, rateLimit: false }, bodyLimit: HOOK_BODY_LIMIT },
    async (request, reply) => {
      const connection = await hookConnection(request.headers.authorization);
      const parsed = PermissionAsk.safeParse(request.body);
      if (!parsed.success || !deps.approvals) {
        request.log.info(
          { reason: parsed.success ? 'no_approvals' : 'malformed' },
          'agent_approval.not_asked',
        );
        return reply.code(204).send();
      }
      const made = await deps.approvals.request(connection, {
        sessionId: parsed.data.session_id,
        toolName: parsed.data.tool_name,
        toolInput: parsed.data.tool_input,
        ...(parsed.data.cwd === undefined ? {} : { cwd: parsed.data.cwd }),
        ...(parsed.data.prompt_id === undefined ? {} : { promptId: parsed.data.prompt_id }),
      });
      if (made.kind === 'none') return reply.code(204).send();
      if (made.kind === 'auto' && made.decision.behavior !== 'none')
        return reply
          .code(200)
          .header('content-type', 'application/json; charset=utf-8')
          .send(hookOutput(made.decision));
      if (made.kind !== 'asked') return reply.code(204).send();
      return reply.code(201).send({ id: made.id, expires_at: made.expiresAt.toISOString() });
    },
  );

  // 答え: 200 は Claude Code へそのまま渡す JSON。202 はまだ。204 はもう待たない（何も返さずに終える）
  app.post<{ Params: { id: string } }>(
    '/v1/agent-approvals/:id/wait',
    { config: { auth: false, rateLimit: false } },
    async (request, reply) => {
      const connection = await hookConnection(request.headers.authorization);
      const id = z.uuid().safeParse(request.params.id);
      const body = Wait.safeParse(request.body ?? {});
      if (!id.success || !body.success || !deps.approvals) return reply.code(204).send();
      const decision = await deps.approvals.wait(connection, id.data, body.data.wait_ms);
      if (decision === 'pending') return reply.code(202).send({ pending: true });
      if (decision.behavior === 'none') return reply.code(204).send();
      return reply
        .code(200)
        .header('content-type', 'application/json; charset=utf-8')
        .send(hookOutput(decision));
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
