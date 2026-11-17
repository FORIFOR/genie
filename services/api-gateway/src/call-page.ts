/**
 * 通話のページ（LINE のリンクから開く）。外部のスクリプトは読まない（このファイルだけで動く）。
 *
 *   マイク → 16 kHz PCM16 を 100 ms ごとに WebSocket へ → Genie（gateway）→ Gemini Live
 *   Gemini の声（PCM16 24 kHz）→ 順に再生。割り込まれたら（interrupted）再生待ちを捨てる
 *
 * iPhone の Safari は、ボタンを押してからでないと音を出せない・マイクを開けないので、最初に「話しはじめる」を押す。
 */
export function callPage(): string {
  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex">
<meta name="theme-color" content="#0E1220">
<title>Genie と話す</title>
<style>
  :root { --bg:#0E1220; --orb:#26324F; --wave:#7CC8F2; --text:#FFFFFF; --muted:#9AA3B5; --control:#2A3346; --hang:#D65A5A; }
  * { box-sizing: border-box; -webkit-tap-highlight-color: transparent; }
  [hidden] { display:none !important; }
  html, body { margin:0; height:100%; background:var(--bg); color:var(--text); }
  body { font:16px/1.5 -apple-system, "Hiragino Sans", system-ui, sans-serif; }
  main { min-height:100dvh; max-width:480px; margin:0 auto; padding:calc(20px + env(safe-area-inset-top)) 24px calc(28px + env(safe-area-inset-bottom));
         display:flex; flex-direction:column; align-items:center; text-align:center; }
  .brand { color:var(--muted); font-size:14px; letter-spacing:.02em; }
  .center { flex:1; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:10px; width:100%; }
  .orb { width:120px; height:120px; border-radius:50%; background:var(--orb); display:grid; place-items:center; margin-bottom:14px;
         transition: box-shadow .3s ease; }
  .orb.speaking { box-shadow: 0 0 0 10px rgba(124,200,242,.10), 0 0 0 22px rgba(124,200,242,.05); }
  .wave { display:flex; gap:5px; align-items:center; height:40px; }
  .wave i { display:block; width:4px; border-radius:2px; background:var(--wave); height:12px; transition:height .12s ease; }
  h1 { font-size:40px; font-weight:700; margin:0; letter-spacing:.01em; }
  #status { color:var(--muted); font-size:17px; min-height:26px; }
  #said { font-size:17px; min-height:26px; max-width:100%; overflow-wrap:anywhere; }
  #reply { color:var(--muted); font-size:14px; min-height:21px; max-width:100%; overflow-wrap:anywhere; }
  .controls { display:flex; gap:28px; justify-content:center; margin-top:8px; }
  .round { width:76px; height:76px; border-radius:50%; border:0; display:grid; place-items:center; color:#fff; cursor:pointer; }
  .round svg { width:28px; height:28px; }
  #mute { background:var(--control); }
  #mute[aria-pressed="true"] { background:#fff; color:var(--bg); }
  #hang { background:var(--hang); }
  #camera, #screen { background:var(--control); }
  #camera[aria-pressed="true"], #screen[aria-pressed="true"] { background:#fff; color:var(--bg); }
  .controls { flex-wrap:wrap; }
  #preview { position:fixed; top:calc(16px + env(safe-area-inset-top)); right:16px; width:96px; height:128px; object-fit:cover;
             border-radius:12px; background:#000; }
  #start { appearance:none; border:0; border-radius:999px; background:#fff; color:var(--bg); font:inherit; font-weight:700; font-size:17px;
           padding:16px 36px; cursor:pointer; display:flex; gap:10px; align-items:center; }
  #start svg { width:22px; height:22px; }
  button:disabled { opacity:.5; }
  .note { color:var(--muted); font-size:13px; margin-top:18px; min-height:20px; }
  @media (prefers-reduced-motion: reduce) { .wave i, .orb { transition:none; } }
</style>
</head>
<body>
<main>
  <div class="brand">Genie Voice</div>
  <div class="center">
    <div class="orb" id="orb" aria-hidden="true"><div class="wave" id="wave"><i></i><i></i><i></i><i></i><i></i></div></div>
    <h1>Genie</h1>
    <div id="status" role="status" aria-live="polite">下のボタンで話しはじめます</div>
    <div id="said" aria-live="polite"></div>
    <div id="reply" aria-live="polite"></div>
  </div>
  <button id="start" type="button">
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M6.6 10.8a15.1 15.1 0 0 0 6.6 6.6l2.2-2.2a1 1 0 0 1 1-.25 11.4 11.4 0 0 0 3.6.57 1 1 0 0 1 1 1V20a1 1 0 0 1-1 1A17 17 0 0 1 3 4a1 1 0 0 1 1-1h3.5a1 1 0 0 1 1 1c0 1.25.2 2.45.57 3.6a1 1 0 0 1-.25 1z"/></svg>
    話しはじめる
  </button>
  <div class="controls" id="controls" hidden>
    <button class="round" id="mute" type="button" aria-pressed="false" aria-label="マイクを切る">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg>
    </button>
    <button class="round" id="camera" type="button" aria-pressed="false" aria-label="カメラを入れる">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/></svg>
    </button>
    <button class="round" id="screen" type="button" aria-pressed="false" aria-label="画面を見せる" hidden>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/></svg>
    </button>
    <button class="round" id="hang" type="button" aria-label="切る">
      <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 9c-1.6 0-3.15.25-4.6.72v3.1c0 .39-.23.74-.56.9-.98.49-1.87 1.12-2.66 1.85-.18.18-.43.28-.7.28-.28 0-.53-.11-.71-.29L.29 13.08a.96.96 0 0 1-.29-.7c0-.28.11-.53.29-.71C3.34 8.78 7.46 7 12 7s8.66 1.78 11.71 4.67c.18.18.29.43.29.71 0 .28-.11.53-.29.71l-2.48 2.48c-.18.18-.43.29-.71.29-.27 0-.52-.11-.7-.28a11.3 11.3 0 0 0-2.67-1.85 1 1 0 0 1-.56-.9v-3.1C15.15 9.25 13.6 9 12 9z"/></svg>
    </button>
  </div>
  <div class="note" id="note"></div>
  <video id="preview" playsinline muted hidden></video>
</main>
<script>
(() => {
  const $ = (id) => document.getElementById(id);
  const status = $('status'), said = $('said'), reply = $('reply'), note = $('note');
  const start = $('start'), controls = $('controls'), mute = $('mute'), hang = $('hang'), orb = $('orb');
  const camera = $('camera'), preview = $('preview');
  const bars = [...document.querySelectorAll('#wave i')];
  const base = location.href.replace(/^http/, 'ws').replace(/[?#].*$/, '') + '/ws';
  let ws, ctx, source, processor, stream, nextAt = 0, playing = [], muted = false, ended = false;
  let resumeKey = null, retries = 0, video = null, frameTimer = null;
  let userLine = '', genieLine = '', lastRole = null;
  const setWave = (level) => bars.forEach((b, i) => { const k = [0.5, 0.8, 1, 0.8, 0.5][i]; b.style.height = Math.max(8, Math.min(40, 8 + level * 120 * k)) + 'px'; });
  const quote = (t) => t ? '「' + t.trim() + '」' : '';
  const stopCamera = () => {
    clearInterval(frameTimer); frameTimer = null;
    if (video) video.getTracks().forEach((t) => t.stop());
    video = null; preview.hidden = true; preview.srcObject = null;
    camera.setAttribute('aria-pressed', 'false'); camera.setAttribute('aria-label', 'カメラを入れる');
  };
  const stop = (message) => {
    if (ended) return; ended = true;
    try { processor && processor.disconnect(); source && source.disconnect(); } catch (_) {}
    if (stream) stream.getTracks().forEach((t) => t.stop());
    stopCamera();
    if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'hangup' }));
    try { ws && ws.close(); } catch (_) {}
    playing.forEach((n) => { try { n.stop(); } catch (_) {} });
    controls.hidden = true; orb.classList.remove('speaking'); setWave(0);
    status.textContent = '通話を終えました';
    note.textContent = message || 'もう一度話すときは、LINE で「電話して」と送ってください。';
  };
  const play = (buf) => {
    const pcm = new Int16Array(buf);
    const audio = ctx.createBuffer(1, pcm.length, 24000);
    const ch = audio.getChannelData(0);
    let peak = 0;
    for (let i = 0; i < pcm.length; i++) { ch[i] = pcm[i] / 32768; peak = Math.max(peak, Math.abs(ch[i])); }
    const node = ctx.createBufferSource();
    node.buffer = audio; node.connect(ctx.destination);
    nextAt = Math.max(nextAt, ctx.currentTime + 0.05);
    node.start(nextAt); nextAt += audio.duration;
    playing.push(node);
    orb.classList.add('speaking'); status.textContent = '話しています…'; setWave(peak);
    node.onended = () => { playing = playing.filter((n) => n !== node); if (!playing.length && !ended) { orb.classList.remove('speaking'); status.textContent = muted ? 'マイクを切っています' : '聞いています…'; setWave(0); } };
  };
  const connect = (resume) => {
    ws = new WebSocket(resume ? base + '?resume=' + encodeURIComponent(resume) : base);
    ws.binaryType = 'arraybuffer';
    ws.onmessage = (e) => {
      if (typeof e.data !== 'string') { play(e.data); return; }
      const m = JSON.parse(e.data);
      if (m.type === 'ready') {
        resumeKey = m.resume || resumeKey; retries = 0;
        start.hidden = true; controls.hidden = false; status.textContent = muted ? 'マイクを切っています' : '聞いています…';
        note.textContent = m.resumed ? 'つなぎ直しました。続けてどうぞ。' : '最長 ' + Math.floor(m.seconds / 60) + ' 分。頼んだことは声でお答えします。';
      } else if (m.type === 'transcript') {
        if (m.role === 'user') { if (lastRole !== 'user') userLine = ''; userLine += m.text; said.textContent = quote(userLine); }
        else { if (lastRole !== 'genie') genieLine = ''; genieLine += m.text; reply.textContent = genieLine.trim(); }
        lastRole = m.role;
      } else if (m.type === 'interrupted') {
        playing.forEach((n) => { try { n.stop(); } catch (_) {} }); playing = []; nextAt = 0;
      } else if (m.type === 'delegated') {
        status.textContent = m.status === 'not_accepted' ? '頼みを受け付けられませんでした' : '確認しています…';
      } else if (m.type === 'participants') {
        note.textContent = '参加している人: ' + m.count + ' 人';
      } else if (m.type === 'ended') stop(m.reason);
    };
    ws.onclose = () => {
      if (ended) return;
      // 電波が切れた。45 秒のうちに同じ通話へ戻る
      if (resumeKey && retries < 12) {
        retries += 1; status.textContent = 'つなぎ直しています…';
        setTimeout(() => { if (!ended) connect(resumeKey); }, 3000);
      } else stop('通信が切れました。');
    };
  };
  start.addEventListener('click', async () => {
    start.disabled = true; status.textContent = 'つないでいます…'; note.textContent = '';
    try {
      ctx = new (window.AudioContext || window.webkitAudioContext)();
      await ctx.resume();
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    } catch (e) {
      status.textContent = 'マイクを使えませんでした';
      note.textContent = 'LINE の中で開いている場合は、右上のメニューから Safari などのブラウザで開いてください。';
      start.disabled = false; return;
    }
    connect(null);
    source = ctx.createMediaStreamSource(stream);
    processor = ctx.createScriptProcessor(4096, 1, 1);
    const ratio = ctx.sampleRate / 16000;
    let carry = [];
    processor.onaudioprocess = (e) => {
      if (!ws || ws.readyState !== 1 || muted) return;
      const input = e.inputBuffer.getChannelData(0);
      let peak = 0;
      for (let i = 0; i < input.length / ratio; i++) {
        const from = Math.floor(i * ratio), to = Math.min(input.length, Math.floor((i + 1) * ratio));
        let sum = 0; for (let j = from; j < to; j++) sum += input[j];
        const v = sum / Math.max(1, to - from); carry.push(v); peak = Math.max(peak, Math.abs(v));
      }
      if (!playing.length) setWave(peak);
      while (carry.length >= 1600) {
        const chunk = carry.splice(0, 1600);
        const pcm = new Int16Array(chunk.length);
        for (let i = 0; i < chunk.length; i++) pcm[i] = Math.max(-1, Math.min(1, chunk[i])) * 32767;
        ws.send(pcm.buffer);
      }
    };
    source.connect(processor); processor.connect(ctx.destination);
  });
  mute.addEventListener('click', () => {
    muted = !muted;
    mute.setAttribute('aria-pressed', String(muted));
    mute.setAttribute('aria-label', muted ? 'マイクを入れる' : 'マイクを切る');
    status.textContent = muted ? 'マイクを切っています' : '聞いています…';
  });
  // カメラ・画面: 入れている間だけ、1 秒に 1 枚を Genie に見せる（料理・冷蔵庫・画面のエラーなど）
  const screenButton = $('screen');
  if (navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia) screenButton.hidden = false;
  let sharing = null;
  const share = async (kind) => {
    const button = kind === 'camera' ? camera : screenButton;
    if (video) {
      const was = sharing; stopCamera(); screenButton.setAttribute('aria-pressed', 'false');
      note.textContent = was === 'camera' ? 'カメラを切りました。' : '画面を見せるのをやめました。';
      if (was === kind) return;
    }
    try {
      video = kind === 'camera'
        ? await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment', width: { ideal: 960 } } })
        : await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
    } catch (e) { video = null; note.textContent = kind === 'camera' ? 'カメラを使えませんでした。' : '画面を見せられませんでした。'; return; }
    sharing = kind;
    video.getVideoTracks()[0].addEventListener('ended', () => { stopCamera(); screenButton.setAttribute('aria-pressed', 'false'); });
    preview.srcObject = video; preview.hidden = false; await preview.play().catch(() => {});
    button.setAttribute('aria-pressed', 'true');
    note.textContent = kind === 'camera' ? 'カメラを Genie に見せています（1 秒に 1 枚）。' : '画面を Genie に見せています（1 秒に 1 枚）。';
    const canvas = document.createElement('canvas');
    frameTimer = setInterval(() => {
      if (!ws || ws.readyState !== 1 || !preview.videoWidth) return;
      const w = Math.min(1024, preview.videoWidth), h = Math.round(w * preview.videoHeight / preview.videoWidth);
      canvas.width = w; canvas.height = h;
      canvas.getContext('2d').drawImage(preview, 0, 0, w, h);
      const data = canvas.toDataURL('image/jpeg', 0.6).split(',')[1];
      ws.send(JSON.stringify({ type: 'frame', data }));
    }, 1000);
  };
  camera.addEventListener('click', () => share('camera'));
  screenButton.addEventListener('click', () => share('screen'));
  hang.addEventListener('click', () => stop());
})();
</script>
</body>
</html>`;
}

/** 使えないリンク（期限切れ・使用済み）。 */
export function callExpiredPage(): string {
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>Genie と話す</title>
<style>:root{--bg:#F7F8FA;--text:#17191D;--muted:#667085}@media (prefers-color-scheme: dark){:root{--bg:#0F1115;--text:#F1F2F4;--muted:#9AA1AE}}body{margin:0;background:var(--bg);color:var(--text);font:16px/1.6 -apple-system,"Hiragino Sans",system-ui,sans-serif}main{max-width:520px;margin:0 auto;padding:32px 16px}p{color:var(--muted)}</style></head>
<body><main><h1>このリンクは使えません</h1><p>リンクは 10 分・1 回だけ使えます。LINE で「電話して」ともう一度送ってください。</p></main></body></html>`;
}
