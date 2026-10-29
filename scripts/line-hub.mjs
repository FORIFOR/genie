#!/usr/bin/env node
/**
 * LINE の中継（公式アカウント 1 つ。docs/LINE_HUB.ja.md）を手元で動かす・この Genie を登録する。
 *
 *   pnpm line-hub serve                     中継を 127.0.0.1:8790 で動かす（LINE の鍵はキーチェーンから）
 *   pnpm line-hub register <中継の https URL> この Genie を中継に登録し、鍵をキーチェーンに、場所を channels.env に置く
 *
 * 中継を公開の場所に置くときは、運営者がそこで `genie-line-hub` を動かす（鍵はその場所の秘密の置き場へ）。
 */
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readSecret, writeSecret } from './local-preview/secrets.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const SUPPORT = join(homedir(), 'Library/Application Support/Genie');

async function serve() {
  const secret = await readSecret('line-channel-secret');
  const token = await readSecret('line-access-token');
  if (!secret || !token)
    throw new Error(
      'キーチェーンに line-channel-secret と line-access-token を入れてください（pnpm secrets set …）。',
    );
  // 登録の合言葉。無ければ作ってキーチェーンに置く（中継の /installs を外から叩かれないように）
  let registration = await readSecret('line-hub-registration');
  if (!registration) {
    registration = randomBytes(24).toString('base64url');
    await writeSecret('line-hub-registration', registration);
  }
  const child = spawn(process.execPath, [join(REPO, 'services/line-hub/dist/main.js')], {
    stdio: 'inherit',
    env: {
      PATH: process.env.PATH ?? '',
      HOME: homedir(),
      LINE_CHANNEL_SECRET: secret,
      LINE_CHANNEL_ACCESS_TOKEN: token,
      HUB_REGISTRATION_TOKEN: registration,
      HUB_PORT: process.env.HUB_PORT ?? '8790',
      HUB_DB: process.env.HUB_DB ?? join(SUPPORT, 'line-hub.sqlite'),
    },
  });
  const stop = () => child.kill('SIGTERM');
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  child.on('exit', (code) => process.exit(code ?? 0));
}

async function register(base) {
  if (!/^https?:\/\//.test(base ?? ''))
    throw new Error('中継の URL（https://…）を付けてください。');
  const origin = base.replace(/\/+$/, '');
  const registration = await readSecret('line-hub-registration');
  const res = await fetch(`${origin}/installs`, {
    method: 'POST',
    headers: registration ? { authorization: `Bearer ${registration}` } : {},
  });
  if (res.status !== 201) throw new Error(`中継に登録できませんでした（${String(res.status)}）。`);
  const { install_id: id, secret } = await res.json();
  await writeSecret('line-hub', `${id}:${secret}`);
  // 場所は鍵ではないので channels.env に（鍵はキーチェーン）
  const file = join(SUPPORT, 'channels.env');
  const wsUrl = `${origin.replace(/^http/, 'ws')}/connect`;
  const text = await readFile(file, 'utf8').catch(() => '');
  const lines = text.split(/\r?\n/).filter((l) => !/^\s*GENIE_LINE_HUB_URL\s*=/.test(l));
  lines.push(`GENIE_LINE_HUB_URL=${wsUrl}`);
  await writeFile(file, lines.join('\n').replace(/\n*$/, '\n'), { mode: 0o600 });
  console.log(
    `登録しました（${id}）。鍵はキーチェーン、場所は channels.env の GENIE_LINE_HUB_URL に置きました。`,
  );
}

const [command, arg] = process.argv.slice(2);
(command === 'serve'
  ? serve()
  : command === 'register'
    ? register(arg)
    : Promise.reject(new Error('使い方: pnpm line-hub serve | register <中継の URL>'))
).catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
