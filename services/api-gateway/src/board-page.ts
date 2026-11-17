/**
 * Action Board のページ（LINE のリンクから開く。読むだけ）。外部のスクリプト・フォントは読まない。
 *
 *   開く → 同じリンクの /state（JSON）を読む → 15 秒ごとに読み直す（グループで決まったことが、そのまま映る）
 *
 * 中身は textContent で入れる（会話から来た語を HTML として解釈しない）。
 * 変えるのは LINE のグループで（「@Genie 2番目にする」「@Genie 決めて」）。ページはそれを映すだけ。
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
  body { font:16px/1.55 -apple-system, "Hiragino Sans", system-ui, sans-serif; }
  main { max-width:560px; margin:0 auto; padding:calc(16px + env(safe-area-inset-top)) 16px calc(28px + env(safe-area-inset-bottom)); }
  .brand { color:var(--muted); font-size:12px; letter-spacing:.08em; text-transform:uppercase; }
  h1 { font-size:24px; line-height:1.3; margin:4px 0 8px; overflow-wrap:anywhere; }
  .status { display:inline-block; font-size:13px; font-weight:600; padding:3px 10px; border-radius:999px;
            background:var(--warn-soft); color:var(--warn); }
  .status.decided { background:var(--accent-soft); color:var(--accent); }
  section { background:var(--card); border:1px solid var(--line); border-radius:14px; padding:14px 16px; margin-top:14px; }
  h2 { font-size:14px; color:var(--muted); font-weight:600; margin:0 0 8px; }
  ul { margin:0; padding:0; list-style:none; }
  li { padding:6px 0; border-top:1px solid var(--line); overflow-wrap:anywhere; }
  li:first-child { border-top:0; }
  .chips { display:flex; flex-wrap:wrap; gap:6px; }
  .chip { font-size:14px; padding:4px 10px; border-radius:999px; border:1px solid var(--line); }
  .place { display:flex; gap:10px; align-items:flex-start; }
  .place .no { flex:none; width:24px; height:24px; border-radius:50%; display:grid; place-items:center; font-size:13px;
               font-weight:700; background:var(--line); }
  .place.chosen .no { background:var(--accent); color:#fff; }
  .place .name { font-weight:600; }
  .place .meta { color:var(--muted); font-size:13px; }
  .place a { color:var(--accent); font-size:14px; text-decoration:none; }
  .bar { height:6px; border-radius:3px; background:var(--line); margin-top:4px; overflow:hidden; }
  .bar i { display:block; height:100%; background:var(--accent); }
  .date { display:flex; justify-content:space-between; gap:12px; }
  .time { color:var(--muted); font-size:13px; margin-right:8px; }
  .hint { color:var(--muted); font-size:13px; margin-top:14px; }
  .empty { color:var(--muted); font-size:14px; }
`;

const SCRIPT = `
  const $ = (id) => document.getElementById(id);
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
  const list = (id, items, empty) => {
    const ul = $(id); ul.replaceChildren();
    if (!items.length) { ul.append(el('li', 'empty', empty)); return; }
    for (const t of items) ul.append(el('li', '', t));
  };
  const timeOf = (iso) => new Date(iso).toLocaleString('ja-JP', { month:'numeric', day:'numeric', hour:'2-digit', minute:'2-digit' });
  function render(b) {
    document.title = b.title + ' — Genie';
    $('title').textContent = b.title;
    const st = $('status');
    st.textContent = b.status === 'decided' ? '決まりました' : b.status === 'closed' ? '終了' : '計画中';
    st.className = 'status' + (b.status === 'decided' ? ' decided' : '');
    const chips = $('wants'); chips.replaceChildren();
    for (const w of b.wants) chips.append(el('span', 'chip', w));
    $('wants-section').hidden = b.wants.length === 0;
    list('decided', b.decided, 'まだありません');
    list('open', b.open, 'ありません');
    const places = $('places'); places.replaceChildren();
    b.candidates.forEach((p, i) => {
      const li = el('li', 'place' + (p.chosen ? ' chosen' : ''));
      li.append(el('span', 'no', String(i + 1)));
      const body = el('div');
      body.append(el('div', 'name', p.name + (p.chosen ? '（決定）' : '')));
      const meta = [p.kind, p.rating != null ? '★' + p.rating.toFixed(1) + (p.ratingCount != null ? '（' + p.ratingCount.toLocaleString('ja-JP') + '件）' : '') : null,
                    p.openAt === true ? '指定の時間は営業時間内' : p.openAt === false ? '指定の時間は営業時間外かも' : null].filter(Boolean).join(' · ');
      if (meta) body.append(el('div', 'meta', meta));
      if (p.address) body.append(el('div', 'meta', p.address));
      if (p.mapsUri && /^https:\\/\\//.test(p.mapsUri)) { const a = el('a', '', '地図で見る'); a.href = p.mapsUri; a.target = '_blank'; a.rel = 'noopener noreferrer'; body.append(a); }
      li.append(body); places.append(li);
    });
    $('places-section').hidden = b.candidates.length === 0;
    const sch = $('schedule'); sch.replaceChildren();
    if (b.schedule) {
      $('schedule-title').textContent = '日程（' + b.schedule.voters + ' 人が回答）';
      for (const d of b.schedule.dates) {
        const li = el('li');
        const row = el('div', 'date');
        row.append(el('span', '', d.label + (b.schedule.decided === d.date ? '（決定）' : '')), el('span', 'meta', d.yes + ' 人 OK'));
        const bar = el('div', 'bar'); const fill = el('i'); fill.style.width = (b.schedule.voters ? Math.round(d.yes / b.schedule.voters * 100) : 0) + '%'; bar.append(fill);
        li.append(row, bar); sch.append(li);
      }
    }
    $('schedule-section').hidden = !b.schedule;
    const ev = $('events'); ev.replaceChildren();
    if (!b.events.length) ev.append(el('li', 'empty', 'まだありません'));
    for (const e of b.events) { const li = el('li'); li.append(el('span', 'time', timeOf(e.at)), document.createTextNode(e.text)); ev.append(li); }
    $('updated').textContent = '更新: ' + timeOf(b.updatedAt);
  }
  async function load() {
    try {
      const res = await fetch(location.pathname.replace(/\\/$/, '') + '/state', { cache: 'no-store' });
      if (res.status === 410) { $('gone').hidden = false; $('board').hidden = true; return; }
      if (res.ok) render(await res.json());
    } catch {}
  }
  load(); setInterval(() => { if (!document.hidden) load(); }, 15000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) load(); });
`;

export function boardPage(): string {
  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex">
<title>みんなの計画 — Genie</title>
<style>${STYLE}</style>
</head>
<body>
<main>
  <div class="brand">Genie · Group Space</div>
  <div id="board">
    <h1 id="title">読み込み中…</h1>
    <span class="status" id="status">計画中</span>
    <section id="wants-section" hidden><h2>みんなの希望</h2><div class="chips" id="wants"></div></section>
    <section><h2>決まったこと</h2><ul id="decided"></ul></section>
    <section><h2>まだ決まっていないこと</h2><ul id="open"></ul></section>
    <section id="places-section" hidden><h2>場所の候補</h2><ul id="places"></ul></section>
    <section id="schedule-section" hidden><h2 id="schedule-title">日程</h2><ul id="schedule"></ul></section>
    <section><h2>これまでの動き</h2><ul id="events"></ul></section>
    <p class="hint">決めるときは LINE のグループで「@Genie 2番目にする」「@Genie 決めて」と送ってください。このページはそれを映します（読むだけ）。評価・営業時間は Google マップの情報で、空席・予約はまだ確かめていません。</p>
    <p class="hint" id="updated"></p>
  </div>
  <div id="gone" hidden><h1>このリンクは使えません</h1><p class="hint">期限が切れたか、計画が終わりました。LINE のグループで「@Genie ボード」と送ると、新しいリンクを出します。</p></div>
</main>
<script>${SCRIPT}</script>
</body>
</html>`;
}
