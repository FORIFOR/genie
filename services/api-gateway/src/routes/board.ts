/**
 * Action Board のページ（src/board.ts・board-page.ts）。
 *
 *   GET /v1/channels/board/:token         ページ（読むだけ）
 *   GET /v1/channels/board/:token/state   いまの計画（JSON。ページが 15 秒ごとに読む）
 *   GET /v1/channels/board?liff.state=/:token
 *                                         LINE の中で開く入口（LIFF）。そのページへ移るだけ
 *
 * サインインの代わりにリンクの秘密（24 バイトの乱数、30 日。残すのはハッシュ）で守る。
 * LINE の中継（scripts/line-webhook-relay.mjs）は、この 2 つの道だけを外へ通す。
 */
import type { App } from '../fastify.js';
import type { BoardStore } from '../board.js';
import { boardPage } from '../board-page.js';

const TOKEN = /^[A-Za-z0-9_-]{32}$/;
/**
 * LIFF が最初に開く URL の liff.state（「/<リンク>」。後ろにクエリが付くことがある）。
 * 「/w/<リンク>」は仕事のホーム（src/work-home.ts）。LIFF を 1 つで両方に使う。
 */
const LIFF_STATE = /^\/(?:(w|h)\/)?([A-Za-z0-9_-]{32})(?:[/?].*)?$/;
const LIFF_ID = /^\d+-[A-Za-z0-9]+$/;

/**
 * ボードのリンク。LIFF の ID（GENIE_LINE_LIFF_ID）があれば LINE の中で全画面で開く
 * https://liff.line.me/<ID>/<リンク>、無ければ公開の先頭（GENIE_PUBLIC_URL）の直のリンク。
 * LIFF のエンドポイント URL は <公開の先頭>/v1/channels/board にする（docs/LINE_GROUPS.ja.md）。
 */
export function boardUrlFor(config: {
  readonly publicUrl: string | null;
  readonly liffId: string | null;
}): (token: string) => string | null {
  const liffId = config.liffId?.trim() || null;
  if (liffId && LIFF_ID.test(liffId)) return (token) => `https://liff.line.me/${liffId}/${token}`;
  return (token) => (config.publicUrl ? `${config.publicUrl}/v1/channels/board/${token}` : null);
}

const pageHeaders = {
  'cache-control': 'no-store',
  'referrer-policy': 'no-referrer',
  'x-robots-tag': 'noindex',
};

export function registerBoardRoutes(app: App, deps: { readonly boards: BoardStore }): void {
  const config = {
    auth: false,
    rateLimit: { limit: 120, windowMs: 60_000, by: 'ip', bucket: 'channel-board' },
  } as const;

  // LIFF は、まずエンドポイント URL に ?liff.state=/<リンク> を付けて開く。そのページへ移す。
  // サーバーで 302 にせず、ページの中で移す（LIFF が URL の # に付ける値を次のページへ持ち越さない）
  app.get<{ Querystring: Record<string, string | undefined> }>(
    '/v1/channels/board',
    { config },
    async (request, reply) => {
      const state = LIFF_STATE.exec(request.query['liff.state'] ?? '');
      const token = state?.[2];
      if (!token)
        return reply
          .status(410)
          .headers({ ...pageHeaders, 'content-type': 'text/html; charset=utf-8' })
          .send(boardPage());
      // /w/ は仕事のホーム、/h/ はブラウザの引き継ぎ、無ければ計画ボード
      const target =
        state[1] === 'w'
          ? `/v1/channels/work/${token}`
          : state[1] === 'h'
            ? `/v1/channels/handoff/${token}`
            : `/v1/channels/board/${token}`;
      const title =
        state[1] === 'w' ? '仕事のホーム' : state[1] === 'h' ? 'ブラウザの操作' : 'みんなの計画';
      return reply
        .headers({ ...pageHeaders, 'content-type': 'text/html; charset=utf-8' })
        .send(
          `<!doctype html><meta charset="utf-8"><meta name="robots" content="noindex"><title>${title} — Genie</title><script>location.replace(${JSON.stringify(target)})</script>`,
        );
    },
  );

  app.get<{ Params: { token: string } }>(
    '/v1/channels/board/:token',
    { config },
    async (request, reply) => {
      const board = TOKEN.test(request.params.token)
        ? await deps.boards.byToken(request.params.token)
        : null;
      return reply
        .status(board ? 200 : 410)
        .headers({ ...pageHeaders, 'content-type': 'text/html; charset=utf-8' })
        .send(boardPage());
    },
  );

  app.get<{ Params: { token: string } }>(
    '/v1/channels/board/:token/state',
    { config },
    async (request, reply) => {
      const board = TOKEN.test(request.params.token)
        ? await deps.boards.byToken(request.params.token)
        : null;
      if (!board || board.status === 'closed')
        return reply.status(410).headers(pageHeaders).send({ error: 'gone' });
      return reply.headers(pageHeaders).send(await deps.boards.view(board));
    },
  );
}
