/**
 * 通話のページと、その音声の WebSocket（src/call.ts）。
 *
 *   GET /v1/channels/call/:token      ページ（リンクがまだ使えるときだけ。開いただけでは使った印を付けない）
 *   GET /v1/channels/call/:token/ws   音声（つないだ時点でリンクを使い切る。1 回だけ）
 *     ?resume=<鍵>                    電波が切れたページが、45 秒以内に同じ通話へ戻る
 *
 * 認証の代わりにリンクの秘密（24 バイトの乱数。残すのはハッシュ）で守る。LINE の中継（scripts/line-webhook-relay.mjs）は
 * この 2 つの道だけを外へ通す。WebSocket のルートなので、websocket を登録したスコープで呼ぶ（app.ts）。
 */
import type { App } from '../fastify.js';
import {
  bridgeCall,
  joinCall,
  resumeCall,
  type CallBridgeDeps,
  type CallClientSocket,
  type CallRecord,
  type CallSession,
} from '../call.js';
import { callExpiredPage, callPage } from '../call-page.js';

export type CallRouteDeps = CallBridgeDeps & {
  /** 通話が終わったとき（LINE へ要約を送る）。 */
  readonly onEnded?: (session: CallSession, record: CallRecord) => void;
};

const TOKEN = /^[A-Za-z0-9_-]{32}$/;

export function registerCallRoutes(app: App, deps: CallRouteDeps): void {
  app.get<{ Params: { token: string } }>(
    '/v1/channels/call/:token',
    {
      config: {
        auth: false,
        rateLimit: { limit: 60, windowMs: 60_000, by: 'ip', bucket: 'channel-call' },
      },
    },
    async (request, reply) => {
      const token = request.params.token;
      const live = TOKEN.test(token) ? await deps.store.peek(token) : null;
      return reply
        .status(live ? 200 : 410)
        .header('content-type', 'text/html; charset=utf-8')
        .header('cache-control', 'no-store')
        .header('referrer-policy', 'no-referrer')
        .header('x-robots-tag', 'noindex')
        .send(live ? callPage() : callExpiredPage());
    },
  );

  app.get<{ Params: { token: string }; Querystring: { resume?: string } }>(
    '/v1/channels/call/:token/ws',
    { websocket: true, config: { auth: false, rateLimit: false } },
    (connection, request) => {
      const socket = connection as unknown as CallClientSocket;
      const token = request.params.token;
      if (!TOKEN.test(token)) {
        socket.close(1008, 'bad token');
        return;
      }
      // 電波が切れて戻ってきたページ。同じ通話に戻す（鍵が合わなければ断る）
      const resume = request.query.resume;
      if (typeof resume === 'string' && resume) {
        if (!resumeCall(socket, token, resume)) {
          socket.send(
            JSON.stringify({
              type: 'ended',
              reason: '通話はもう終わっています。LINE で「電話して」ともう一度送ってください。',
            }),
          );
          socket.close(1008, 'not resumable');
        }
        return;
      }
      // 家族の通話に 2 人目以降が入る（同じリンク）
      if (joinCall(socket, token)) return;
      bridgeCall(socket, token, deps).catch(() => {
        try {
          socket.close(1011, 'call failed');
        } catch {
          /* もう閉じている */
        }
      });
    },
  );
}
