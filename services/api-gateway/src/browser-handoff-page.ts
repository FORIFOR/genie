/**
 * ブラウザの引き継ぎのページ（LINE のリンクから開く。routes/browser-handoff.ts）。外部のスクリプト・フォントは読まない。
 * 見た目は仕事のホーム（work-page.ts）とそろえる。
 *
 *   開く → WebSocket で Genie 専用のブラウザの画面の流れを映す
 *   画面を押す → その位置を押す。上下に払う → スクロール。下の欄 → 文字を送る（Enter・削除・Tab のボタン）
 *   「Genie に戻す」→ Genie が画面を確かめて続ける（ログインが済めば押さなくても続ける）。「やめる」→ 止める
 *
 * 端末のブラウザでパスワードの欄が選ばれている間は、このページの入力欄も伏せ字にする。
 * 中身は textContent で入れる。画面の画像は data: で表示するだけで、保存しない。
 */
const STYLE = `
  :root { --bg:#F6F7F9; --card:#FFFFFF; --text:#14171F; --muted:#677084; --line:#E3E6EC;
          --accent:#0A7D5A; --accent-soft:#E3F4EE; --warn:#9A5B00; --warn-soft:#FFF3DF; }
  @media (prefers-color-scheme: dark) {
    :root { --bg:#0F1218; --card:#181C24; --text:#F2F4F8; --muted:#9AA3B5; --line:#2A303C;
            --accent:#4CC79A; --accent-soft:#16352A; --warn:#F2B35E; --warn-soft:#3A2C14; }
  }
  * { box-sizing:border-box; }
  [hidden] { display:none !important; }
  html, body { margin:0; background:var(--bg); color:var(--text); }
  body { font:16px/1.5 -apple-system, "Hiragino Sans", system-ui, sans-serif; }
  main { max-width:560px; margin:0 auto; padding:calc(12px + env(safe-area-inset-top)) 12px calc(16px + env(safe-area-inset-bottom)); }
  .brand { color:var(--muted); font-size:12px; letter-spacing:.08em; text-transform:uppercase; }
  h1 { font-size:20px; line-height:1.3; margin:2px 0 6px; }
  .note { background:var(--warn-soft); color:var(--warn); border-radius:12px; padding:10px 12px; font-size:14px; }
  .status { color:var(--muted); font-size:13px; margin:8px 0; }
  .screen { position:relative; background:var(--card); border:1px solid var(--line); border-radius:12px; overflow:hidden;
            touch-action:none; min-height:200px; }
  .screen img { display:block; width:100%; height:auto; user-select:none; -webkit-user-drag:none; }
  .screen .wait { position:absolute; inset:0; display:flex; align-items:center; justify-content:center; color:var(--muted); font-size:14px; }
  .type { display:flex; gap:8px; margin-top:10px; }
  .type input { flex:1; min-width:0; font-size:16px; padding:10px 12px; border-radius:10px; border:1px solid var(--line);
                background:var(--card); color:var(--text); }
  button { font:inherit; border-radius:10px; border:1px solid var(--line); background:var(--card); color:var(--text);
           padding:10px 12px; }
  .keys { display:flex; gap:8px; margin-top:8px; }
  .keys button { flex:1; font-size:14px; }
  .actions { display:flex; gap:8px; margin-top:12px; }
  .actions .primary { flex:2; background:var(--accent); border-color:var(--accent); color:#fff; font-weight:700; }
  .actions .quiet { flex:1; color:var(--muted); }
  .secret { color:var(--muted); font-size:12px; margin-top:6px; }
  .done { background:var(--accent-soft); color:var(--accent); border-radius:12px; padding:14px; font-weight:600; margin-top:12px; }
`;

const SCRIPT = `
  const $ = (id) => document.getElementById(id);
  const wsUrl = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + location.pathname.replace(/\\/$/, '') + '/ws';
  let ws = null, frame = null, ended = false, retry = 0;
  const ENDED = {
    resumed: 'Genie が続きを進めています。この画面は閉じてかまいません。',
    timed_out: 'このリンクの時間が切れました。LINE でもう一度頼んでください（ログインは Genie のブラウザに残っています）。',
    cancelled: '止めました。',
    failed: 'Genie のブラウザが止まりました。LINE でもう一度頼んでください。',
  };
  function finish(state) {
    ended = true;
    $('live').hidden = true;
    $('done').hidden = false;
    $('done').textContent = ENDED[state] || ENDED.timed_out;
    try { ws && ws.close(); } catch {}
  }
  function send(msg) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg)); }
  function connect() {
    ws = new WebSocket(wsUrl);
    ws.onopen = () => { retry = 0; $('status').textContent = 'つながりました。画面を押すと、その場所を押します。'; };
    ws.onmessage = (event) => {
      let m; try { m = JSON.parse(event.data); } catch { return; }
      if (m.type === 'ended') return finish(m.state);
      if (m.type === 'frame') {
        frame = m;
        $('shot').src = 'data:image/jpeg;base64,' + m.jpeg;
        $('shot').hidden = false;
        $('wait').hidden = true;
        $('text').type = m.password ? 'password' : 'text';
        $('secret').hidden = !m.password;
      }
    };
    ws.onclose = () => {
      if (ended) return;
      $('status').textContent = 'つなぎ直しています…';
      setTimeout(connect, Math.min(5000, 1000 * ++retry));
    };
  }
  // 画面の上の位置を、Genie のブラウザの画面の位置に直す
  const at = (clientX, clientY) => {
    const r = $('shot').getBoundingClientRect();
    return { x: Math.round((clientX - r.left) / r.width * frame.width), y: Math.round((clientY - r.top) / r.height * frame.height) };
  };
  let start = null;
  $('screen').addEventListener('pointerdown', (e) => { if (frame) start = { x: e.clientX, y: e.clientY }; });
  $('screen').addEventListener('pointerup', (e) => {
    if (!frame || !start) return;
    const dx = e.clientX - start.x, dy = e.clientY - start.y;
    const p = at(start.x, start.y);
    if (Math.abs(dx) < 8 && Math.abs(dy) < 8) send({ type: 'tap', x: p.x, y: p.y });
    else {
      const r = $('shot').getBoundingClientRect();
      const k = frame.width / r.width;
      send({ type: 'scroll', x: p.x, y: p.y, dx: Math.round(-dx * k), dy: Math.round(-dy * k) });
    }
    start = null;
  });
  $('form').addEventListener('submit', (e) => {
    e.preventDefault();
    const t = $('text').value;
    if (t) send({ type: 'text', text: t });
    $('text').value = '';
  });
  for (const b of document.querySelectorAll('[data-key]')) b.addEventListener('click', () => send({ type: 'key', name: b.dataset.key }));
  $('back').addEventListener('click', () => { send({ type: 'done' }); $('status').textContent = 'Genie が画面を確かめています…'; });
  $('cancel').addEventListener('click', () => send({ type: 'cancel' }));
  connect();
`;

export function handoffPage(): string {
  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex">
<title>ブラウザの操作 — Genie</title>
<style>${STYLE}</style>
</head>
<body>
<main>
  <div class="brand">Genie · Browser</div>
  <h1>ログインだけお願いします</h1>
  <div id="live">
    <p class="note">Genie 専用のブラウザの画面です。ログインが済むと、Genie が自分で続きを進めます。あなたが操作している間、Genie は入力しません。</p>
    <p class="status" id="status">つないでいます…</p>
    <div class="screen" id="screen"><img id="shot" alt="Genie のブラウザの画面" hidden><div class="wait" id="wait">画面を待っています…</div></div>
    <form class="type" id="form" autocomplete="off">
      <input id="text" type="text" placeholder="選んだ欄に入れる文字" autocomplete="off" autocapitalize="off" spellcheck="false">
      <button type="submit">送る</button>
    </form>
    <p class="secret" id="secret" hidden>パスワードの欄です。入れた文字は Genie の記録に残しません。</p>
    <div class="keys">
      <button type="button" data-key="Enter">Enter</button>
      <button type="button" data-key="Backspace">削除</button>
      <button type="button" data-key="Tab">次の欄</button>
    </div>
    <div class="actions">
      <button type="button" class="primary" id="back">Genie に戻す</button>
      <button type="button" class="quiet" id="cancel">やめる</button>
    </div>
  </div>
  <div class="done" id="done" hidden></div>
</main>
<script>${SCRIPT}</script>
</body>
</html>`;
}
