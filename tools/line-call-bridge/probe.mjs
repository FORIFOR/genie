// LINE 公式アカウントの管理画面を、Genie 専用の Chrome で開き、通話の仕組みを調べる（応答はしない）。
//
//   node tools/line-call-bridge/probe.mjs
//
// 1. 開いた Chrome で、LINE ビジネス ID に本人がログインする（この Chrome のプロファイルに残る）。
// 2. チャット設定 → 電話 で「音声通話」を利用するにしておく。
// 3. スマホの LINE から、この公式アカウントに電話をかけ、管理画面で本人が応答して少し話し、切る。
// 4. 出来事（WebRTC を使うか・相手の声の音量が取れるか・着信のボタンの文字）が記録に残る。
//
// 声の中身・相手の名前・メッセージは記録しない。記録は Genie の設定フォルダの line-call-bridge/ の下。
import { chromium } from 'playwright';
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

/** Genie の設定フォルダ（OS ごと）。 */
export function genieDataDir() {
  if (platform() === 'darwin') return join(homedir(), 'Library', 'Application Support', 'Genie');
  if (platform() === 'win32') return join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'Genie');
  return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'genie');
}

/** 管理画面を開く Chrome。本人の Chrome とは別のプロファイル（ログインはここに残る）。 */
export async function openManager({ mode, onEvent, startUrl = 'https://chat.line.biz/', anyHost = false, profile = 'browser' }) {
  const base = join(genieDataDir(), 'line-call-bridge');
  mkdirSync(base, { recursive: true });
  const ctx = await chromium.launchPersistentContext(join(base, profile), {
    channel: 'chrome',
    headless: false,
    viewport: null,
    args: ['--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'],
    permissions: ['microphone', 'notifications'],
  });
  await ctx.exposeBinding('__genieBridgeEvent', (source, json) => {
    try {
      onEvent(JSON.parse(json), source.page);
    } catch {}
  });
  await ctx.addInitScript({
    content: `window.__genieMode = ${JSON.stringify(mode)};${anyHost ? ' window.__genieAnyHost = true;' : ''}`,
  });
  await ctx.addInitScript({ content: readFileSync(join(here, 'inject.js'), 'utf8') });
  for (const origin of ['https://manager.line.biz', 'https://chat.line.biz'])
    await ctx.grantPermissions(['microphone', 'notifications'], { origin });
  const page = ctx.pages()[0] ?? (await ctx.newPage());
  await page.goto(startUrl, { waitUntil: 'domcontentloaded' });
  return { ctx, page, base };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  let file = null;
  const { ctx, base } = await openManager({
    mode: 'probe',
    onEvent: (event) => {
      const line = JSON.stringify(event);
      if (event.type !== 'level' || event.rms > 0) console.log(line);
      if (file) appendFileSync(file, `${line}\n`);
    },
  });
  file = join(base, `probe-${stamp}.jsonl`);
  console.log(`記録: ${file}`);
  console.log('ログインして、スマホの LINE から電話をかけてください。終わったら Chrome を閉じます。');
  ctx.on('page', (p) => console.log(JSON.stringify({ type: 'page.opened', host: new URL(p.url() || 'about:blank').host })));
  await new Promise((resolve) => ctx.on('close', resolve));
}
