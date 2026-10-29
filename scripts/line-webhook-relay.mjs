#!/usr/bin/env node
/**
 * LINE の Webhook だけを、手元の gateway へ通す中継。
 *
 *   LINE → https://<トンネル>/v1/channels/line/webhook → この中継（127.0.0.1）→ gateway
 *
 * LINE には Slack の Socket Mode のような「Mac から繋ぎに行く」受け方が無く、公開 HTTPS が要る。
 * トンネル（cloudflared）を gateway に直接向けると、**開発用のサインイン（/v1/auth/dev/token）まで
 * 外から呼べてしまう。**だからトンネルはこの中継に向け、ここでは次のものだけを通す:
 *   - POST /v1/channels/line/webhook（クエリなし）
 *   - 本文 1 MB まで（LINE の Webhook はこれより小さい）
 *   - 渡す見出しは content-type と x-line-signature だけ（署名は gateway が確かめる）
 * もう 1 つ、LINE から声で話すページ（docs/LINE_CALL.ja.md）を通す:
 *   - GET /v1/channels/call/<32 字のリンク>（ページ）と、その /ws（音声の WebSocket）
 *   - リンクは 10 分・1 回だけ使える乱数。認証の代わりにこれで守る（gateway が確かめる）
 * みんなの計画（Action Board、src/board.ts）のページも通す（読むだけ）:
 *   - GET /v1/channels/board/<32 字のリンク> と、その /state（JSON）
 *   - リンクは 30 日の乱数。書き換える道は無い（決めるのは LINE のグループで）
 *   - LINE の中で開く入口（LIFF）: GET /v1/channels/board?liff.state=/<リンク>。クエリは liff.state だけ渡す
 * 仕事のホーム（src/work-home.ts）のページも通す（読むだけ。本人 1 人のリンク）:
 *   - GET /v1/channels/work/<32 字のリンク> と、その /state、/item/s|t/<id>（仕事の台帳）
 *   - LINE の中では、上の LIFF の入口に liff.state=/w/<リンク> で入る
 * カードの画像（src/media.ts）も通す: GET /v1/channels/media/<32 字のリンク>（7 日。画像だけ）
 * ブラウザの引き継ぎ（src/browser-handoff.ts）のページも通す（本人 1 人・15 分のリンク）:
 *   - GET /v1/channels/handoff/<32 字のリンク>（ページ）と、その /ws（画面の流れと本人の操作の WebSocket）
 *   - LINE の中では、上の LIFF の入口に liff.state=/h/<リンク> で入る
 * 中継（公式アカウント 1 つ、docs/LINE_HUB.ja.md）を手元で動かすときは、`--hub` で
 *   - POST /line/webhook を中継へ通す（LINE の Webhook URL はこちらにする）
 * ほかはすべて 404。
 *
 *   node scripts/line-webhook-relay.mjs [--port 43190] [--gateway http://127.0.0.1:43123]
 */
import { createServer, request as httpRequest } from 'node:http';
import { connect } from 'node:net';
import { pathToFileURL } from 'node:url';

export const WEBHOOK_PATH = '/v1/channels/line/webhook';
export const HUB_WEBHOOK_PATH = '/line/webhook';
export const MAX_BODY = 1024 * 1024;
export const CALL_PAGE = /^\/v1\/channels\/call\/[A-Za-z0-9_-]{32}$/;
export const CALL_SOCKET = /^\/v1\/channels\/call\/[A-Za-z0-9_-]{32}\/ws$/;
/** みんなの計画（Action Board）のページと、その中身（読むだけ）。 */
export const BOARD_PAGE = /^\/v1\/channels\/board\/[A-Za-z0-9_-]{32}(?:\/state)?$/;
/** 仕事のホームのページと、その中身（読むだけ）。 */
export const WORK_PAGE =
  /^\/v1\/channels\/work\/[A-Za-z0-9_-]{32}(?:\/state|\/item\/[st]\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})?$/;
/** LIFF の入口（エンドポイント URL）。gateway がそのボードのページへ移す。 */
export const BOARD_ENTRY = /^\/v1\/channels\/board$/;
/** ブラウザの引き継ぎのページと、その WebSocket。 */
export const HANDOFF_PAGE = /^\/v1\/channels\/handoff\/[A-Za-z0-9_-]{32}$/;
export const HANDOFF_SOCKET = /^\/v1\/channels\/handoff\/[A-Za-z0-9_-]{32}\/ws$/;
/** カードの画像（店の写真・地図）。gateway が Google から取り直して返す（キーは外へ出ない）。 */
export const MEDIA = /^\/v1\/channels\/media\/[A-Za-z0-9_-]{32}$/;

/** LINE はリンクに ?openExternalBrowser=1 を残したまま開くので、クエリは捨ててから道を見る。 */
const pathOf = (url) => (url ?? '').split('?')[0];

/** 中継を作る。`fetchImpl` はテストで差し替える。 */
export function createRelay({ gateway, hub = null, fetchImpl = fetch, log = () => {} }) {
  const target = new URL(WEBHOOK_PATH, gateway);
  const local = (u) => ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname);
  if (!local(target)) throw new Error('gateway は手元（127.0.0.1）を指してください。');
  const hubTarget = hub ? new URL(HUB_WEBHOOK_PATH, hub) : null;
  if (hubTarget && !local(hubTarget)) throw new Error('中継は手元（127.0.0.1）を指してください。');
  const server = createServer((req, res) => {
    const done = (status, body = '') => {
      res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(body);
    };
    if (
      req.method === 'GET' &&
      [CALL_PAGE, BOARD_PAGE, WORK_PAGE, BOARD_ENTRY, MEDIA, HANDOFF_PAGE].some((re) =>
        re.test(pathOf(req.url)),
      )
    ) {
      // 通話・計画のページ。中身（HTML / JSON）をそのまま返す。見出しは gateway が付けたものだけ。
      // クエリは捨てる。LIFF の入口だけ liff.state を残す（ほかの値は gateway へ渡さない）
      const url = new URL(pathOf(req.url), gateway);
      if (BOARD_ENTRY.test(url.pathname)) {
        const state = new URL(req.url ?? '', 'http://x').searchParams.get('liff.state');
        if (state) url.searchParams.set('liff.state', state);
      }
      const upstream = httpRequest(url, { method: 'GET', timeout: 10_000 }, (page) => {
        const headers = {};
        for (const key of ['content-type', 'cache-control', 'referrer-policy', 'x-robots-tag'])
          if (page.headers[key]) headers[key] = page.headers[key];
        res.writeHead(page.statusCode ?? 502, headers);
        page.pipe(res);
      });
      upstream.on('error', () => done(502));
      upstream.end();
      return undefined;
    }
    const forwardTo =
      req.method === 'POST' && req.url === WEBHOOK_PATH
        ? target
        : req.method === 'POST' && req.url === HUB_WEBHOOK_PATH && hubTarget
          ? hubTarget
          : null;
    if (!forwardTo) {
      req.resume();
      return done(404);
    }
    const chunks = [];
    let size = 0;
    let tooLarge = false;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        tooLarge = true;
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('close', () => {
      if (tooLarge && !res.headersSent) done(413);
    });
    req.on('end', async () => {
      if (tooLarge) return;
      const headers = { 'content-type': req.headers['content-type'] ?? 'application/json' };
      const signature = req.headers['x-line-signature'];
      if (typeof signature === 'string') headers['x-line-signature'] = signature;
      try {
        const upstream = await fetchImpl(forwardTo, {
          method: 'POST',
          headers,
          body: Buffer.concat(chunks),
          signal: AbortSignal.timeout(10_000),
        });
        log(`line webhook → ${String(upstream.status)}`);
        // 中身は返さない（LINE が見るのは状態だけ）
        done(upstream.status);
      } catch {
        log('line webhook → gateway unreachable');
        done(502);
      }
    });
  });
  // 通話の音声・ブラウザの引き継ぎ（WebSocket）。決まった道の upgrade だけを、見出しを絞って gateway へつなぐ
  server.on('upgrade', (req, socket, head) => {
    if (
      req.method !== 'GET' ||
      ![CALL_SOCKET, HANDOFF_SOCKET].some((re) => re.test(pathOf(req.url)))
    ) {
      socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
      return;
    }
    const port = Number(target.port || 80);
    const upstream = connect(port, target.hostname, () => {
      const keep = ['sec-websocket-key', 'sec-websocket-version', 'sec-websocket-extensions'];
      const lines = [
        `GET ${pathOf(req.url)} HTTP/1.1`,
        `Host: ${target.host}`,
        'Connection: Upgrade',
        'Upgrade: websocket',
        ...keep.filter((k) => req.headers[k]).map((k) => `${k}: ${req.headers[k]}`),
      ];
      upstream.write(lines.join('\r\n') + '\r\n\r\n');
      if (head?.length) upstream.write(head);
      socket.pipe(upstream).pipe(socket);
      log('call socket → gateway');
    });
    const close = () => {
      socket.destroy();
      upstream.destroy();
    };
    upstream.on('error', close);
    socket.on('error', close);
  });
  return server;
}

function option(args, name, fallback) {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const args = process.argv.slice(2);
  const port = Number(option(args, '--port', '43190'));
  const gateway = option(args, '--gateway', 'http://127.0.0.1:43123');
  const hub = option(args, '--hub', null);
  const server = createRelay({
    gateway,
    hub,
    log: (line) => console.log(`${new Date().toISOString()} ${line}`),
  });
  server.listen(port, '127.0.0.1', () => {
    console.log(`LINE_RELAY_READY 127.0.0.1:${String(port)} → ${gateway}${WEBHOOK_PATH}`);
  });
}
