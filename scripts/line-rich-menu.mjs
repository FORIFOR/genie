#!/usr/bin/env node
/**
 * LINE のリッチメニュー（仕事・電話・予定・使い方）。定義は services/channels/src/rich-menu.ts。
 *
 *   node scripts/line-rich-menu.mjs render   画像（line-rich-menu/menu.html → menu.png）を作る。外へは出ない
 *   node scripts/line-rich-menu.mjs status   いま友だち全員に出ているメニューと、登録済みのメニューを見る（読むだけ）
 *   node scripts/line-rich-menu.mjs apply    メニューを登録し、友だち全員の既定にする（**LINE のアカウントの見た目が変わる**）
 *   node scripts/line-rich-menu.mjs remove   既定のメニューを外す（登録は残す。元に戻す道）
 *
 * apply は本人の許可のあとでだけ流す。古い同名のメニューは消さない（消すときは LINE Developers で）。
 * 鍵（チャネルのアクセストークン）はキーチェーンの line-access-token から読み、表示しない。
 */
import { createRequire } from 'node:module';
import { readdirSync, existsSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readSecret } from './local-preview/secrets.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIR = join(REPO, 'scripts/line-rich-menu');
const PNG = join(DIR, 'menu.png');
const API = 'https://api.line.me/v2/bot';
const DATA_API = 'https://api-data.line.me/v2/bot';

async function definition() {
  const dist = join(REPO, 'services/channels/dist/rich-menu.js');
  if (!existsSync(dist))
    throw new Error('先に pnpm --filter @genie/service-channels build を流してください。');
  return import(pathToFileURL(dist).href);
}

/** この Mac にある画面なしの Chromium（新しい版から）。新しく入れない。 */
function headlessShell() {
  const cache = join(homedir(), 'Library/Caches/ms-playwright');
  const dirs = existsSync(cache)
    ? readdirSync(cache)
        .map((d) => /^chromium_headless_shell-(\d+)$/.exec(d))
        .filter(Boolean)
        .sort((a, b) => Number(b[1]) - Number(a[1]))
    : [];
  for (const m of dirs)
    for (const arch of ['chrome-headless-shell-mac-arm64', 'chrome-headless-shell-mac-x64']) {
      const path = join(cache, m[0], arch, 'chrome-headless-shell');
      if (existsSync(path)) return path;
    }
  return null;
}

async function render() {
  const { RICH_MENU_SIZE } = await definition();
  // 画像を作るだけ。Playwright は tools/meet-bot に入っているものを使う
  const require = createRequire(join(REPO, 'tools/meet-bot/package.json'));
  const { chromium } = require('playwright');
  const executablePath = headlessShell();
  if (!executablePath)
    throw new Error('画面なしの Chromium が見つかりません（~/Library/Caches/ms-playwright）。');
  const browser = await chromium.launch({ executablePath });
  try {
    const page = await browser.newPage({
      viewport: { width: RICH_MENU_SIZE.width, height: RICH_MENU_SIZE.height },
    });
    await page.goto(pathToFileURL(join(DIR, 'menu.html')).href);
    await page.screenshot({ path: PNG, type: 'png' });
  } finally {
    await browser.close();
  }
  const { size } = await stat(PNG);
  // LINE の上限は 1 MB
  if (size > 1024 * 1024) throw new Error(`画像が大きすぎます（${size} バイト）。`);
  console.log(
    `作りました: ${PNG}（${RICH_MENU_SIZE.width}×${RICH_MENU_SIZE.height}、${size} バイト）`,
  );
}

async function token() {
  const value = await readSecret('line-access-token');
  if (!value)
    throw new Error(
      'キーチェーンに line-access-token がありません（pnpm secrets set line-access-token）。中継の公式アカウントなら、中継の運営者が流してください。',
    );
  return value;
}

async function call(method, url, auth, body, contentType = 'application/json') {
  const res = await fetch(url, {
    method,
    headers: {
      authorization: `Bearer ${auth}`,
      ...(body !== undefined ? { 'content-type': contentType } : {}),
    },
    ...(body !== undefined
      ? { body: contentType === 'application/json' ? JSON.stringify(body) : body }
      : {}),
    signal: AbortSignal.timeout(20_000),
  });
  const text = await res.text();
  if (!res.ok && !(method === 'GET' && res.status === 404))
    throw new Error(
      `LINE が断りました（${method} ${new URL(url).pathname} → ${res.status}: ${text.slice(0, 200)}）`,
    );
  return res.status === 404 ? null : text ? JSON.parse(text) : {};
}

async function status() {
  const auth = await token();
  const current = await call('GET', `${API}/user/all/richmenu`, auth);
  const list = await call('GET', `${API}/richmenu/list`, auth);
  console.log(`いまの既定: ${current?.richMenuId ?? '（なし）'}`);
  for (const m of list?.richmenus ?? []) console.log(`登録済み: ${m.richMenuId}  ${m.name}`);
}

async function apply() {
  const { richMenuBody } = await definition();
  if (!existsSync(PNG)) throw new Error('先に render で画像を作ってください。');
  const auth = await token();
  const body = richMenuBody();
  await call('POST', `${API}/richmenu/validate`, auth, body);
  const { richMenuId } = await call('POST', `${API}/richmenu`, auth, body);
  await call(
    'POST',
    `${DATA_API}/richmenu/${richMenuId}/content`,
    auth,
    await readFile(PNG),
    'image/png',
  );
  await call('POST', `${API}/user/all/richmenu/${richMenuId}`, auth);
  console.log(`登録して、友だち全員の既定にしました: ${richMenuId}（${body.name}）`);
  console.log('外すときは: node scripts/line-rich-menu.mjs remove');
}

async function remove() {
  const auth = await token();
  await call('DELETE', `${API}/user/all/richmenu`, auth);
  console.log('既定のメニューを外しました（登録は残しています）。');
}

const commands = { render, status, apply, remove };
const name = process.argv[2];
if (!commands[name]) {
  console.log('使い方: node scripts/line-rich-menu.mjs render | status | apply | remove');
  process.exit(name ? 1 : 0);
}
commands[name]().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
