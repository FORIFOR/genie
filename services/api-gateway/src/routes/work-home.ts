/**
 * 仕事のホームのページ（src/work-home.ts・work-page.ts）。
 *
 *   GET /v1/channels/work/:token                 ページ（読むだけ）
 *   GET /v1/channels/work/:token/state           ホームの中身（JSON。ページが 15 秒ごとに読む）
 *   GET /v1/channels/work/:token/item/s/:id      Claude Code のセッションの台帳（頼みの頭は落とす）
 *   GET /v1/channels/work/:token/item/t/:id      Genie の仕事の台帳
 *   LINE の中では、計画ボードの LIFF の入口（/v1/channels/board?liff.state=/w/<リンク>）から移ってくる
 *
 * サインインの代わりにリンクの秘密（24 バイトの乱数、30 日。残すのはハッシュ）で守る。台帳は、
 * リンクの本人のものしか返さない（ほかの人の id を入れても 404）。
 */
import type { App } from '../fastify.js';
import type { WorkDesk } from '../work-desk.js';
import { composeHome, ledgerForPage, type WorkLinkStore } from '../work-home.js';
import { workPage } from '../work-page.js';

const TOKEN = /^[A-Za-z0-9_-]{32}$/;
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const pageHeaders = {
  'cache-control': 'no-store',
  'referrer-policy': 'no-referrer',
  'x-robots-tag': 'noindex',
};

export function registerWorkHomeRoutes(
  app: App,
  deps: { readonly desk: WorkDesk; readonly links: WorkLinkStore },
): void {
  const config = {
    auth: false,
    rateLimit: { limit: 120, windowMs: 60_000, by: 'ip', bucket: 'channel-work' },
  } as const;
  const owner = (token: string) =>
    TOKEN.test(token) ? deps.links.byToken(token) : Promise.resolve(null);

  app.get<{ Params: { token: string } }>(
    '/v1/channels/work/:token',
    { config },
    async (request, reply) => {
      const who = await owner(request.params.token);
      return reply
        .status(who ? 200 : 410)
        .headers({ ...pageHeaders, 'content-type': 'text/html; charset=utf-8' })
        .send(workPage());
    },
  );

  app.get<{ Params: { token: string } }>(
    '/v1/channels/work/:token/state',
    { config },
    async (request, reply) => {
      const who = await owner(request.params.token);
      if (!who) return reply.status(410).headers(pageHeaders).send({ error: 'gone' });
      return reply
        .headers(pageHeaders)
        .send(composeHome(await deps.desk.gather(who.tenantId, who.userId)));
    },
  );

  app.get<{ Params: { token: string; kind: string; id: string } }>(
    '/v1/channels/work/:token/item/:kind/:id',
    { config },
    async (request, reply) => {
      const who = await owner(request.params.token);
      if (!who) return reply.status(410).headers(pageHeaders).send({ error: 'gone' });
      const { kind, id } = request.params;
      const ledger = !ID.test(id)
        ? null
        : kind === 's'
          ? await deps.desk.ledger.forSession(who.tenantId, who.userId, id)
          : kind === 't'
            ? await deps.desk.ledger.forTask(who.tenantId, who.userId, id)
            : null;
      if (!ledger) return reply.status(404).headers(pageHeaders).send({ error: 'not_found' });
      return reply.headers(pageHeaders).send(ledgerForPage(ledger));
    },
  );
}
