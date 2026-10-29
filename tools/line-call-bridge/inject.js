// LINE 公式アカウントの管理画面（ブラウザ）に入れる。ページより先に読み込む（Playwright の addInitScript）。
//
//   probe  … 通話の仕組みを調べるだけ。マイクも相手の声も変えない。送るのは出来事と音量（声の中身は送らない）
//   genie  … マイクの代わりに Genie の声を渡し、相手の声を 16 kHz PCM で Genie へ渡す
//
// 出来事は window.__genieBridgeEvent（Playwright の exposeBinding）へ JSON で送る。
// Genie の声は Node から window.__genieSpeak(base64 PCM16 24 kHz) で入れる。割り込みは window.__genieHush()。
(() => {
  if (window.__genieLineBridge) return;
  // 管理画面とチャットだけ。ログイン（account.line.biz）や reCAPTCHA には触れない
  if (!window.__genieAnyHost && !/(^|\.)(chat|manager)\.line\.biz$/.test(location.hostname)) return;
  window.__genieLineBridge = true;
  const mode = () => window.__genieMode || 'probe';
  const emit = (type, data = {}) => {
    try {
      const fn = window.__genieBridgeEvent;
      if (typeof fn === 'function') fn(JSON.stringify({ type, at: Date.now(), frame: window === window.top ? 'top' : 'sub', ...data }));
    } catch (_) {}
  };

  // ---- 相手の声（WebRTC の受信トラック） ----
  const SAMPLE_IN = 16000;
  let listening = null;
  const toBase64 = (bytes) => {
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s);
  };
  const listen = (track) => {
    if (listening) return;
    try {
      const ctx = new AudioContext({ sampleRate: SAMPLE_IN });
      const stream = new MediaStream([track]);
      // Chrome は受信トラックを媒体要素にもつながないと WebAudio に無音を渡すことがある
      const sink = new Audio();
      sink.muted = true;
      sink.srcObject = stream;
      sink.play().catch(() => {});
      const source = ctx.createMediaStreamSource(stream);
      const node = ctx.createScriptProcessor(2048, 1, 1);
      let level = 0;
      let frames = 0;
      node.onaudioprocess = (e) => {
        const input = e.inputBuffer.getChannelData(0);
        let sum = 0;
        for (let i = 0; i < input.length; i += 1) sum += input[i] * input[i];
        level = Math.max(level, Math.sqrt(sum / input.length));
        if (mode() === 'genie') {
          const pcm = new Int16Array(input.length);
          for (let i = 0; i < input.length; i += 1) pcm[i] = Math.max(-1, Math.min(1, input[i])) * 0x7fff;
          emit('audio', { data: toBase64(new Uint8Array(pcm.buffer)) });
        }
        // 音量は 1 秒に 1 回だけ（中身ではなく、聞こえているかを見る）
        frames += input.length;
        if (frames >= SAMPLE_IN) {
          emit('level', { rms: Math.round(level * 1000) / 1000 });
          frames = 0;
          level = 0;
        }
      };
      source.connect(node);
      node.connect(ctx.destination); // 処理を回すため（出力は 0 のまま）
      listening = { ctx, track };
      track.addEventListener('ended', () => {
        emit('remote.ended');
        try { ctx.close(); } catch (_) {}
        listening = null;
      });
      emit('remote.listening', { sampleRate: ctx.sampleRate });
    } catch (error) {
      emit('remote.failed', { error: String(error && error.message || error) });
    }
  };

  const Native = window.RTCPeerConnection;
  if (Native) {
    const Wrapped = function (...args) {
      const pc = new Native(...args);
      const servers = (args[0] && args[0].iceServers || []).map((s) => [].concat(s.urls || s.url || []).map((u) => String(u).split('?')[0].replace(/:[^:]*@/, ':***@'))).flat();
      emit('pc.created', { iceServers: servers.slice(0, 6) });
      pc.addEventListener('track', (e) => {
        emit('pc.track', { kind: e.track.kind, streams: e.streams.length });
        if (e.track.kind === 'audio') listen(e.track);
      });
      pc.addEventListener('connectionstatechange', () => emit('pc.state', { state: pc.connectionState }));
      const addTrack = pc.addTrack.bind(pc);
      pc.addTrack = (track, ...streams) => {
        emit('pc.addTrack', { kind: track.kind, label: track.label.slice(0, 40) });
        return addTrack(track, ...streams);
      };
      return pc;
    };
    Wrapped.prototype = Native.prototype;
    Object.setPrototypeOf(Wrapped, Native);
    window.RTCPeerConnection = Wrapped;
    if (window.webkitRTCPeerConnection) window.webkitRTCPeerConnection = Wrapped;
  } else emit('pc.missing');

  // WebRTC 以外で音を運ぶ作りかもしれない。行き先のホストだけ控える
  const NativeWS = window.WebSocket;
  if (NativeWS) {
    const WS = function (url, protocols) {
      try { emit('ws.open', { host: new URL(url, location.href).host }); } catch (_) {}
      return protocols === undefined ? new NativeWS(url) : new NativeWS(url, protocols);
    };
    WS.prototype = NativeWS.prototype;
    Object.setPrototypeOf(WS, NativeWS);
    window.WebSocket = WS;
  }

  // ---- Genie の声（マイクの代わり） ----
  const SAMPLE_OUT = 24000;
  let voice = null;
  const genieStream = () => {
    if (!voice) {
      const ctx = new AudioContext({ sampleRate: SAMPLE_OUT });
      const dest = ctx.createMediaStreamDestination();
      voice = { ctx, dest, at: 0, sources: new Set() };
    }
    return voice.dest.stream.clone();
  };
  window.__genieSpeak = (b64) => {
    if (!voice) genieStream();
    const bin = atob(b64);
    const pcm = new Int16Array(bin.length >> 1);
    for (let i = 0; i < pcm.length; i += 1) pcm[i] = (bin.charCodeAt(2 * i) | (bin.charCodeAt(2 * i + 1) << 8)) << 16 >> 16;
    const buffer = voice.ctx.createBuffer(1, pcm.length, SAMPLE_OUT);
    const ch = buffer.getChannelData(0);
    for (let i = 0; i < pcm.length; i += 1) ch[i] = pcm[i] / 0x8000;
    const src = voice.ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(voice.dest);
    const start = Math.max(voice.ctx.currentTime + 0.02, voice.at);
    src.start(start);
    voice.at = start + buffer.duration;
    voice.sources.add(src);
    src.onended = () => voice && voice.sources.delete(src);
  };
  window.__genieHush = () => {
    if (!voice) return;
    for (const s of voice.sources) try { s.stop(); } catch (_) {}
    voice.sources.clear();
    voice.at = 0;
  };

  const md = navigator.mediaDevices;
  if (md && md.getUserMedia) {
    const native = md.getUserMedia.bind(md);
    md.getUserMedia = async (constraints) => {
      const wantsAudio = !!(constraints && constraints.audio);
      const wantsVideo = !!(constraints && constraints.video);
      emit('gum', { audio: wantsAudio, video: wantsVideo, mode: mode() });
      // 声だけのときに限り、Genie の声をマイクとして渡す（ビデオ通話は扱わない）
      if (mode() === 'genie' && wantsAudio && !wantsVideo) return genieStream();
      return native(constraints);
    };
  }

  // ---- 着信の画面（ボタンの文字だけを控える。名前や本文は控えない） ----
  const CALL_WORDS = /通話|着信|応答|拒否|電話|call|answer|decline|accept/i;
  const seen = new Set();
  const scan = () => {
    for (const el of document.querySelectorAll('button, [role="button"], a')) {
      const label = (el.getAttribute('aria-label') || el.textContent || '').trim().replace(/\s+/g, ' ');
      if (!label || label.length > 30 || !CALL_WORDS.test(label)) continue;
      const key = `${label}|${el.className}`;
      if (seen.has(key)) continue;
      seen.add(key);
      emit('ui.button', { label, tag: el.tagName.toLowerCase(), cls: String(el.className).slice(0, 80), visible: !!el.offsetParent });
    }
  };
  const start = () => {
    new MutationObserver(() => { clearTimeout(start.t); start.t = setTimeout(scan, 150); }).observe(document.documentElement, { childList: true, subtree: true });
    scan();
  };
  if (document.documentElement) start();
  else document.addEventListener('DOMContentLoaded', start);
  emit('injected', { host: location.host, path: location.pathname.replace(/[0-9A-Za-z]{20,}/g, ':id') });
})();
