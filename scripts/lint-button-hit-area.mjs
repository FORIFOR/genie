// ボタンの高さ・余白がラベルの外に付いていないか（背景と押せる範囲が文字だけになる誤り）。
//
//   Button { … } label: { Text("開く") }      ← ここで閉じる
//       .frame(height: 32).padding(.horizontal, 16)   ← 外に付いている（誤り）
//       .buttonStyle(GenieControlStyle(…))
//
// 2026-09-29、結果の「開く」「コピー」が詰まって見え、押せるのが文字だけだった。止めるボタンでも一度直した誤り。
// 見分け方: Button / ProbeButton を開いた行と同じ字下げで閉じた `}` の直後（buttonStyle まで）に `.frame(height:` がある。
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const root = process.argv[2] ?? 'apps/genie-macos/Sources/GenieMac';
const files = [];
const walk = (d) => { for (const n of readdirSync(d)) { const p = join(d, n); statSync(p).isDirectory() ? walk(p) : p.endsWith('.swift') && files.push(p); } };
walk(root);
const indent = (l) => l.match(/^\s*/)[0].length;
const problems = new Set();
for (const f of files) {
  const lines = readFileSync(f, 'utf8').split('\n');
  const opens = [];
  lines.forEach((l, i) => { if (/\b(Button|ProbeButton)\s*[({]/.test(l) && !/^\s*\/\//.test(l)) opens.push({ i, ind: indent(l) }); });
  for (const o of opens) {
    // その Button を閉じる `}`（同じ字下げで `}` だけの行）を探す。
    let close = -1;
    // ラベルを 1 行で閉じた書き方（`ProbeButton(…) { Text("…") }`）は、その行を閉じとして扱う（先に見る）。
    for (let j = o.i; j < Math.min(lines.length, o.i + 6) && close < 0; j++)
      if (/\{\s*Text\([^)]*\)\s*\}\s*$/.test(lines[j] ?? '')) close = j;
    if (close < 0) for (let j = o.i + 1; j < Math.min(lines.length, o.i + 40); j++) {
      if (/^\s*\}\s*$/.test(lines[j]) && indent(lines[j]) === o.ind) { close = j; break; }
      if (/^\s*\}\s*$/.test(lines[j]) && indent(lines[j]) < o.ind) break;
    }
    if (close < 0) continue;
    for (let k = close + 1; k < Math.min(lines.length, close + 6); k++) {
      if (/\.buttonStyle\(/.test(lines[k])) break;
      if (/\.frame\(height:/.test(lines[k])) { problems.add(`${relative(process.cwd(), f)}:${k + 1}`); break; }
    }
  }
}
if (problems.size) {
  console.log(`BUTTON_HIT_AREA_FAIL: ${problems.size} 箇所で高さ・余白がボタンのラベルの外にある（中へ移す）`);
  for (const p of problems) console.log('  ' + p);
  process.exit(1);
}
console.log(`BUTTON_HIT_AREA_OK: ${files.length} ファイル、ボタンの高さ・余白はラベルの中`);
