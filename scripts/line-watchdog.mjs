#!/usr/bin/env node
/**
 * Genie と LINE の受け口の見張り。止まったら本人の LINE へ 1 回知らせ、戻ったらもう 1 回知らせる。
 *
 * Genie の中に置くと、Genie と一緒に止まって何も言えない。だから別のプロセスにして、
 * LINE の Messaging API へ直接送る。見るものは 2 つ:
 *   - LINE の Webhook テスト（LINE → トンネル → 中継 の道が、いま登録中の URL で通るか）
 *   - 手元の gateway が HTTP で答えるか
 *
 * 誤報を避ける決まり:
 *   - 2 回続けて失敗してから知らせる（再起動の数十秒では鳴らさない）
 *   - この Mac がネットにつながっていないときは判定しない（どのみち送れない）
 *   - スリープ明けは数え直す（起きた直後の失敗は、止まったことの証拠にならない）
 * Mac の電源が切れている間とスリープ中は動かない。知らせが来ないことは、動いている証拠にならない。
 *
 *   node scripts/line-watchdog.mjs set-destination   # 宛先を標準入力から受け取り、0600 で保存
 *   node scripts/line-watchdog.mjs check             # 1 回だけ調べて結果を表示（送らない）
 *   node scripts/line-watchdog.mjs run               # 見張り続ける（launchd から）
 *   node scripts/line-watchdog.mjs install|uninstall # launchd への登録と解除
 */
import { execFile } from 'node:child_process';
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { readSecret } from './local-preview/secrets.mjs';

const SUPPORT = join(homedir(), 'Library', 'Application Support', 'Genie');
const DESTINATION_FILE = join(SUPPORT, 'line-watchdog.json');
const STATE_FILE = join(SUPPORT, 'line-watchdog-state.json');
const LABEL = 'com.genie.line-watchdog';
const PLIST = join(homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);
const LINE_API = 'https://api.line.me/v2/bot';
const GATEWAY = 'http://127.0.0.1:43123/v1/me';

export const INTERVAL_MS = 5 * 60_000;
export const FAILURES_TO_ALERT = 2;
/** 前回からこれより空いていたら、スリープか停止の明けとみなす。 */
export const SLEEP_GAP_MS = 3 * INTERVAL_MS;

export const initialState = () => ({
  failures: 0,
  alerted: false,
  downSince: null,
  lastCheckAt: null,
});

const REASONS = {
  webhook: 'LINE の受け口',
  gateway: 'Genie 本体',
};

/** 調べた結果から、次の状態と送る文を決める。送信の成否は commit で反映する。 */
export function decide(state, probe, now) {
  const slept = state.lastCheckAt !== null && now - state.lastCheckAt > SLEEP_GAP_MS;
  const base = { ...state, lastCheckAt: now };
  if (probe.offline) return { state: base, text: null };
  if (probe.problems.length === 0) {
    if (!state.alerted) return { state: { ...base, failures: 0, downSince: null }, text: null };
    const minutes = Math.max(1, Math.round((now - (state.downSince ?? now)) / 60_000));
    return {
      state: { ...base, failures: 0 },
      text: `Genie が戻りました（約 ${minutes} 分止まっていました）。止まっている間に LINE で送ったものには、返事が届きません。必要ならもう一度送ってください。`,
      recovered: true,
    };
  }
  const failures = slept && !state.alerted ? 1 : state.failures + 1;
  const downSince = slept && !state.alerted ? now : (state.downSince ?? now);
  const next = { ...base, failures, downSince };
  if (state.alerted || failures < FAILURES_TO_ALERT) return { state: next, text: null };
  const names = probe.problems.map((p) => REASONS[p] ?? p).join('と');
  return {
    state: next,
    text: `Genie が止まっています（${names}に届きません）。いま LINE で送っても返事は来ません。メールやカレンダーの接続切れの知らせも、戻るまで届きません。Mac で Genie を起動し直してください。`,
    alert: true,
  };
}

/** 送れたときだけ「知らせ済み」を動かす。送れなければ次の回にまた試す。 */
export function commit(decision) {
  if (decision.alert) return { ...decision.state, alerted: true };
  if (decision.recovered) return { ...decision.state, alerted: false, downSince: null };
  return decision.state;
}

export async function probe({ token, fetchImpl = fetch, gateway = GATEWAY }) {
  const problems = [];
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  try {
    const res = await fetchImpl(`${LINE_API}/channel/webhook/test`, {
      method: 'POST',
      headers,
      body: '{}',
      signal: AbortSignal.timeout(30_000),
    });
    // 401 や 429 は、受け口が止まった証拠ではない（見張りの側の問題）
    if (!res.ok) return { offline: false, problems: [], indeterminate: res.status };
    const body = await res.json();
    if (body.success !== true) problems.push('webhook');
  } catch {
    return { offline: true, problems: [] };
  }
  try {
    await fetchImpl(gateway, { signal: AbortSignal.timeout(10_000) });
  } catch {
    problems.push('gateway');
  }
  return { offline: false, problems };
}

export async function push({ token, to, text, fetchImpl = fetch }) {
  const res = await fetchImpl(`${LINE_API}/message/push`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ to, messages: [{ type: 'text', text }] }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`LINE push ${String(res.status)}`);
}

const log = (message) => console.log(`${new Date().toISOString()} ${message}`);

async function readJson(file) {
  return JSON.parse(await readFile(file, 'utf8'));
}

async function saveState(state) {
  await writeFile(STATE_FILE, JSON.stringify(state), { mode: 0o600 });
}

async function tick(to, read = readSecret) {
  const state = await readJson(STATE_FILE).catch(() => initialState());
  const token = await read('line-access-token');
  if (!token) {
    log('token unavailable; skipped');
    return;
  }
  const result = await probe({ token });
  if (result.indeterminate)
    log(`webhook test answered ${String(result.indeterminate)}; not judged`);
  const decision = decide(state, result, Date.now());
  let next = decision.state;
  if (decision.text) {
    try {
      await push({ token, to, text: decision.text });
      next = commit(decision);
      log(decision.alert ? 'alert sent' : 'recovery sent');
    } catch (error) {
      // 送れなかった: 知らせ済みにせず、次の回にもう一度
      log(`send failed: ${String(error.message)}`);
    }
  }
  await saveState(next);
  log(`problems=${result.problems.join(',') || 'none'} offline=${String(result.offline)}`);
}

function plist() {
  const script = fileURLToPath(import.meta.url);
  const out = join(homedir(), 'Library', 'Logs', 'Genie', 'line-watchdog.log');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key><array>
    <string>${process.execPath}</string><string>${script}</string><string>run</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>60</integer>
  <key>StandardOutPath</key><string>${out}</string>
  <key>StandardErrorPath</key><string>${out}</string>
</dict></plist>
`;
}

async function main(command) {
  const launchctl = promisify(execFile).bind(null, '/bin/launchctl');
  const domain = `gui/${String(process.getuid())}`;
  if (command === 'set-destination') {
    let to = '';
    for await (const chunk of process.stdin) to += chunk;
    to = to.trim();
    if (!/^U[0-9a-f]{32}$/.test(to)) throw new Error('LINE の宛先の形ではありません。');
    await mkdir(SUPPORT, { recursive: true });
    await writeFile(DESTINATION_FILE, JSON.stringify({ to }), { mode: 0o600 });
    await chmod(DESTINATION_FILE, 0o600);
    console.log('宛先を保存しました。');
  } else if (command === 'check') {
    const token = await readSecret('line-access-token');
    if (!token) throw new Error('LINE のトークンを読めません。');
    console.log(JSON.stringify(await probe({ token })));
  } else if (command === 'run') {
    const { to } = await readJson(DESTINATION_FILE);
    for (;;) {
      await tick(to).catch((error) => log(`check failed: ${String(error.message)}`));
      await new Promise((resolve) => setTimeout(resolve, INTERVAL_MS));
    }
  } else if (command === 'install') {
    await readJson(DESTINATION_FILE);
    await mkdir(dirname(PLIST), { recursive: true });
    await mkdir(join(homedir(), 'Library', 'Logs', 'Genie'), { recursive: true });
    await launchctl(['bootout', `${domain}/${LABEL}`]).catch(() => undefined);
    await writeFile(PLIST, plist());
    await launchctl(['bootstrap', domain, PLIST]);
    console.log('見張りを登録しました。');
  } else if (command === 'uninstall') {
    await launchctl(['bootout', `${domain}/${LABEL}`]).catch(() => undefined);
    await rm(PLIST, { force: true });
    console.log('見張りを解除しました。');
  } else {
    throw new Error('使い方: set-destination | check | run | install | uninstall');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv[2]).catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
