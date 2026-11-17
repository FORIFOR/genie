/**
 * カードの画像（src/media.ts）。LINE がカードを表示するときに取りに来る。
 *
 *   GET /v1/channels/media/:token   店の写真・地図（Google から取り直して返す。保存しない）
 *
 * サインインの代わりにリンクの秘密（24 バイトの乱数、7 日。残すのはハッシュ）で守る。
 * LINE の中継（scripts/line-webhook-relay.mjs）は、この道を外へ通す。
 */
import type { App } from '../fastify.js';
import type { MediaResolver } from '../media.js';

const TOKEN = /^[A-Za-z0-9_-]{32}$/;

export function registerMediaRoutes(app: App, deps: { readonly media: MediaResolver }): void {
  app.get<{ Params: { token: string } }>(
    '/v1/channels/media/:token',
    {
      config: {
        auth: false,
        rateLimit: { limit: 240, windowMs: 60_000, by: 'ip', bucket: 'channel-media' },
      },
    },
    async (request, reply) => {
      const image = TOKEN.test(request.params.token)
        ? await deps.media.fetch(request.params.token)
        : null;
      if (!image)
        return reply.status(404).header('cache-control', 'no-store').send({ error: 'not_found' });
      return reply
        .header('content-type', image.contentType)
        .header('cache-control', 'private, max-age=3600')
        .header('x-robots-tag', 'noindex')
        .header('referrer-policy', 'no-referrer')
        .send(Buffer.from(image.bytes));
    },
  );
}
