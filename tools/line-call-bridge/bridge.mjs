// 管理画面で受けた LINE の電話を、Genie の声（gateway の通話 → Gemini Live）につなぐ。
//
//   node tools/line-call-bridge/bridge.mjs
//
// いまは手動応答: 着信したら、開いた Chrome の管理画面で本人が「応答」を押す。
// 応答して相手の声が届き始めたら、gateway に鍵をもらい、声を両方向につなぐ。切れたら終える。
//
//   相手の声  … ページの WebRTC の受信トラック → 16 kHz PCM → gateway の通話の WebSocket
//   Genie の声 … gateway → 24 kHz PCM → ページの「マイク」（getUserMedia の代わり）
//
// 鍵: gateway の /v1/channels/line-oa-call に、受けた本文を封じる鍵（genie-secret-key）から作った合言葉で頼む（この Mac の中だけ）。
// 連携していない人の電話にはつながない（gateway が断る）。
import { execFileSync } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { platform } from 'node:os';
import { openManager } from './probe.mjs';

const GATEWAY = (process.env.GENIE_GATEWAY_URL ?? 'http://127.0.0.1:43123').replace(/\/$/, '');
const GENIE_APP =
  process.env.GENIE_APP_EXECUTABLE ??
  (platform() === 'darwin' ? '/Applications/Genie.app/Contents/MacOS/Genie' : 'genie');

/** gateway と同じ作り方（services/api-gateway/src/channels.ts の lineCallBridgeKey）。 */
export const bridgeKey = (secretKey) =>
  createHmac('sha256', secretKey).update('genie-line-call-bridge').digest('hex');

/** 管理画面の URL から、かけてきた人の LINE の利用者 ID（チャットを開いていれば）。 */
export const callerFrom = (url) => /\/chat\/(U[0-9a-f]{32})(?:[/?#]|$)/.exec(url ?? '')?.[1] ?? null;

const say = (m) => console.log(`${new Date().toLocaleTimeString('ja-JP')} ${m}`);

/** 橋渡しを動かす。open は Chrome を開く（既定は管理画面）。 */
export async function runBridge(open = (options) => openManager(options)) {
  const secret = execFileSync(GENIE_APP, ['--secret', 'get', 'genie-secret-key'], {
    encoding: 'utf8',
  }).trim();
  if (!secret) throw new Error('genie-secret-key がキーチェーンにありません');
  const key = bridgeKey(secret);

  /** いまの通話（1 つだけ）。 */
  let call = null;
  const end = (why) => {
    if (!call) return;
    say(`通話を終えます（${why}）`);
    try {
      if (call.ws.readyState === WebSocket.OPEN) call.ws.send(JSON.stringify({ type: 'hangup' }));
      call.ws.close();
    } catch {}
    call.page.evaluate(() => window.__genieHush?.()).catch(() => {});
    call = null;
  };

  const begin = async (page) => {
    const subject = callerFrom(page.url());
    call = { page, ws: null, pending: [] };
    const current = call;
    const res = await fetch(`${GATEWAY}/v1/channels/line-oa-call`, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ subject }),
    }).catch((e) => ({ ok: false, status: 0, json: async () => ({ refused: String(e) }) }));
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      say(`Genie につなげません（${res.status} ${body.refused ?? ''}）。この通話は人が話してください。`);
      if (call === current) call = { page, ws: { readyState: 3, close() {}, send() {} }, refused: true };
      return;
    }
    const { ws: path } = await res.json();
    const ws = new WebSocket(`${GATEWAY.replace(/^http/, 'ws')}${path}`);
    ws.binaryType = 'arraybuffer';
    current.ws = ws;
    ws.onopen = () => {
      say(`Genie につなぎました${subject ? '' : '（かけた人は連携の 1 人とみなしました）'}`);
      for (const chunk of current.pending.splice(0)) ws.send(chunk);
    };
    ws.onmessage = (e) => {
      if (typeof e.data !== 'string') {
        const b64 = Buffer.from(e.data).toString('base64');
        page.evaluate((d) => window.__genieSpeak(d), b64).catch(() => {});
        return;
      }
      const m = JSON.parse(e.data);
      if (m.type === 'interrupted') page.evaluate(() => window.__genieHush?.()).catch(() => {});
      else if (m.type === 'transcript') say(`${m.role === 'user' ? '相手' : 'Genie'}: ${m.text}`);
      else if (m.type === 'ended') {
        say(`Genie 側で終わりました: ${m.reason ?? ''}`);
        if (call === current) call = null;
      }
    };
    ws.onclose = () => {
      if (call === current) call = null;
    };
  };

  const { ctx, page: first } = await open({
    mode: 'genie',
    onEvent: (event, page) => {
      switch (event.type) {
        case 'remote.listening':
          // 応答して相手の声が届き始めた
          if (!call) begin(page).catch((e) => say(`つなげませんでした: ${e.message}`));
          break;
        case 'audio':
          if (!call || call.refused) break;
          {
            const chunk = Buffer.from(event.data, 'base64');
            if (call.ws?.readyState === WebSocket.OPEN) call.ws.send(chunk);
            else if (call.pending && call.pending.length < 50) call.pending.push(chunk);
          }
          break;
        case 'remote.ended':
          end('相手の音声が終わった');
          break;
        case 'pc.state':
          if (['closed', 'failed', 'disconnected'].includes(event.state)) end(`接続 ${event.state}`);
          break;
        case 'gum':
          say(`マイクを求められました（${event.mode === 'genie' ? 'Genie の声を渡します' : '本物のマイク'}）`);
          break;
      }
    },
  });
  say('管理画面を開きました。着信したら「応答」を押してください。終えるときは Chrome を閉じます。');
  return { ctx, page: first, end };
}

async function main() {
  const { ctx, end } = await runBridge();
  await new Promise((resolve) => ctx.on('close', resolve));
  end('Chrome を閉じた');
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main().catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}
