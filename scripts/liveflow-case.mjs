#!/usr/bin/env node
// liveflow S5（書類の案）用: ~/Documents/Genie検証用/端末更新 に見積り・提案書・説明を作り直す。
// いちばん新しい案件として見つかるように、毎回作る。原本は Genie が変えない（案は隣の「Genie案」に出る）。
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const dir = join(homedir(), 'Documents', 'Genie検証用', '端末更新');
rmSync(dir, { recursive: true, force: true });
mkdirSync(dir, { recursive: true });
const cli = (...args) => execFileSync(process.env.GENIE_OFFICECLI ?? '/opt/homebrew/bin/officecli', args, { cwd: dir, stdio: 'pipe', env: { ...process.env, OFFICECLI_RESIDENT_FLUSH: 'each' } });
const set = (cell, props) => ({ command: 'set', path: `/Sheet1/${cell}`, props });
cli('create', '見積.xlsx');
cli('batch', '見積.xlsx', '--commands', JSON.stringify([
  ...[['A1', '品目'], ['B1', '数量'], ['C1', '単価'], ['D1', '金額'], ['A2', '業務用端末'], ['B2', '100'], ['C2', '12000'],
      ['A3', '保守（年）'], ['B3', '1'], ['C3', '100000'], ['A4', '合計']].map(([c, value]) => set(c, { value })),
  ...[['D2', 'B2*C2'], ['D3', 'B3*C3'], ['D4', 'SUM(D2:D3)']].map(([c, formula]) => set(c, { formula })),
]));
cli('create', '提案書.docx');
cli('batch', '提案書.docx', '--commands', JSON.stringify(['本提案では業務用端末を100台導入します。', '導入費用は合計1,300,000円（税抜）です。', '納品後100日間の無償サポートを含みます。']
  .map((text) => ({ command: 'add', parent: '/body', type: 'paragraph', props: { text } }))));
cli('create', '説明.pptx');
cli('batch', '説明.pptx', '--commands', JSON.stringify([{ command: 'add', parent: '/', type: 'slide', props: {} },
  ...['端末 100台 / 総額 130万円', 'サポート 100日'].map((text, i) => ({ command: 'add', parent: '/slide[1]', type: 'shape', props: { text, x: '1cm', y: `${2 + i * 3}cm`, width: '20cm', height: '2cm' } }))]));
console.log(`case ready: ${dir}`);
