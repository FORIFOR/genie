#!/usr/bin/env node
/**
 * Claude Code の hooks を手元の Genie につなぐ・外す（docs/AGENT_SESSIONS.ja.md）。
 *
 *   node scripts/claude-code-hooks.mjs install     鍵を発行してキーチェーンに置き、~/.claude/settings.json に hooks を足す
 *   node scripts/claude-code-hooks.mjs status      つながっているか（鍵の値は出さない）
 *   node scripts/claude-code-hooks.mjs uninstall   hooks を外し、鍵を取り消してキーチェーンから消す
 *
 * settings.json は**足すだけ・外すだけ**。ほかの hooks や設定には触らない（書く前に .bak を残す）。
 * hooks はすべて async（Claude Code は Genie の返事を待たない）。送り先は手元の gateway だけ。
 */
import { execFile, spawn } from 'node:child_process';
import { copyFile, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { DEFAULT_STATE, validateConfig } from './local-preview/config.mjs';
import { desktopEmail } from './start-local-host.mjs';

const run = promisify(execFile);
const HOOK = resolve(dirname(fileURLToPath(import.meta.url)), 'claude-code-hook.sh');
const KEYCHAIN_SERVICE = 'com.astra.agent-hook';
/** 見守りに要る出来事だけ。PreToolUse は PostToolUse と重なるので入れない（道具 1 回で 1 通）。 */
export const HOOK_EVENTS = Object.freeze([
  'SessionStart',
  'UserPromptSubmit',
  'PostToolUse',
  'PostToolUseFailure',
  'PermissionRequest',
  'Notification',
  'Elicitation',
  'Stop',
  'StopFailure',
  'SessionEnd',
]);

const HELP = `使い方: node scripts/claude-code-hooks.mjs <install|status|uninstall> [--state-dir DIR] [--settings FILE]`;

function parseArgs(argv) {
  const options = {
    command: argv[0] ?? 'help',
    stateDir: DEFAULT_STATE,
    settings: join(homedir(), '.claude/settings.json'),
  };
  for (let i = 1; i < argv.length; i += 2) {
    if (argv[i] === '--state-dir') options.stateDir = argv[i + 1];
    else if (argv[i] === '--settings') options.settings = argv[i + 1];
    else throw new Error(`知らない指定です: ${argv[i]}`);
  }
  return options;
}

/** この Genie の hooks か（コマンドが同じ送り口を指している）。 */
const ours = (entry) =>
  Array.isArray(entry?.hooks) &&
  entry.hooks.some((h) => typeof h?.command === 'string' && h.command.includes(HOOK));

/** settings に hooks を足す。同じものが既にあれば置き換える。ほかの hooks は残す。 */
export function withHooks(settings, base) {
  const next = structuredClone(settings ?? {});
  next.hooks ??= {};
  const command = `${JSON.stringify(HOOK)} ${base}`;
  for (const event of HOOK_EVENTS) {
    const kept = (next.hooks[event] ?? []).filter((entry) => !ours(entry));
    next.hooks[event] = [...kept, { hooks: [{ type: 'command', command, async: true }] }];
  }
  return next;
}

/** settings からこの Genie の hooks だけを外す。 */
export function withoutHooks(settings) {
  const next = structuredClone(settings ?? {});
  if (!next.hooks) return next;
  for (const [event, entries] of Object.entries(next.hooks)) {
    if (!Array.isArray(entries)) continue;
    const kept = entries.filter((entry) => !ours(entry));
    if (kept.length) next.hooks[event] = kept;
    else delete next.hooks[event];
  }
  if (Object.keys(next.hooks).length === 0) delete next.hooks;
  return next;
}

async function readSettings(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return {};
    throw new Error(`${file} を読めませんでした（JSON として壊れていないか確かめてください）。`);
  }
}

async function writeSettings(file, value) {
  await copyFile(file, `${file}.bak`).catch((error) => {
    if (error?.code !== 'ENOENT') throw error;
  });
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  await rename(temporary, file);
}

/** 鍵をキーチェーンへ。値はコマンドの引数に載せない（security -i に標準入力で渡す）。 */
function storeKey(base, token) {
  return new Promise((resolveStore, reject) => {
    const child = spawn('/usr/bin/security', ['-i'], { stdio: ['pipe', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', reject);
    child.on('exit', (code) =>
      code === 0 && !stderr.trim()
        ? resolveStore()
        : reject(new Error('キーチェーンに鍵を置けませんでした。')),
    );
    // -T /usr/bin/security: hook（security）が読むときに macOS がパスワードを聞かない
    child.stdin.end(
      `add-generic-password -U -s ${KEYCHAIN_SERVICE} -a ${base} -T /usr/bin/security -w ${token}\n`,
    );
  });
}

async function hasKey(base) {
  try {
    await run('/usr/bin/security', ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', base]);
    return true;
  } catch {
    return false;
  }
}

async function deleteKey(base) {
  await run('/usr/bin/security', [
    'delete-generic-password',
    '-s',
    KEYCHAIN_SERVICE,
    '-a',
    base,
  ]).catch(() => {});
}

async function api(base, path, { method = 'GET', token, body } = {}) {
  const response = await fetch(base + path, {
    method,
    redirect: 'error',
    signal: AbortSignal.timeout(15_000),
    headers: {
      // 本文の無い DELETE に content-type を付けると gateway が 400 で断る
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) throw new Error(`Genie が ${path} に ${response.status} を返しました。`);
  return response.status === 204 ? null : response.json();
}

async function signIn(stateDir) {
  const config = JSON.parse(await readFile(join(stateDir, 'runtime.json'), 'utf8'));
  validateConfig(config);
  const base = `http://127.0.0.1:${config.port}`;
  const issued = await api(base, '/v1/auth/dev/token', {
    method: 'POST',
    body: { email: desktopEmail(config.identity), display_name: 'Genie' },
  });
  if (!issued.access_token) throw new Error('手元の Genie にログインできませんでした。');
  return { base, access: issued.access_token };
}

async function main(options) {
  if (!['install', 'status', 'uninstall'].includes(options.command)) {
    console.log(HELP);
    return;
  }
  const { base, access } = await signIn(resolve(options.stateDir));
  const settings = await readSettings(options.settings);
  const connections = (await api(base, '/v1/agent-connections', { token: access })).items ?? [];

  if (options.command === 'status') {
    const installed = HOOK_EVENTS.filter((e) => (settings.hooks?.[e] ?? []).some(ours));
    console.log(
      JSON.stringify(
        {
          gateway: base,
          hooks: `${installed.length}/${HOOK_EVENTS.length}`,
          keychain: (await hasKey(base)) ? 'ある' : 'ない',
          connections: connections.map((c) => ({ label: c.label, last_seen_at: c.last_seen_at })),
        },
        null,
        2,
      ),
    );
    return;
  }

  // つなぎ直し・外すときは、前に発行した Claude Code の鍵を取り消す（使われない鍵を残さない）
  for (const c of connections.filter((c) => c.source === 'claude_code'))
    await api(base, `/v1/agent-connections/${c.id}`, { method: 'DELETE', token: access });

  if (options.command === 'uninstall') {
    await writeSettings(options.settings, withoutHooks(settings));
    await deleteKey(base);
    console.log('Claude Code の hooks を外し、鍵を取り消しました。');
    return;
  }

  const issued = await api(base, '/v1/agent-connections', {
    method: 'POST',
    token: access,
    body: { source: 'claude_code', label: 'Claude Code（この Mac）' },
  });
  await storeKey(base, issued.token);
  await writeSettings(options.settings, withHooks(settings, base));
  console.log(
    `Claude Code の hooks をつなぎました（${HOOK_EVENTS.length} 種類の出来事 → ${base}）。` +
      '\n新しく始めた Claude Code のセッションから Genie に届きます。',
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(parseArgs(process.argv.slice(2))).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
