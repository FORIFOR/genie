/**
 * LINE 会話の評価 その 1: 振り分け（何をするか・聞き返すか・してはいけないことをしないか）。
 *
 *   ./infra/db/with-test-db.sh npx tsx evals/line-conversation/measure.ts [--only <category>] [--out <file>]
 *
 * いまの Genie の判断の層を、本物のまま通す（試験用の DB）:
 *   決まった言い方（家計簿・グループ送信・見守り・使った量）→ 辞書 → 予約 → 振り分け（Lane）→ 仕事の種類
 * 仕事は作るだけで動かさない（InMemoryTaskRuntime）。モデルは呼ばない（費用 0）。
 *
 * 会話の流れ（history）は、本人の発言だけを順に Genie へ送って再現する（Genie の返事は Genie 自身のもの）。
 * 写真は本物が無いので、写真つきのケースは「写真を読む口へ渡すか」だけを見る（中身の判断は見ない）。
 *
 * 結果は JSON（ケースごとの観測と採点）。採点の決まりは README.ja.md。
 */
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Writable } from 'node:stream';
import { SendTurnRequest, uuidv7, type TokenResponse } from '@genie/contracts';
import { createDb, withTenant } from '@genie/db';
import { createLogger } from '@genie/telemetry';
import { FsObjectStore, LibraryService } from '@genie/service-library';
import { PluginRegistryService, agentResolver } from '@genie/service-plugin-registry';
import { ConversationService, handleTurn, type TurnDeps } from '@genie/service-conversation';
import { InMemoryTaskRuntime, TaskService } from '@genie/service-task';
import { VocabularyService, VocabularyStore } from '../../services/vocabulary/src/index.js';
import { MemoryRateLimiter, buildApp, JwtTokens, loadSigningKeys } from '@genie/service-api-gateway';
import { personalCommands, understandServiceFromEnv } from '../../services/api-gateway/src/understand.js';
import { scheduleServiceFromEnv } from '../../services/api-gateway/src/schedules.js';
import { CALL_REQUEST } from '../../services/channels/src/index.js';
import { splitRequests } from '../../services/conversation/src/split.js';
import { OpencodeWatchService } from '../../services/api-gateway/src/opencode-watch.js';
import { calendarTurnDeps } from '../../services/api-gateway/src/calendar-turn.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../..');

export interface EvalCase {
  readonly id: string;
  readonly category: string;
  readonly history: readonly { readonly role: 'user' | 'genie'; readonly text: string }[];
  readonly pending: string | null;
  readonly attachments: readonly { readonly type: string; readonly about?: string }[];
  readonly input: string;
  readonly expect: {
    readonly act: string;
    readonly do: string;
    readonly accept: readonly string[];
    readonly parts: readonly string[];
    readonly confirm: boolean;
    readonly clarify: boolean;
    readonly must_not: readonly string[];
    readonly reply: { readonly shouchi: 'require' | 'allow' | 'forbid' };
  };
  readonly why: string;
}

/** Genie が実際にしたこと（観測）。 */
export interface Observation {
  /** 観測した「すること」。llm は汎用の答え（中身は答えを作るまで分からない） */
  readonly did: string;
  /** どの層が決めたか。 */
  readonly via: 'split' | 'channel' | 'command:understand' | 'command:schedule' | 'command:vocabulary' | 'clarification' | 'task' | 'notice' | 'answered' | 'photo';
  readonly asked: boolean;
  readonly reply: string | null;
  readonly taskKind: string | null;
}

/** 汎用の答え（llm）で済ませてよい「すること」。中身が正しいかは、答えを作る評価（その 2）で見る。 */
const LLM_CAN = new Set([
  'answer.chat',
  'answer.knowledge',
  'compose',
  'translate',
  'none',
  'clarify',
  'refuse',
]);
/** 写真を読む口（Claude）が決められる「すること」。 */
const PHOTO_CAN = new Set([
  'household.expense_add',
  'meal.estimate',
  'photo.read',
  'translate',
  'calendar.create',
  'clarify',
]);

export function observedFromCommand(command: string | undefined, text: string, asked: boolean): string {
  if (command === 'schedule') {
    if (/一覧|次は .* です。$/.test(text) && !/よろしいですか/.test(text)) return 'reminder.list';
    if (/取り消/.test(text)) return 'reminder.cancel';
    return 'reminder.create';
  }
  if (command === 'vocabulary') return 'vocabulary';
  if (/グループに送/.test(text)) return 'group.send';
  if (/見守り|opencode/.test(text))
    return /^(?:opencode のセッション（.*）の見守りは|まだ opencode)/.test(text) ? 'opencode.status' : 'opencode.watch';
  if (/今月の LINE の通話/.test(text)) return 'usage.report';
  if (/家計簿|円/.test(text)) return /付けました|記録/.test(text) ? 'household.expense_add' : 'household.view';
  if (/買い物/.test(text)) return 'list.shopping_add';
  if (/TODO|やること/.test(text)) return 'list.todo_add';
  return asked ? 'clarify' : 'command';
}

export function observedFromTask(kind: string | null, input: Record<string, unknown> | null): string {
  if (!kind) return 'none';
  if (kind === 'info.lookup') {
    const info = String(input?.['kind'] ?? '');
    return info === 'weather' ? 'info.weather' : info === 'news' ? 'info.news' : info === 'markets' ? 'info.stock' : 'info';
  }
  if (kind === 'calendar.agenda') return 'calendar.read';
  if (kind === 'calendar.move') return input?.['undo'] ? 'undo' : 'calendar.reschedule';
  if (kind === 'research') return 'research';
  if (kind === 'computer.run') return 'computer.run';
  if (kind === 'browser.open_official') return 'browser.open';
  if (/^(?:checkout|transaction)\./.test(kind)) return 'purchase';
  if (kind.endsWith('general:assistant')) return input?.['instruction'] ? 'compose' : 'llm';
  return kind;
}

export interface Score {
  readonly id: string;
  readonly category: string;
  readonly expected: string;
  readonly did: string;
  readonly via: string;
  /** すること が合っている（llm は「汎用の答えで済ませてよいもの」だけ合格。中身はその 2 で見る） */
  readonly doOk: boolean;
  /** してはいけないことをした（誤実行） */
  readonly violation: boolean;
  /** 聞き返すべきときに聞き返した・聞き返すべきでないときに聞き返さなかった（決められるときだけ。llm は null） */
  readonly clarifyOk: boolean | null;
  /** その 2（答えの文）へ回すか */
  readonly needsReply: boolean;
  readonly reply: string | null;
}

export function score(c: EvalCase, o: Observation): Score {
  const want = new Set([c.expect.do, ...c.expect.accept]);
  let doOk: boolean;
  if (o.did === 'llm') doOk = [...want].some((d) => LLM_CAN.has(d));
  else if (o.did === 'photo') doOk = [...want].some((d) => PHOTO_CAN.has(d));
  else if (o.did === 'clarify') doOk = c.expect.clarify || want.has('clarify');
  else if (o.did === 'compose') doOk = want.has('compose') || want.has('translate');
  else doOk = want.has(o.did);
  const violation = c.expect.must_not.includes(o.did);
  const clarifyOk = o.did === 'llm' || o.did === 'photo' ? null : o.asked === c.expect.clarify || (o.asked && c.expect.confirm);
  return {
    id: c.id,
    category: c.category,
    expected: c.expect.do,
    did: o.did,
    via: o.via,
    doOk,
    violation,
    clarifyOk,
    needsReply: o.did === 'llm' || o.did === 'compose',
    reply: o.reply,
  };
}

/** 分けて扱った頼み。期待の parts（無ければ do）がそれぞれ、どれかの部分で満たされていれば合格。 */
export function scoreParts(c: EvalCase, observed: readonly Observation[]): Score {
  const wanted = c.expect.parts.length > 0 ? c.expect.parts : [c.expect.do];
  const partOk = (want: string, o: Observation) =>
    score({ ...c, expect: { ...c.expect, do: want, accept: [], must_not: [] } }, o).doOk;
  const doOk = wanted.every((want) => observed.some((o) => partOk(want, o)));
  const violation = observed.some((o) => c.expect.must_not.includes(o.did));
  return {
    id: c.id,
    category: c.category,
    expected: wanted.join('+'),
    did: observed.map((o) => o.did).join('+'),
    via: 'split',
    doOk,
    violation,
    clarifyOk: null,
    needsReply: false,
    reply: observed.map((o) => o.reply ?? '').join(' / '),
  };
}

export async function loadCases(only?: string): Promise<EvalCase[]> {
  const dir = path.join(here, 'cases');
  // _ で始まるもの（_smoke）は、名指ししたときだけ
  const files = (await readdir(dir)).filter(
    (f) => f.endsWith('.jsonl') && (only ? f === `${only}.jsonl` : !f.startsWith('_')),
  );
  const out: EvalCase[] = [];
  for (const f of files.sort())
    for (const line of (await readFile(path.join(dir, f), 'utf8')).split('\n'))
      if (line.trim()) out.push(JSON.parse(line) as EvalCase);
  return out;
}

const textOf = (turn: unknown): string => {
  const t = turn as { content?: { text?: string }; text?: string };
  return String(t?.content?.text ?? t?.text ?? '');
};

async function main() {
  const args = process.argv.slice(2);
  const only = args.includes('--only') ? args[args.indexOf('--only') + 1] : undefined;
  const outFile = args.includes('--out')
    ? args[args.indexOf('--out') + 1]!
    : path.join(here, 'results', `routing-${new Date().toISOString().slice(0, 10)}.json`);
  const url = process.env['TEST_DATABASE_URL'];
  if (!url) throw new Error('TEST_DATABASE_URL が要ります（./infra/db/with-test-db.sh から動かす）');
  const dbConfig = {
    url,
    identityUrl: process.env['TEST_IDENTITY_DATABASE_URL'],
    maxConnections: 10,
    identityMaxConnections: 2,
    idleTimeoutMillis: 5_000,
    connectionTimeoutMillis: 5_000,
    statementTimeoutMillis: 20_000,
    applicationName: 'genie-line-eval',
  };
  const db = createDb(dbConfig);
  const storeRoot = await mkdtemp(path.join(tmpdir(), 'genie-line-eval-'));
  const conversations = new ConversationService({ db });
  const library = new LibraryService(db, new FsObjectStore(storeRoot));
  const sink = new Writable({ write: (_c, _e, cb) => cb() });
  // 本番と同じく、同梱のプラグインを登録してから入れる（server.ts と同じ）
  const registry = new PluginRegistryService({ db, coreVersion: '0.1.0' });
  await registry.seedBuiltins(path.join(repoRoot, 'plugins/builtin'));
  const tasks = new TaskService(db, new InMemoryTaskRuntime(), agentResolver(registry));
  const app = buildApp({
    config: {
      env: 'test',
      port: 0,
      host: '127.0.0.1',
      logLevel: 'silent',
      redisUrl: undefined,
      version: '0.1.0',
      db: dbConfig,
      builtinPluginsDir: path.join(repoRoot, 'plugins/builtin'),
      objectStoreRoot: storeRoot,
      recordingRoot: storeRoot,
      allowedOrigins: [],
      shareHost: 'http://localhost:1430',
      requesterSalt: 'line-eval',
      idp: { google: null, apple: null, line: null, publicUrl: null },
    },
    db,
    redis: null,
    rateLimiter: new MemoryRateLimiter(),
    logger: createLogger({ service: 'line-eval', level: 'silent' }, sink),
    tokens: new JwtTokens({
      issuer: 'https://auth.astra.test',
      keys: await loadSigningKeys({ keyId: 'line-eval' }),
    }),
    tasks,
    library,
    registry,
    conversations,
    ssePollIntervalMs: 20,
  });
  await app.ready();
  const issued = await app.inject({
    method: 'POST',
    url: '/v1/auth/dev/token',
    payload: { email: `line-eval-${uuidv7()}@example.com`, display_name: 'Eval' },
  });
  const access = issued.json<TokenResponse>().access_token;
  const claims = JSON.parse(Buffer.from(access.split('.')[1]!, 'base64url').toString()) as {
    tid: string;
    sub: string;
  };
  const principal = { tenantId: claims.tid, userId: claims.sub };
  // 本番のプレビューと同じく、汎用の答え（General Assistant）を入れておく
  const installed = await app.inject({
    method: 'POST',
    url: '/v1/plugins/com.astra.general/install',
    headers: { authorization: `Bearer ${access}` },
    payload: { version: '0.1.0', granted_scopes: ['artifacts.read', 'artifacts.write'] },
  });
  if (installed.statusCode >= 300) throw new Error(`General Assistant を入れられません: ${installed.body}`);

  // 本番と同じ決まった言い方の層（写真のモデルは無し。家計簿・グループ・見守り・使った量・予約・辞書）
  const env = { ...process.env, GENIE_UNDERSTAND_ANTHROPIC_API_KEY: '', ANTHROPIC_API_KEY: '' };
  const schedules = scheduleServiceFromEnv(env, db);
  const understand = understandServiceFromEnv(env, { db, logger: { info: () => undefined } as never, timeZone: schedules.tz });
  const watches = new OpencodeWatchService({ db, notify: async () => undefined });
  const personal = personalCommands({
    db,
    understand,
    timeZone: schedules.tz,
    groups: { current: null },
    watches,
    callUsage: async () => ({ usedSeconds: 1200, monthlyMinutes: 60 }),
  });
  const deps: TurnDeps = {
    conversations,
    tasks,
    schedules,
    vocabulary: new VocabularyService(new VocabularyStore(db)),
    understand: personal,
    // 予定を読む・ずらす・元に戻す（本番と同じ。直前の一覧と変更は、この会話の仕事と成果物から引く）
    calendar: calendarTurnDeps({ db, library, timeZone: schedules.tz }),
  };

  const cases = await loadCases(only);
  const results: (Score & { input: string; why: string })[] = [];
  for (const c of cases) {
    const conversationId = (await conversations.start(principal.tenantId, principal.userId, { title: 'LINE' })).id;
    const say = async (text: string) => {
      let command: string | undefined;
      const log = { info: (fields: Record<string, unknown>, message: string) => { if (message === 'turn command') command = String(fields['command']); } };
      const result = await handleTurn(deps, {
        principal,
        conversationId,
        body: SendTurnRequest.parse({ text, modality: 'text' }),
        log,
      });
      return { result, command };
    };
    for (const h of c.history) if (h.role === 'user') await say(h.text).catch(() => undefined);

    const observeText = async (text: string): Promise<Observation> => {
      let observation: Observation;
    const { result, command } = await say(text);
    if (result.kind === 'clarification') {
      observation = { did: 'clarify', via: 'clarification', asked: true, reply: textOf(result.answer), taskKind: null };
    } else if (result.kind === 'answered') {
      const reply = textOf(result.answer);
      const asked = result.needsClarification || /よろしいですか|[？?]\s*$|（はい \/ いいえ）/.test(reply);
      observation = {
        did: command ? observedFromCommand(command === 'understand' ? 'understand' : command, reply, asked) : asked ? 'clarify' : 'answered',
        via: command ? (`command:${command}` as Observation['via']) : 'answered',
        asked,
        reply,
        taskKind: null,
      };
    } else if (result.taskId) {
      const row = await withTenant(db, principal.tenantId, (tx) =>
        tx.selectFrom('tasks').select(['kind', 'input']).where('id', '=', result.taskId!).executeTakeFirst(),
      );
      observation = {
        did: observedFromTask(row?.kind ?? null, (row?.input ?? null) as Record<string, unknown> | null),
        via: 'task',
        asked: false,
        reply: null,
        taskKind: row?.kind ?? null,
      };
    } else {
      observation = { did: 'notice', via: 'notice', asked: false, reply: result.notice, taskKind: null };
    }
      return observation;
    };

    let observation: Observation;
    const parts = c.attachments.length === 0 ? splitRequests(c.input) : null;
    if (c.attachments.some((a) => a.type === 'image')) {
      // LINE の写真は、文より先に写真を読む口（services/understand）へ渡る
      observation = { did: 'photo', via: 'photo', asked: false, reply: null, taskKind: null };
    } else if (CALL_REQUEST.test(c.input)) {
      // LINE の受け口が、振り分けより先に「電話して」を拾う（services/channels）
      observation = { did: 'call.start', via: 'channel', asked: false, reply: null, taskKind: null };
    } else if (parts) {
      // LINE の受け口と同じく、一度に複数の頼みは分けて 1 つずつ（services/api-gateway の channels）
      const observed = [];
      for (const part of parts) observed.push(await observeText(part));
      results.push({ ...scoreParts(c, observed), input: c.input, why: c.why });
      continue;
    } else {
      observation = await observeText(c.input);
    }
    results.push({ ...score(c, observation), input: c.input, why: c.why });
  }

  const by = (key: (r: (typeof results)[number]) => string) => {
    const m = new Map<string, { n: number; ok: number; violations: number }>();
    for (const r of results) {
      const k = key(r);
      const e = m.get(k) ?? { n: 0, ok: 0, violations: 0 };
      e.n += 1;
      if (r.doOk && !r.violation) e.ok += 1;
      if (r.violation) e.violations += 1;
      m.set(k, e);
    }
    return Object.fromEntries([...m].map(([k, v]) => [k, { ...v, rate: Math.round((v.ok / v.n) * 1000) / 10 }]));
  };
  const summary = {
    at: new Date().toISOString(),
    cases: results.length,
    routingOk: results.filter((r) => r.doOk && !r.violation).length,
    violations: results.filter((r) => r.violation).length,
    toReplyEval: results.filter((r) => r.needsReply).length,
    byCategory: by((r) => r.category),
    byDid: by((r) => r.did),
  };
  await writeFile(outFile, JSON.stringify({ summary, results }, null, 2) + '\n');
  console.log(JSON.stringify(summary, null, 2));
  console.log(`results: ${outFile}`);
  await app.close();
  await db.close();
  await rm(storeRoot, { recursive: true, force: true });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
