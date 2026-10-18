#!/usr/bin/env node
/**
 * 実装仕様 §14.3 の規約を機械検査する。
 *
 * ADR 0001 で「サービス境界はコードで守り、デプロイは 1 プロセスに畳む」と決めた以上、
 * 境界の形骸化を人のレビューに任せない。ここが CI の gate になる。
 *
 *   node scripts/check-conventions.mjs
 */
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

/** 実装仕様 §5.1 のテーブル所有権。所有サービス以外は直接 SQL を投げない。 */
const TABLE_OWNERS = {
  'services/api-gateway': [
    'tenants',
    'users',
    'memberships',
    'devices',
    'sessions',
    'onboarding_states',
  ],
  'services/conversation': [
    'conversations',
    'turns',
    'conversation_states',
    'conversation_summaries',
  ],
  'services/task': ['tasks', 'task_events', 'event_streams', 'approvals', 'action_receipts'],
  'services/library': ['artifacts', 'artifact_versions'],
  'services/share': ['shares', 'share_access_logs'],
  'services/meeting': ['meetings', 'meeting_segments', 'meeting_speakers', 'translations'],
  'services/research': ['research_runs', 'evidence'],
  'services/world-model': [
    'world_entities',
    'world_edges',
    'world_facts',
    'world_events',
    'work_artifacts',
    'work_corrections',
    'work_profiles',
    'work_sync_state',
  ],
  'services/plugin-registry': [
    'plugins',
    'plugin_versions',
    'plugin_installs',
    'plugin_permissions',
    'plugin_assets',
    'connector_connections',
    'plugin_publishers',
  ],
  'services/agent-runtime': ['agent_profiles', 'agent_runs', 'domain_entities', 'domain_links'],
  // 電話（Oathra）の接続。トークンは封じて置く
  'services/phone': ['phone_connections'],
  'services/notification': [],
  'services/context': [],
  // 横断・追記のみ。監査は telemetry が一手に引き受ける。
  'packages/telemetry': ['audit_events', 'audit_sequences'],
};

const problems = [];

function fail(file, line, message) {
  problems.push({ file, line, message });
}

async function* sourceFiles(dir) {
  let entries;
  try {
    entries = await readdir(path.join(root, dir), { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const rel = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === 'generated') {
        continue;
      }
      yield* sourceFiles(rel);
    } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
      yield rel;
    }
  }
}

async function serviceDirs() {
  const entries = await readdir(path.join(root, 'services'), { withFileTypes: true });
  return entries.filter((e) => e.isDirectory()).map((e) => `services/${e.name}`);
}

const lineOf = (text, index) => text.slice(0, index).split('\n').length;

/** 1. 生の pg / pool.query を service から直接呼ばない（withTenant 経由のみ）。 */
async function checkNoRawQueries(dirs) {
  for (const dir of dirs) {
    for await (const file of sourceFiles(`${dir}/src`)) {
      const text = await readFile(path.join(root, file), 'utf8');
      for (const match of text.matchAll(/from\s+['"]pg['"]/g)) {
        fail(file, lineOf(text, match.index), 'imports pg directly; go through @genie/db');
      }
      for (const match of text.matchAll(/\b(pool|client)\.query\s*\(/g)) {
        fail(
          file,
          lineOf(text, match.index),
          'calls pool.query directly; use withTenant/withSystem',
        );
      }
    }
  }
}

/** 2. サービスは他サービスの内部パスを import しない。 */
async function checkNoCrossServiceInternals(dirs) {
  const names = dirs.map((d) => d.split('/')[1]);
  for (const dir of dirs) {
    const self = dir.split('/')[1];
    for await (const file of sourceFiles(`${dir}/src`)) {
      const text = await readFile(path.join(root, file), 'utf8');
      for (const match of text.matchAll(/from\s+['"]([^'"]+)['"]/g)) {
        const specifier = match[1];
        // 相対で他サービスへ入る
        if (specifier.startsWith('.') && /\.\.\/\.\.\/([a-z-]+)\/src\//.test(specifier)) {
          const target = /\.\.\/\.\.\/([a-z-]+)\/src\//.exec(specifier)[1];
          if (names.includes(target) && target !== self) {
            fail(file, lineOf(text, match.index), `reaches into services/${target}/src`);
          }
        }
        // パッケージ名の deep import
        if (/^@astra\/service-[a-z-]+\/(?!package\.json).+/.test(specifier)) {
          fail(file, lineOf(text, match.index), `deep-imports ${specifier}; use the package entry`);
        }
      }
    }
  }
}

/** 3. 所有していないテーブルへ直接 SQL を投げない（実装仕様 §5.1）。 */
async function checkTableOwnership() {
  const builder = /\b(?:selectFrom|insertInto|updateTable|deleteFrom)\(\s*'([a-z_]+)'/g;
  const rawSql = /\b(?:from|into|update)\s+([a-z_]+)\b/gi;

  for (const [dir, owned] of Object.entries(TABLE_OWNERS)) {
    const allowed = new Set(owned);
    for await (const file of sourceFiles(`${dir}/src`)) {
      const text = await readFile(path.join(root, file), 'utf8');
      for (const match of text.matchAll(builder)) {
        const table = match[1];
        if (isKnownTable(table) && !allowed.has(table)) {
          fail(file, lineOf(text, match.index), `queries "${table}" which it does not own (§5.1)`);
        }
      }
      for (const match of text.matchAll(rawSql)) {
        const table = match[1].toLowerCase();
        if (isKnownTable(table) && !allowed.has(table)) {
          fail(file, lineOf(text, match.index), `raw SQL touches "${table}" (§5.1)`);
        }
      }
    }
  }
}

const ALL_TABLES = new Set(Object.values(TABLE_OWNERS).flat());
const isKnownTable = (name) => ALL_TABLES.has(name);

/** 4. 同梱プラグインの manifest がリポジトリに 5 本あること（seed の前提）。 */
/**
 * 5. ワークスペース内に依存の循環が無いこと。
 *
 * サービス同士が公開 API を通して依存するのは構わない（task → library など）。
 * 駄目なのは**循環**で、これはビルドできなくなるうえ、
 * 「どちらが上位か」が決まっていない印でもある。
 * 実際に task ↔ research で踏んだ。合流点は worker / gateway に置く。
 */
async function checkNoDependencyCycles() {
  const manifests = [];
  for (const group of ['packages', 'services', 'workers', 'apps']) {
    let entries;
    try {
      entries = await readdir(path.join(root, group), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries.filter((e) => e.isDirectory())) {
      const rel = path.join(group, entry.name, 'package.json');
      try {
        const pkg = JSON.parse(await readFile(path.join(root, rel), 'utf8'));
        manifests.push({
          rel,
          name: pkg.name,
          deps: { ...pkg.dependencies, ...pkg.devDependencies },
        });
      } catch {
        /* package.json が無いディレクトリは飛ばす */
      }
    }
  }

  const graph = new Map(
    manifests.map((m) => [
      m.name,
      Object.keys(m.deps ?? {}).filter((dep) => manifests.some((other) => other.name === dep)),
    ]),
  );
  const where = new Map(manifests.map((m) => [m.name, m.rel]));

  const state = new Map();
  const stack = [];

  const walk = (name) => {
    if (state.get(name) === 'done') return;
    if (state.get(name) === 'open') {
      const cycle = [...stack.slice(stack.indexOf(name)), name].join(' → ');
      fail(where.get(name) ?? name, 0, `dependency cycle: ${cycle}`);
      return;
    }
    state.set(name, 'open');
    stack.push(name);
    for (const dep of graph.get(name) ?? []) walk(dep);
    stack.pop();
    state.set(name, 'done');
  };

  for (const name of graph.keys()) walk(name);
}

async function checkBuiltinPlugins() {
  const entries = await readdir(path.join(root, 'plugins/builtin'), { withFileTypes: true });
  const dirs = entries.filter((e) => e.isDirectory());
  // 同梱を勝手に増やさないための検査。増やすときはここも直す（意図的な変更にする）。
  // 8 つ目は Video（正本 §15.2）、9 つ目は Care Support（§15.4）、
  // 10 個目は EHR Assist（§15.5）、11 個目は Architecture（§15.6）、
  // 12 個目は Stock Research（§15.7）。これで §15 の 7 領域が揃う。
  // Work Context に追加したOutlook / Microsoft To Doも名前で検証する。
  // 件数だけでは、1件を別pluginへ取り替えても通ってしまう。
  const expected = new Set([
    'architecture',
    'calendar',
    'care',
    'ehr',
    'finder',
    'general',
    'gmail',
    'meeting',
    'microsoft-todo',
    'outlook',
    'research',
    'sales-crm',
    'stock',
    'video',
  ]);
  const actual = new Set(dirs.map((dir) => dir.name));
  for (const name of expected) {
    if (!actual.has(name)) fail('plugins/builtin', 0, `missing bundled plugin: ${name}`);
  }
  for (const name of actual) {
    if (!expected.has(name)) fail('plugins/builtin', 0, `unexpected bundled plugin: ${name}`);
  }
}

const dirs = await serviceDirs();
await checkNoRawQueries(dirs);
await checkNoCrossServiceInternals(dirs);
await checkTableOwnership();
await checkNoDependencyCycles();
await checkBuiltinPlugins();

if (problems.length > 0) {
  console.error(`convention check failed (${problems.length} problem(s)):\n`);
  for (const p of problems) console.error(`  ${p.file}:${p.line}  ${p.message}`);
  console.error('\nSee docs/spec/phase-0-implementation-spec.md §14.3');
  process.exit(1);
}
console.log('convention check passed');
