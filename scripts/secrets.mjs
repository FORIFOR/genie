#!/usr/bin/env node
/**
 * Genie の API キー・鍵を、キーチェーン 1 か所で扱う（docs/SECRETS.ja.md）。値は画面にもログにも出さない。
 *
 *   pnpm secrets status                 どの鍵が入っているか（値は出さない）
 *   pnpm secrets set <名前>              鍵を入れる（入力は表示しない）。名前は status の一覧
 *   pnpm secrets delete <名前>
 *   pnpm secrets import <ファイル>       KEY=VALUE のファイルにある鍵をキーチェーンへ移し、ファイルから消す
 */
import { readFile, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { spawnSync } from 'node:child_process';
import { SECRET_ENV, genieApp, secretStatus, writeSecret } from './local-preview/secrets.mjs';

const NAMES = new Set(Object.values(SECRET_ENV).concat(['google-maps', 'line-hub-registration']));

async function hiddenInput(prompt) {
  if (!process.stdin.isTTY) {
    const chunks = [];
    for await (const c of process.stdin) chunks.push(c);
    return Buffer.concat(chunks).toString('utf8').trim();
  }
  process.stdout.write(prompt);
  spawnSync('stty', ['-echo'], { stdio: 'inherit' });
  const rl = createInterface({ input: process.stdin });
  const line = await new Promise((r) => rl.once('line', r));
  rl.close();
  spawnSync('stty', ['echo'], { stdio: 'inherit' });
  process.stdout.write('\n');
  return String(line).trim();
}

async function main([command, arg]) {
  if (command === 'status') {
    for (const [name, state] of Object.entries(await secretStatus()))
      console.log(`${state === 'set' ? '✓' : '·'} ${name}${state === 'set' ? '' : '（未設定）'}`);
    return;
  }
  if ((command === 'set' || command === 'delete') && NAMES.has(arg)) {
    if (command === 'delete') {
      const r = spawnSync(genieApp(), ['--secret', 'delete', arg]);
      if (r.status !== 0) throw new Error(`${arg} を消せませんでした。`);
      console.log(`${arg} を消しました。`);
      return;
    }
    const value = await hiddenInput(`${arg} の値（表示されません）: `);
    if (!value) throw new Error('空の値は入れません。');
    await writeSecret(arg, value);
    console.log(`${arg} をキーチェーンに入れました。`);
    return;
  }
  if (command === 'import' && arg) {
    const text = await readFile(arg, 'utf8');
    const kept = [];
    const moved = [];
    for (const raw of text.split(/\r?\n/)) {
      const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(raw);
      const name = m ? SECRET_ENV[m[1]] : undefined;
      if (!m || !name) {
        kept.push(raw);
        continue;
      }
      const value = m[2].trim().replace(/^(['"])(.*)\1$/, '$2');
      if (value) {
        await writeSecret(name, value);
        moved.push(m[1]);
      }
      // 空の行も消す（鍵はキーチェーンだけに置く）
    }
    await writeFile(arg, kept.join('\n'), { mode: 0o600 });
    console.log(
      moved.length ? `キーチェーンへ移しました: ${moved.join(', ')}` : '移す鍵はありませんでした。',
    );
    return;
  }
  console.error('使い方: pnpm secrets status | set <名前> | delete <名前> | import <ファイル>');
  console.error(`名前: ${[...NAMES].join(', ')}`);
  process.exitCode = 2;
}

main(process.argv.slice(2)).catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
