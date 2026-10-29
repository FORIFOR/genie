#!/usr/bin/env node
/**
 * 中継を起動する（運営者が 1 つだけ置く）。
 *
 *   LINE_CHANNEL_SECRET / LINE_CHANNEL_ACCESS_TOKEN   公式アカウントの鍵（ここにだけ置く）
 *   HUB_PORT                                          既定 8790
 *   HUB_DB                                            控えの SQLite（既定 ./line-hub.sqlite）
 *   HUB_REGISTRATION_TOKEN                            Genie の登録に要る合言葉（公開するなら必ず置く）
 *
 * LINE の Webhook URL は https://<この中継>/line/webhook。
 */
import { createHub } from './hub.js';
import { HubStore } from './store.js';

const secret = process.env['LINE_CHANNEL_SECRET']?.trim();
const token = process.env['LINE_CHANNEL_ACCESS_TOKEN']?.trim();
if (!secret || !token) {
  console.error('LINE_CHANNEL_SECRET と LINE_CHANNEL_ACCESS_TOKEN が要ります。');
  process.exit(2);
}
const port = Number(process.env['HUB_PORT'] ?? '8790');
const hub = createHub({
  channelSecret: secret,
  accessToken: token,
  store: new HubStore(process.env['HUB_DB'] ?? './line-hub.sqlite'),
  registrationToken: process.env['HUB_REGISTRATION_TOKEN']?.trim() || null,
  log: (event, detail) =>
    console.log(JSON.stringify({ time: new Date().toISOString(), event, ...detail })),
});
hub.server.listen(port, process.env['HUB_HOST'] ?? '127.0.0.1', () =>
  console.log(`LINE_HUB_READY :${String(port)} (webhook /line/webhook, Genie /connect)`),
);
const stop = () => void hub.close().then(() => process.exit(0));
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
