#!/usr/bin/env node
/** Connect a local Ollama host to the Mac app without copying credentials. */
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve, dirname } from 'node:path';

export function localURL(value) {
  const url = new URL(value);
  if (
    url.protocol !== 'http:' ||
    !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error('The preview helper only connects to an HTTP service on this Mac.');
  return url.toString().replace(/\/$/, '');
}
export function desktopEmail(identity) {
  if (!/^[a-z0-9-]{1,80}$/i.test(identity)) throw new Error('Invalid local desktop identity.');
  return `main-${identity}@astra.local`;
}
async function jsonRequest(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    redirect: 'error',
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error(`Local service returned HTTP ${response.status}.`);
  return response.json();
}
async function main() {
  if (process.platform !== 'darwin')
    throw new Error('This helper connects the native Mac preview.');
  const base = localURL(process.env.ASTRA_API_URL ?? 'http://127.0.0.1:3000');
  const endpoint = localURL(process.env.ASTRA_LOCAL_LLM_URL ?? 'http://127.0.0.1:11434/v1');
  const model = process.env.ASTRA_LOCAL_LLM_MODEL ?? 'qwen3.5:9b';
  await jsonRequest(base + '/healthz');
  const models = await jsonRequest(endpoint + '/models');
  if (!models.data?.some((entry) => entry.id === model))
    throw new Error(`Install the selected local model first: ollama pull ${model}`);
  let identity = process.env.ASTRA_DESKTOP_ID;
  if (!identity) {
    // The Mac app (com.astra.mac) keeps its identity in its own defaults. The old desktop
    // domain is read only as a fallback: a host signed in as another identity serves another
    // tenant, and the app's tasks then wait for a host forever (PAUSED_HOST_OFFLINE).
    for (const domain of ['com.astra.mac', 'com.astra.desktop']) {
      try {
        identity = execFileSync('defaults', ['read', domain, `astra.dev.identity.${base}`], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
        }).trim();
        if (identity) break;
      } catch {
        // try the next domain
      }
    }
    if (!identity)
      throw new Error('Open Genie once with the gateway running, then run this command again.');
  }
  const email = desktopEmail(identity);
  if (process.argv.includes('--check')) {
    console.log(
      'Ready: local gateway, selected model, and Mac identity found. No credentials requested.',
    );
    return;
  }
  const credentials = await jsonRequest(base + '/v1/auth/dev/token', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, display_name: 'Genie local preview' }),
  });
  await jsonRequest(base + '/v1/plugins/com.astra.general/install', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${credentials.access_token}`,
    },
    body: JSON.stringify({
      version: '0.1.0',
      granted_scopes: ['artifacts.read', 'artifacts.write'],
    }),
  });
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const child = spawn(process.execPath, ['--import', 'tsx', 'workers/agent-host/src/main.ts'], {
    cwd: root,
    stdio: 'inherit',
    env: {
      ...process.env,
      ASTRA_API_URL: base,
      ASTRA_HOST_TOKEN: credentials.access_token,
      ASTRA_HOST_REFRESH_TOKEN: credentials.refresh_token,
      ASTRA_DEVICE_LABEL: 'mac-local-preview',
      ASTRA_LLM_CLI: 'local',
      ASTRA_LOCAL_LLM_URL: endpoint,
      ASTRA_LOCAL_LLM_MODEL: model,
      ASTRA_LOCAL_LLM_REASONING_EFFORT: process.env.ASTRA_LOCAL_LLM_REASONING_EFFORT ?? 'none',
      ASTRA_WORK_SYNC: 'off',
      ASTRA_WORK_SYNC_METERED_LLM: 'off',
    },
  });
  // The host stores its own refresh chain in the OS credential store; no token is
  // printed or written by this helper, and model CLIs never inherit these values.
  console.log(`Starting Genie with ${model}. Leave this terminal open; Ctrl+C stops this host.`);
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
  child.on('error', () => {
    console.error('Could not start the local host. Run pnpm install first.');
    process.exitCode = 1;
  });
  child.on('exit', (code) => {
    process.exitCode = code ?? 1;
  });
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url)
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
