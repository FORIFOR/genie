/**
 * 仕事のホームのページ（LINE のリンクから開く。読むだけ。work-home.ts）。外部のスクリプト・フォントは読まない。
 * 見た目は計画ボード（board-page.ts）とそろえる（同じ色・同じカード）。
 *
 *   開く → /state を読む → 15 秒ごとに読み直す
 *   行を押す → #s/<id>・#t/<id> に移り、/item/s/<id>・/item/t/<id>（仕事の台帳）を読む。戻るで一覧へ
 *
 * いちばん上に「あなたの確認が必要」。無ければ「確認が必要なものはありません」と言い切る。
 * 中身は textContent で入れる（会話から来た語を HTML として解釈しない）。
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
  section { background:var(--card); border:1px solid var(--line); border-radius:14px; padding:14px 16px; margin-top:14px; }
  section.needs { border-color:var(--warn); background:var(--warn-soft); }
  section.needs h2 { color:var(--warn); }
  section.clear { background:var(--accent-soft); border-color:transparent; color:var(--accent); font-weight:600; }
  h2 { font-size:14px; color:var(--muted); font-weight:600; margin:0 0 8px; }
  ul { margin:0; padding:0; list-style:none; }
  li { padding:8px 0; border-top:1px solid var(--line); overflow-wrap:anywhere; }
  li:first-child { border-top:0; }
  .counts { display:grid; grid-template-columns:repeat(3, 1fr); gap:8px; margin-top:14px; }
  .count { background:var(--card); border:1px solid var(--line); border-radius:14px; padding:10px 12px; }
  .count b { display:block; font-size:24px; line-height:1.2; }
  .count span { color:var(--muted); font-size:12px; }
  a.row { display:flex; justify-content:space-between; align-items:center; gap:12px; color:inherit; text-decoration:none; }
  .row .name { font-weight:600; }
  .row .state { color:var(--muted); font-size:13px; }
  .row .state.needs { color:var(--warn); font-weight:600; }
  .row .chev { color:var(--muted); flex:none; }
  .next { font-size:17px; font-weight:600; }
  .crit { display:flex; gap:8px; }
  .mark { flex:none; font-size:12px; font-weight:700; padding:2px 8px; border-radius:999px; height:fit-content;
          background:var(--line); }
  .mark.met { background:var(--accent-soft); color:var(--accent); }
  .mark.unmet { background:var(--warn-soft); color:var(--warn); }
  .how { color:var(--muted); font-size:13px; }
  .time { color:var(--muted); font-size:13px; margin-right:8px; }
  .back { display:inline-block; color:var(--accent); text-decoration:none; font-size:15px; margin:4px 0 6px; }
  .hint { color:var(--muted); font-size:13px; margin-top:14px; }
  .empty { color:var(--muted); font-size:14px; }
`;

const SCRIPT = `
  const $ = (id) => document.getElementById(id);
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
  const base = location.pathname.replace(/\\/$/, '');
  const timeOf = (iso) => new Date(iso).toLocaleString('ja-JP', { month:'numeric', day:'numeric', hour:'2-digit', minute:'2-digit' });
  const list = (ul, items, empty) => { ul.replaceChildren(); if (!items.length) { ul.append(el('li', 'empty', empty)); return; } for (const t of items) ul.append(el('li', '', t)); };
  function renderHome(h) {
    const needs = $('needs');
    needs.className = h.attention.length ? 'needs' : 'clear';
    $('needs-title').textContent = h.attention.length ? 'あなたの確認が必要（' + h.attention.length + ' 件）' : '';
    $('needs-title').hidden = !h.attention.length;
    const ul = $('needs-list'); ul.replaceChildren();
    if (!h.attention.length) ul.append(el('li', '', '確認が必要なものはありません。Genie が進めています。'));
    for (const a of h.attention) ul.append(el('li', '', a));
    $('c-running').textContent = h.counts.running;
    $('c-needs').textContent = h.counts.needsUser;
    $('c-done').textContent = h.counts.doneToday;
    const items = $('items'); items.replaceChildren();
    if (!h.items.length) items.append(el('li', 'empty', 'いまある仕事はありません'));
    for (const it of h.items) {
      const li = el('li');
      const a = el('a', 'row'); a.href = '#' + (it.kind === 'session' ? 's' : 't') + '/' + it.id;
      const body = el('div');
      body.append(el('div', 'name', it.name), el('div', 'state' + (it.tone === 'needs' ? ' needs' : ''), it.state));
      a.append(body, el('span', 'chev', '›'));
      li.append(a); items.append(li);
    }
    $('holds-section').hidden = !h.holds.length; list($('holds'), h.holds, '');
    $('follow-section').hidden = !h.followups.length; list($('follows'), h.followups, '');
    $('updated').textContent = '更新: ' + timeOf(h.updatedAt);
  }
  function renderItem(l) {
    $('i-name').textContent = l.name;
    $('i-next').textContent = l.next;
    $('i-verify').textContent = l.verification;
    $('i-request-section').hidden = !l.request; $('i-request').textContent = l.request || '';
    const cr = $('i-criteria'); cr.replaceChildren();
    if (!l.criteria.length) cr.append(el('li', 'empty', 'まだありません。LINE で「〇〇の完了条件は△△」と送ると、それに照らして確かめます。'));
    for (const c of l.criteria) {
      const li = el('li', 'crit');
      li.append(el('span', 'mark ' + c.state, c.state === 'met' ? '済' : c.state === 'unmet' ? '未達' : '未確認'));
      const body = el('div'); body.append(el('div', '', c.text), el('div', 'how', c.how)); li.append(body); cr.append(li);
    }
    const tl = $('i-timeline'); tl.replaceChildren();
    if (!l.timeline.length) tl.append(el('li', 'empty', 'まだありません'));
    for (const e of l.timeline.slice(-20)) { const li = el('li'); li.append(el('span', 'time', timeOf(e.at)), document.createTextNode(e.text)); tl.append(li); }
    $('i-decisions-section').hidden = !l.decisions.length;
    const ds = $('i-decisions'); ds.replaceChildren();
    for (const d of l.decisions) { const li = el('li'); li.append(el('span', 'time', timeOf(d.at)), document.createTextNode(d.text)); ds.append(li); }
    $('i-artifacts-section').hidden = !l.artifacts.length; list($('i-artifacts'), l.artifacts.map((a) => a.title), '');
    $('i-notes').textContent = l.notes.join(' ');
  }
  function gone() { $('gone').hidden = false; $('home').hidden = true; $('item').hidden = true; }
  async function get(path) {
    const res = await fetch(base + path, { cache: 'no-store' });
    if (res.status === 410) { gone(); return null; }
    return res.ok ? res.json() : null;
  }
  async function load() {
    try {
      const m = /^#([st])\\/([0-9a-f-]{36})$/.exec(location.hash);
      $('home').hidden = !!m; $('item').hidden = !m;
      if (m) { const l = await get('/item/' + m[1] + '/' + m[2]); if (l) renderItem(l); }
      else { const h = await get('/state'); if (h) renderHome(h); }
    } catch {}
  }
  window.addEventListener('hashchange', () => { window.scrollTo(0, 0); load(); });
  load(); setInterval(() => { if (!document.hidden) load(); }, 15000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) load(); });
`;

export function workPage(): string {
  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex">
<title>仕事のホーム — Genie</title>
<style>${STYLE}</style>
</head>
<body>
<main>
  <div class="brand">Genie · Home</div>
  <div id="home">
    <h1>仕事のホーム</h1>
    <section id="needs" class="clear"><h2 id="needs-title" hidden></h2><ul id="needs-list"><li>読み込み中…</li></ul></section>
    <div class="counts">
      <div class="count"><b id="c-running">–</b><span>動いている</span></div>
      <div class="count"><b id="c-needs">–</b><span>確認が必要</span></div>
      <div class="count"><b id="c-done">–</b><span>今日終わった</span></div>
    </div>
    <section><h2>仕事</h2><ul id="items"></ul></section>
    <section id="holds-section" hidden><h2>保留中（進めません）</h2><ul id="holds"></ul></section>
    <section id="follow-section" hidden><h2>前の仕事が終わったら始めるもの</h2><ul id="follows"></ul></section>
    <p class="hint">このページは読むだけです。頼む・保留にする・完了条件を決めるのは LINE の会話で送ってください。「止まっているかも」は届いた時刻からの推測です。</p>
    <p class="hint" id="updated"></p>
  </div>
  <div id="item" hidden>
    <a class="back" href="#">‹ 仕事のホーム</a>
    <h1 id="i-name"></h1>
    <section><h2>次に要ること</h2><div class="next" id="i-next"></div></section>
    <section><h2>確かめ</h2><div id="i-verify"></div></section>
    <section id="i-request-section" hidden><h2>依頼</h2><div id="i-request"></div></section>
    <section><h2>完了条件</h2><ul id="i-criteria"></ul></section>
    <section><h2>経過</h2><ul id="i-timeline"></ul></section>
    <section id="i-decisions-section" hidden><h2>あなたの判断</h2><ul id="i-decisions"></ul></section>
    <section id="i-artifacts-section" hidden><h2>成果物</h2><ul id="i-artifacts"></ul></section>
    <p class="hint" id="i-notes"></p>
  </div>
  <div id="gone" hidden><h1>このリンクは使えません</h1><p class="hint">期限が切れました。LINE で「仕事のホームを開いて」と送ると、新しいリンクを出します。</p></div>
</main>
<script>${SCRIPT}</script>
</body>
</html>`;
}
