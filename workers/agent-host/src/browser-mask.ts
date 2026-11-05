/**
 * LINE へ送る画面から、見せてはいけないところを隠す（本人の設計 2026-11-05「機密情報を検出してマスキングする」）。
 *
 * ページそのものは書き換えない。画面のいちばん上に、隠す場所だけ黒い四角を並べた層を一時的に重ね、
 * 撮ったら層を外す。隠すもの:
 *   - パスワード・カード番号・セキュリティコード・確認コード（ワンタイム）・暗証番号の欄
 *   - カード会社の入力枠（Stripe などの iframe。中は読めないので枠ごと）
 *   - 画面の文や欄の値のうち、カード番号の形（13〜19 桁で Luhn が合う）のもの
 * 層を重ねられなかったら、撮らない（隠せない画面は送らない）。
 */

/** 隠す欄の目印。名前・id の大文字小文字は問わない。 */
const SENSITIVE = [
  'input[type=password]',
  'input[autocomplete^="cc-"]',
  'input[autocomplete="one-time-code"]',
  'input[autocomplete="current-password"]',
  'input[autocomplete="new-password"]',
  ...['card', 'cvc', 'cvv', 'csc', 'security', 'secret', 'pin', 'otp', 'passcode'].flatMap((w) => [
    `input[name*="${w}" i]`,
    `input[id*="${w}" i]`,
  ]),
  'iframe[src*="stripe" i]',
  'iframe[name*="card" i]',
  'iframe[title*="card" i]',
  'iframe[title*="カード"]',
].join(',');

export const MASK_LAYER_ID = '__genie_mask_layer';

/** 層を重ねて、隠した場所の数を返す（数でなければ失敗）。 */
export const MASK_ON = `(() => {
  const old = document.getElementById(${JSON.stringify(MASK_LAYER_ID)});
  if (old) old.remove();
  const root = document.body || document.documentElement;
  const boxes = [];
  const add = (r) => {
    if (!r || r.width <= 0 || r.height <= 0) return;
    if (r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth) return;
    boxes.push(r);
  };
  const luhn = (d) => {
    let sum = 0, alt = false;
    for (let i = d.length - 1; i >= 0; i--) {
      let n = d.charCodeAt(i) - 48;
      if (alt) { n *= 2; if (n > 9) n -= 9; }
      sum += n; alt = !alt;
    }
    return sum % 10 === 0;
  };
  const card = (s) => { const d = (s || '').replace(/\\D/g, ''); return d.length >= 13 && d.length <= 19 && luhn(d); };
  document.querySelectorAll(${JSON.stringify(SENSITIVE)}).forEach((e) => add(e.getBoundingClientRect()));
  document.querySelectorAll('input, textarea').forEach((e) => { if (card(e.value)) add(e.getBoundingClientRect()); });
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const re = /\\d(?:[ -]?\\d){12,18}/g;
  let node, seen = 0;
  while ((node = walker.nextNode()) && seen < 5000) {
    seen++;
    const t = node.nodeValue;
    if (!t || t.length < 13) continue;
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(t))) {
      if (!card(m[0])) continue;
      const range = document.createRange();
      range.setStart(node, m.index);
      range.setEnd(node, m.index + m[0].length);
      for (const r of range.getClientRects()) add(r);
    }
  }
  const layer = document.createElement('div');
  layer.id = ${JSON.stringify(MASK_LAYER_ID)};
  layer.setAttribute('aria-hidden', 'true');
  layer.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483647;';
  for (const r of boxes) {
    const b = document.createElement('div');
    b.style.cssText = 'position:fixed;background:#1b1b1f;border-radius:4px;left:' + (r.left - 3) + 'px;top:' + (r.top - 3) + 'px;width:' + (r.width + 6) + 'px;height:' + (r.height + 6) + 'px;';
    layer.appendChild(b);
  }
  root.appendChild(layer);
  return boxes.length;
})()`;

export const MASK_OFF = `(() => { const l = document.getElementById(${JSON.stringify(MASK_LAYER_ID)}); if (l) l.remove(); return true; })()`;
