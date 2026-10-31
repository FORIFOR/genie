#!/usr/bin/env node
// エージェントの仕事を Genie に頼む・様子を見る（services/api-gateway/src/agent-jobs.ts）。
//
//   node scripts/agent-job.mjs add --project . --request "テストを直す" --check "テストが通る=pnpm test" \
//        [--artifact "報告書=docs/report.md"] [--review "内容を確認する"] [--after 3] [--agent claude_code] \
//        [--minutes 30] [--turns 40] [--cost 2]
//   node scripts/agent-job.mjs status
//   node scripts/agent-job.mjs say 仕事 3 を再開
//
// 鍵は hooks と同じキーチェーンの項目（値はコマンドの引数に載せない）。送り先は手元の gateway だけ。
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

const BASE = process.env.GENIE_GATEWAY_URL ?? 'http://127.0.0.1:43123';
if (!/^http:\/\/(?:127\.0\.0\.1|localhost):\d+$/.test(BASE)) {
  console.error('送り先は手元の gateway だけです。');
  process.exit(2);
}

function token() {
  return execFileSync(
    '/usr/bin/security',
    ['find-generic-password', '-s', 'com.astra.agent-hook', '-a', BASE, '-w'],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
  ).trim();
}

/** 「名前=中身」。名前を省いたら中身を名前にする。 */
export function criterion(kind, value) {
  const at = value.indexOf('=');
  return at > 0
    ? { kind, text: value.slice(0, at).trim(), spec: value.slice(at + 1).trim() }
    : { kind, text: value.trim(), spec: value.trim() };
}

function parse(argv) {
  const out = { criteria: [], after: [] };
  for (let i = 0; i < argv.length; i += 2) {
    const [flag, value] = [argv[i], argv[i + 1]];
    if (value === undefined) throw new Error(`${flag} の値がありません`);
    if (flag === '--project') out.project_root = resolve(value);
    else if (flag === '--request') out.request = value;
    else if (flag === '--title') out.title = value;
    else if (flag === '--agent') out.agent = value;
    else if (flag === '--check') out.criteria.push(criterion('command', value));
    else if (flag === '--artifact') out.criteria.push(criterion('artifact', value));
    else if (flag === '--review') out.criteria.push({ kind: 'manual', text: value });
    else if (flag === '--after') out.after.push(Number(value));
    else if (flag === '--minutes') out.max_minutes = Number(value);
    else if (flag === '--turns') out.max_turns = Number(value);
    else if (flag === '--cost') out.max_cost_usd = Number(value);
    else throw new Error(`知らない指定: ${flag}`);
  }
  if (out.after.length === 0) delete out.after;
  return out;
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const headers = { authorization: `Bearer ${token()}`, 'content-type': 'application/json' };
  if (command === 'status') {
    const res = await fetch(`${BASE}/v1/agent-jobs`, { headers });
    const body = await res.json();
    console.log(body.summary ?? '仕事はありません。');
    return;
  }
  if (command === 'say') {
    const res = await fetch(`${BASE}/v1/agent-jobs/say`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ text: rest.join(' ') }),
    });
    const body = await res.json();
    console.log(body.said ?? '当てはまる操作がありません。');
    return;
  }
  if (command === 'add') {
    const res = await fetch(`${BASE}/v1/agent-jobs`, {
      method: 'POST',
      headers,
      body: JSON.stringify(parse(rest)),
    });
    const body = await res.json();
    if (res.status !== 201) {
      console.error(body.refused ?? JSON.stringify(body));
      process.exit(1);
    }
    console.log(`仕事 ${body.number} を列に入れました。`);
    return;
  }
  console.error('使い方: agent-job.mjs add … / status / say …');
  process.exit(2);
}

await main();
