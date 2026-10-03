// 偽の Gemini Live（BidiGenerateContent）。**検査専用**。本物の API もキーも使わない（課金なし）。
//
// 台本:
//   接続 1: setup → setupComplete + 再開の鍵 h1。
//     ターン 1: 音声を 8 通受けたら、声を 12 片（各 0.2 秒）を 0.1 秒おきに流し、終わってから turnComplete。
//               → アプリは turnComplete より**前に**声を流し始める（ためない）ことを確かめる。
//     ターン 2: 音声を 8 通受けたら、声を 3 片流して interrupted、続けて turnComplete。
//               → アプリは流している声・待ちの声を捨て、次を聞く。
//     そのあと goAway（残り 1 秒）。
//   接続 2: setup に鍵 h1 が入っていること。setupComplete のあと、音声を 8 通受けたら短く答える。
// 出来事は JSON 行で LOG へ書く（アプリの検査が読む）。
import { WebSocketServer } from 'ws';
import { appendFileSync, writeFileSync } from 'node:fs';

const port = Number(process.argv[2] ?? 47461);
const LOG = process.argv[3] ?? '/tmp/gemini-fake.log';
writeFileSync(LOG, '');
const log = (o) => appendFileSync(LOG, JSON.stringify({ t: Date.now(), ...o }) + '\n');

function tone(seconds, rate = 24000, freq = 440) {
  const n = Math.floor(seconds * rate);
  const buf = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) buf.writeInt16LE(Math.round(Math.sin((2 * Math.PI * freq * i) / rate) * 6000), i * 2);
  return buf.toString('base64');
}
const chunk = tone(0.2);
const audio = (text) => ({ serverContent: { modelTurn: { parts: [{ inlineData: { mimeType: 'audio/pcm;rate=24000', data: chunk } }] },
  ...(text ? { outputTranscription: { text } } : {}) } });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let connections = 0;
const wss = new WebSocketServer({ port, host: '127.0.0.1' });
wss.on('connection', (ws, req) => {
  const conn = ++connections;
  log({ event: 'connect', conn, hasKeyHeader: Boolean(req.headers['x-goog-api-key']) });
  let audioIn = 0, turn = 0, busy = false;
  const send = (o) => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(o)); };
  ws.on('message', async (raw) => {
    let m; try { m = JSON.parse(String(raw)); } catch { return; }
    if (m.setup) {
      log({ event: 'setup', conn, handle: m.setup.sessionResumption?.handle ?? null, setup: m.setup });
      send({ setupComplete: {} });
      send({ sessionResumptionUpdate: { newHandle: `h${conn}`, resumable: true } });
      return;
    }
    if (m.realtimeInput?.audio) {
      audioIn++;
      if (busy || audioIn < 8) return;
      busy = true; audioIn = 0; turn++;
      send({ serverContent: { inputTranscription: { text: `質問${turn}` } } });
      if (conn === 1 && turn === 1) {
        log({ event: 'turn', conn, turn, kind: 'stream' });
        for (let i = 0; i < 12; i++) { send(audio(i === 0 ? '晴れです。' : null)); await sleep(100); }
        send({ serverContent: { generationComplete: true } });
        log({ event: 'turnComplete', conn, turn });
        send({ serverContent: { turnComplete: true } });
      } else if (conn === 1 && turn === 2) {
        log({ event: 'turn', conn, turn, kind: 'interrupt' });
        for (let i = 0; i < 3; i++) { send(audio(i === 0 ? '長い説明を' : null)); await sleep(100); }
        log({ event: 'interrupted', conn, turn });
        send({ serverContent: { interrupted: true } });
        send({ serverContent: { turnComplete: true } });
        await sleep(300);
        log({ event: 'goAway', conn });
        send({ goAway: { timeLeft: '1s' } });
      } else {
        log({ event: 'turn', conn, turn, kind: 'after-resume' });
        send(audio('続けます。'));
        send({ serverContent: { turnComplete: true } });
      }
      busy = false;
    }
  });
  ws.on('close', () => log({ event: 'close', conn }));
});
log({ event: 'listening', port });
