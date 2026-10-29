// inject.js を、LINE の代わりの 1 ページで確かめる。2 つの RTCPeerConnection を同じページでつなぎ、
//   - 相手（A）の声を、Genie 側（B）が 16 kHz PCM で受け取れる
//   - Genie の声（__genieSpeak）が、マイクの代わりとして相手（A）に届く
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const inject = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'inject.js'), 'utf8');

// A は発振器の音を送り、B は getUserMedia（＝ Genie の声）を送る。A は受けた音の大きさを測る。
const PAGE = `<!doctype html><script>
window.run = async () => {
  const a = new RTCPeerConnection(), b = new RTCPeerConnection();
  a.onicecandidate = (e) => e.candidate && b.addIceCandidate(e.candidate);
  b.onicecandidate = (e) => e.candidate && a.addIceCandidate(e.candidate);
  const ctx = new AudioContext(); const osc = ctx.createOscillator(); const d = ctx.createMediaStreamDestination();
  osc.connect(d); osc.start();
  a.addTrack(d.stream.getAudioTracks()[0], d.stream);
  const mic = await navigator.mediaDevices.getUserMedia({ audio: true });
  b.addTrack(mic.getAudioTracks()[0], mic);
  window.heardByA = 0;
  a.ontrack = (e) => {
    const s = new MediaStream([e.track]); const el = new Audio(); el.muted = true; el.srcObject = s; el.play();
    const c = new AudioContext(); const an = c.createAnalyser(); c.createMediaStreamSource(s).connect(an);
    const buf = new Float32Array(an.fftSize);
    setInterval(() => { an.getFloatTimeDomainData(buf); window.heardByA = Math.max(window.heardByA, ...buf.map(Math.abs)); }, 50);
  };
  const offer = await a.createOffer(); await a.setLocalDescription(offer); await b.setRemoteDescription(offer);
  const answer = await b.createAnswer(); await b.setLocalDescription(answer); await a.setRemoteDescription(answer);
};
</script>`;

test('captures the remote voice and speaks Genie’s voice as the microphone', async () => {
  const server = http.createServer((_, res) => res.end(PAGE)).listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const browser = await chromium.launch({ channel: 'chrome', headless: true, timeout: 30000, args: ['--autoplay-policy=no-user-gesture-required', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
  try {
    const ctx = await browser.newContext({ permissions: ['microphone'] });
    const events = [];
    await ctx.exposeBinding('__genieBridgeEvent', (_, json) => events.push(JSON.parse(json)));
    await ctx.addInitScript({ content: `window.__genieMode = 'genie'; window.__genieAnyHost = true;` });
    await ctx.addInitScript({ content: inject });
    const page = await ctx.newPage();
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await page.evaluate(() => window.run());
    // Genie の声: 440 Hz の 0.5 秒（24 kHz PCM16）を 4 回
    const tone = Buffer.alloc(24000);
    for (let i = 0; i < 12000; i += 1) tone.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * i) / 24000) * 12000), i * 2);
    for (let i = 0; i < 4; i += 1) await page.evaluate((b64) => window.__genieSpeak(b64), tone.toString('base64'));
    const until = Date.now() + 8000;
    while (Date.now() < until && !(events.some((e) => e.type === 'audio') && (await page.evaluate(() => window.heardByA)) > 0.05))
      await new Promise((r) => setTimeout(r, 100));

    assert.ok(events.some((e) => e.type === 'pc.created'), 'saw the peer connection');
    assert.ok(events.some((e) => e.type === 'gum' && e.mode === 'genie'), 'gave Genie’s voice as the microphone');
    assert.ok(events.some((e) => e.type === 'remote.listening' && e.sampleRate === 16000), 'listens at 16 kHz');
    const audio = events.filter((e) => e.type === 'audio');
    assert.ok(audio.length > 0, 'remote voice reached Genie as PCM');
    const pcm = Buffer.concat(audio.map((e) => Buffer.from(e.data, 'base64')));
    let peak = 0;
    for (let i = 0; i < pcm.length; i += 2) peak = Math.max(peak, Math.abs(pcm.readInt16LE(i)));
    assert.ok(peak > 1000, `remote voice is not silent (peak ${peak})`);
    assert.ok((await page.evaluate(() => window.heardByA)) > 0.05, 'Genie’s voice reached the other side');
  } finally {
    await browser.close();
    server.close();
  }
});
