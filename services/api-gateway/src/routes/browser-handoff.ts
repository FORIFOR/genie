/**
 * ブラウザの引き継ぎ（src/browser-handoff.ts）。
 *
 * 端末（サインイン済みの Mac の Genie。その step を取っている端末だけ）:
 *   POST /v1/browser-handoffs                 引き継ぎを始める（本人に LINE でリンクを送る）
 *   POST /v1/browser-handoffs/:id/frame       画面の 1 枚（メモリで取り次ぐだけ）
 *   POST /v1/browser-handoffs/:id/inputs      本人の操作を取りに来る（長く待つ問い合わせ）
 *   POST /v1/browser-handoffs/:id/end         終わり（ログインが済んで続けた・時間切れ・失敗）
 * 本人（LINE のリンク。サインインの代わりにリンクの秘密）:
 *   GET  /v1/channels/handoff/:token          操作のページ
 *   WS   /v1/channels/handoff/:token/ws       画面の流れを受け、操作を送る
 *   LINE の中では、計画ボードの LIFF の入口（/v1/channels/board?liff.state=/h/<リンク>）から移ってくる
 */
import { z } from 'zod';
import { GenieError } from '@genie/contracts';
import type { HostBridge } from '@genie/service-agent-host';
import type { TaskService } from '@genie/service-task';
import type { App } from '../fastify.js';
import { requirePrincipal } from '../auth/middleware.js';
import {
  HandoffInput,
  handoffNotice,
  type HandoffHub,
  type HandoffStore,
} from '../browser-handoff.js';
import { handoffPage } from '../browser-handoff-page.js';

const TOKEN = /^[A-Za-z0-9_-]{32}$/;
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HOST = /^(?=.{1,253}$)[a-z0-9-]+(?:\.[a-z0-9-]+)+$/;

const pageHeaders = {
  'cache-control': 'no-store',
  'referrer-policy': 'no-referrer',
  'x-robots-tag': 'noindex',
};

const Start = z
  .object({ request_id: z.string().regex(ID), host_id: z.string().regex(ID), site: z.string() })
  .strict();
const Frame = z
  .object({
    host_id: z.string().regex(ID),
    // 画面の 1 枚（JPEG を base64。おおよそ 700 KB まで）
    jpeg: z.string().min(4).max(950_000),
    width: z.number().int().min(1).max(4000),
    height: z.number().int().min(1).max(8000),
    password: z.boolean(),
  })
  .strict();
const Take = z
  .object({ host_id: z.string().regex(ID), wait_ms: z.number().int().min(0).max(25_000) })
  .strict();
const End = z
  .object({
    host_id: z.string().regex(ID),
    state: z.enum(['resumed', 'timed_out', 'cancelled', 'failed']),
  })
  .strict();

export interface HandoffRouteDeps {
  readonly store: HandoffStore;
  readonly hub: HandoffHub;
  readonly bridge: Pick<HostBridge, 'get'>;
  readonly tasks: Pick<TaskService, 'get'>;
  readonly urlFor: (token: string) => string | null;
  /** 本人への知らせ（LINE の 1 対 1）。届けられなければ false。 */
  readonly notify: (tenantId: string, userId: string, text: string) => Promise<boolean>;
  readonly now?: () => Date;
}

interface ViewerSocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  on(event: string, listener: (...args: unknown[]) => void): void;
}

export function registerHandoffHostRoutes(app: App, deps: HandoffRouteDeps): void {
  /** 引き継ぎがこの端末（とその本人）のものか。違えば 404。 */
  const mine = async (id: string, hostId: string) => {
    const principal = requirePrincipal();
    const row = ID.test(id) ? await deps.store.get(principal.tenantId, id) : null;
    if (!row || row.userId !== principal.userId || row.hostId !== hostId)
      throw new GenieError('common.not_found', 'no such handoff');
    return row;
  };

  app.post('/v1/browser-handoffs', async (request, reply) => {
    const principal = requirePrincipal();
    const body = Start.parse(request.body ?? {});
    const site = body.site.toLowerCase();
    if (!HOST.test(site))
      throw new GenieError('common.validation_failed', 'site must be a host name');
    // その step を、いまこの端末が取っていること（ほかの端末・ほかの人の仕事では始めない）
    const step = await deps.bridge.get(principal.tenantId, body.request_id);
    if (
      !step ||
      step.status !== 'CLAIMED' ||
      step.hostId !== body.host_id ||
      step.toolId !== 'browser.read_page'
    )
      throw new GenieError('common.not_found', 'no such step');
    const task = await deps.tasks.get(principal.tenantId, step.taskId).catch(() => null);
    if (!task || task.created_by !== principal.userId)
      throw new GenieError('common.not_found', 'no such step');
    // 開ける場所（トンネル・LIFF）が無ければ、引き継ぎは作らない（開けないリンクを送らない）
    if (!deps.urlFor('x'.repeat(32))) return reply.status(409).send({ error: 'no_public_place' });
    const made = await deps.store.create({
      tenantId: principal.tenantId,
      userId: principal.userId,
      taskId: step.taskId,
      requestId: body.request_id,
      hostId: body.host_id,
      site,
      now: deps.now?.() ?? new Date(),
    });
    deps.hub.open(made.id, made.expiresAt);
    const delivered = await deps
      .notify(principal.tenantId, principal.userId, handoffNotice(site, deps.urlFor(made.token)!))
      .catch(() => false);
    if (!delivered) {
      // 届けられなければ、待っても誰も来ない。すぐに終える
      deps.hub.end(made.id, 'failed');
      await deps.store.end(principal.tenantId, made.id, 'failed');
      return reply.status(409).send({ error: 'not_delivered' });
    }
    return reply.status(201).send({ id: made.id, expires_at: made.expiresAt.toISOString() });
  });

  app.post<{ Params: { id: string } }>(
    '/v1/browser-handoffs/:id/frame',
    { bodyLimit: 1024 * 1024 },
    async (request, reply) => {
      const body = Frame.parse(request.body ?? {});
      const row = await mine(request.params.id, body.host_id);
      const open = deps.hub.frame(row.id, {
        jpeg: body.jpeg,
        width: body.width,
        height: body.height,
        password: body.password,
      });
      return reply.status(open ? 204 : 410).send();
    },
  );

  app.post<{ Params: { id: string } }>('/v1/browser-handoffs/:id/inputs', async (request) => {
    const body = Take.parse(request.body ?? {});
    const row = await mine(request.params.id, body.host_id);
    const taken = await deps.hub.take(row.id, body.wait_ms);
    if (!taken) return { inputs: [], ended: row.state === 'waiting' ? 'timed_out' : row.state };
    return { inputs: taken.inputs, ended: taken.ended };
  });

  app.post<{ Params: { id: string } }>('/v1/browser-handoffs/:id/end', async (request, reply) => {
    const body = End.parse(request.body ?? {});
    const row = await mine(request.params.id, body.host_id);
    deps.hub.end(row.id, body.state);
    await deps.store.end(row.tenantId, row.id, body.state);
    return reply.status(204).send();
  });
}

/** 本人のページと WebSocket（WebSocket の読み込みが済んだスコープで登録する）。 */
export function registerHandoffViewerRoutes(app: App, deps: HandoffRouteDeps): void {
  const config = {
    auth: false,
    rateLimit: { limit: 120, windowMs: 60_000, by: 'ip', bucket: 'channel-handoff' },
  } as const;
  const handoff = (token: string) =>
    TOKEN.test(token) ? deps.store.byToken(token) : Promise.resolve(null);

  app.get<{ Params: { token: string } }>(
    '/v1/channels/handoff/:token',
    { config },
    async (request, reply) => {
      const found = await handoff(request.params.token);
      return reply
        .status(found && deps.hub.isOpen(found.id) ? 200 : 410)
        .headers({ ...pageHeaders, 'content-type': 'text/html; charset=utf-8' })
        .send(handoffPage());
    },
  );

  app.get<{ Params: { token: string } }>(
    '/v1/channels/handoff/:token/ws',
    { websocket: true, config: { auth: false, rateLimit: false } },
    (connection, request) => {
      const socket = connection as unknown as ViewerSocket;
      void (async () => {
        const found = await handoff(request.params.token).catch(() => null);
        const stop = found
          ? deps.hub.watch(found.id, (message) => {
              try {
                socket.send(JSON.stringify(message));
              } catch {
                /* もう閉じている */
              }
            })
          : null;
        if (!found || !stop) {
          socket.send(JSON.stringify({ type: 'ended', state: 'timed_out' }));
          socket.close(1008, 'gone');
          return;
        }
        // 速すぎる送り（1 秒に 30 回を超える）は捨てる
        let windowStart = Date.now();
        let count = 0;
        socket.on('message', (raw: unknown) => {
          const now = Date.now();
          if (now - windowStart > 1000) {
            windowStart = now;
            count = 0;
          }
          if (++count > 30) return;
          let parsed: unknown;
          try {
            parsed = JSON.parse(String(raw));
          } catch {
            return;
          }
          const input = HandoffInput.safeParse(parsed);
          if (input.success) deps.hub.push(found.id, input.data);
        });
        socket.on('close', () => stop());
      })();
    },
  );
}
