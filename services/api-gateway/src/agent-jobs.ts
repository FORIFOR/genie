/**
 * エージェントの仕事（本人の方針 2026-10-30: タスク管理を本人にさせず、Genie が引き受ける）。
 *
 * 2 種類の仕事を 1 つの列に並べる:
 *   managed  … Genie が起動して進める。終わったら完了条件を自分で確かめ、次の仕事へ進む
 *   observed … 本人が直接始めたセッション（hooks・発見で届く）を取り込んだもの。**読むだけ。**
 *              状態を写すだけで、再開・停止・指示はしない
 *
 * managed の流れ:
 *   queued → running（adapter で起動）→ verifying（完了条件）→ done / needs_review（本人の確認）
 *   確かめで落ちた → 同じセッションで直す（fix）。回数・同じ失敗の繰り返しで止める
 *
 * 守ること:
 *   - 完了はエージェントの言葉で決めない。完了条件（コマンド・成果物・本人の確認）で決める。条件のない仕事は作らない
 *   - 再試行は 3 回まで。同じ失敗が 2 回続いたら止める。止めるのは本人の言葉（「再開」）でしか解けない
 *   - 時間・手数・費用の上限を超えたら止める。費用が取れないエージェントは推さず、時間と回数で止める
 *   - **本人を待つことは失敗ではない。**承認を待つあいだは実行時間を数えない。カードの期限が切れたら作業を止めて
 *     waiting_human で待つ（別の方法を試し続けない）。再開は本人の言葉で、同じセッションの続きから。
 *     古いカードは使わず、操作が要るなら改めて聞く（ルールと権限もそのときの状態で評価し直される）
 *   - 先の仕事が止まっても、後の仕事は waiting_dependency で待つ。先の仕事が終わったら自動で始まる
 *   - 保留（本人の「仕事 3 を保留」・work_holds）は勝手に再開しない
 *   - 依存は作るときに既にある仕事だけ指せる（輪にならない）
 *   - 操作の許可は変えない。Claude Code の問いは hooks から LINE へ行く（agent-approvals.ts）
 *   - 出力の本文は DB に残さない（確かめの出力は、直すときにエージェントへ渡すだけ）
 *   - 本人に知らせるのは判断が要るときと、そのプロジェクトの列が終わったときだけ
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { sql } from 'kysely';
import { uuidv7 } from '@genie/contracts';
import { withIdentity, withTenant, type DbHandle, type ScopedDb } from '@genie/db';
import {
  ADAPTER_LABELS,
  RunClock,
  type AgentAdapter,
  type AgentKind,
  type AgentRunResult,
} from './agent-adapters.js';
import { redactSecrets } from './agent-approvals.js';
import type { AgentSession } from './agent-sessions.js';
import type { ProjectInfo } from './agent-approvals.js';

export type JobStatus =
  | 'queued'
  | 'running'
  | 'waiting_user'
  | 'waiting_human'
  | 'waiting_dependency'
  | 'verifying'
  | 'needs_review'
  | 'done'
  | 'stopped'
  | 'held'
  | 'cancelled'
  | 'idle'
  | 'ended';

export type CriterionKind = 'command' | 'artifact' | 'manual';

export interface CriterionInput {
  readonly kind: CriterionKind;
  /** 本人の言葉（「テストが通る」）。 */
  readonly text: string;
  /** command ならコマンド、artifact ならプロジェクトからの道。 */
  readonly spec?: string;
}

export interface JobInput {
  readonly tenantId: string;
  readonly userId: string;
  readonly agent: AgentKind;
  readonly projectRoot: string;
  readonly request: string;
  readonly title?: string;
  readonly criteria: readonly CriterionInput[];
  /** 先に終わっている必要がある仕事の番号。 */
  readonly after?: readonly number[];
  readonly maxAttempts?: number;
  readonly maxMinutes?: number;
  readonly maxTurns?: number;
  readonly maxCostUsd?: number;
  readonly maxLifetimeHours?: number;
  /** 本人に見せるプロジェクトの名前（無ければフォルダの名前）。 */
  readonly projectName?: string;
  /** Genie 自身の改善（agent-improve.ts）。作業コピーがそのままプロジェクトになる。 */
  readonly improve?: { readonly branch: string; readonly baseBranch: string; readonly baseSha: string };
}

export interface CheckResult {
  readonly ok: boolean;
  /** 出力の末尾（直すときにエージェントへ渡すだけ。残さない）。 */
  readonly output: string;
}

export interface AgentJobsDeps {
  readonly db: DbHandle;
  readonly adapters: Partial<Record<AgentKind, AgentAdapter>>;
  /** 本人のチャットへ知らせる。 */
  readonly notify?: (tenantId: string, userId: string, text: string) => Promise<void>;
  readonly projectOf?: (cwd: string) => Promise<ProjectInfo | null>;
  /** 検査用: 完了条件のコマンドの代わり。 */
  readonly runCheck?: (cwd: string, command: string) => Promise<CheckResult>;
  /** 1 日（24 時間）に使ってよい費用の合計。取れた費用だけを数える。 */
  readonly dailyBudgetUsd?: number;
  readonly maxConcurrent?: number;
  /** 検査用: このテナントの仕事だけを動かす（並んで走る別の検査の仕事を拾わない）。 */
  readonly onlyTenant?: string;
  readonly now?: () => Date;
  readonly log?: (event: string, detail: Record<string, unknown>) => void;
}

const CHECK_TIMEOUT_MS = 10 * 60_000;
const CHECK_OUTPUT = 4_000;
const SAME_FAILURE_LIMIT = 2;
/** 混雑・通信で止まったときの待ち（1 回目 1 分、2 回目 2 分…）。 */
const BACKOFF_MS = 60_000;
/** observed がこれだけ静かなら「止まっていそう」。 */
const OBSERVED_QUIET_MS = 15 * 60_000;
const SUMMARY_WINDOW_MS = 24 * 3600_000;
/** 確かめで落ちたときの理由の頭（次の実行を「直す」にする印）。 */
const UNMET = '完了条件が未達';

/** コマンドを走らせる（完了条件）。出力は末尾だけ持つ。 */
function runCommand(cwd: string, command: string): Promise<CheckResult> {
  return new Promise((done) => {
    const child = spawn('/bin/sh', ['-c', command], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    const keep = (chunk: Buffer) => {
      output = (output + chunk.toString('utf8')).slice(-CHECK_OUTPUT);
    };
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    const timer = setTimeout(() => child.kill('SIGKILL'), CHECK_TIMEOUT_MS);
    child.on('error', (error) => {
      clearTimeout(timer);
      done({ ok: false, output: error.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      done({ ok: code === 0, output });
    });
  });
}

/** 成果物の道がプロジェクトの中にあるか（外を指すものは条件として受けない）。 */
export function artifactPath(root: string, path: string): string | null {
  const full = resolve(root, path);
  const inside = relative(root, full);
  return inside === '' || inside.startsWith('..') || isAbsolute(inside) ? null : full;
}

/** 同じ失敗かを見る印。時刻・所要時間・番号の違いでは別の失敗にしない。 */
export function failureSignature(parts: readonly string[]): string {
  const normal = parts.join('\n').replace(/\d+/g, '#').replace(/\s+/g, ' ').trim();
  return createHash('sha256').update(normal).digest('hex').slice(0, 32);
}

const titleOf = (request: string) => {
  const line =
    request
      .split('\n')
      .find((l) => l.trim())
      ?.trim() ?? '仕事';
  return line.length > 80 ? `${line.slice(0, 79)}…` : line;
};

const projectName = (root: string) =>
  root.replace(/\/+$/, '').split('/').pop()?.slice(0, 120) || root.slice(0, 120);

/** observed の状態（セッションの写し）。 */
export function observedStatus(s: AgentSession): JobStatus {
  if (s.state === 'ended') return 'ended';
  if (s.heldBy) return 'held';
  if (s.state === 'waiting_user' || s.state === 'error') return 'waiting_user';
  return s.state === 'working' ? 'running' : 'idle';
}

type JobRow = {
  id: string;
  user_id: string;
  number: number;
  agent: string;
  control: string;
  project_root: string;
  project: string;
  request: string | null;
  title: string;
  status: string;
  stop_reason: string | null;
  last_failure: string | null;
  depends_on: string[];
  max_attempts: number;
  max_minutes: number;
  max_turns: number;
  max_cost_usd: string | number;
  attempts: number;
  turns: number;
  elapsed_ms: string | number;
  cost_usd: string | number;
  cost_known: boolean;
  failure_signature: string | null;
  same_failure_count: number;
  external_session_id: string | null;
  pending_instruction: string | null;
  human_wait_ms: string | number;
  waiting_since: Date | string | null;
  pending_approval: string | null;
  max_lifetime_hours: number;
  improve_branch: string | null;
  created_at: Date | string;
  updated_at: Date | string;
};

const STOP_TEXT: Record<string, string> = {
  limit_attempts: '再試行の上限（3 回）に達しました',
  same_failure: '同じ失敗が続きました',
  limit_time: '時間の上限に達しました',
  limit_turns: '手数の上限に達しました',
  limit_cost: '費用の上限に達しました',
  daily_budget: '1 日の費用の上限に達しました',
  dependency_cancelled: '先に終わるはずの仕事が取り消されました',
  lifetime: '再開できる期間を過ぎました',
  unavailable: 'エージェントを起動できません',
};

/** 次に使える本人の番号。呼ぶ前に本人の鎖を取る（lockOwner）。 */
async function nextNumber(tx: ScopedDb, userId: string): Promise<number> {
  const row = await tx
    .selectFrom('agent_jobs')
    .select((eb) => eb.fn.max('number').as('max'))
    .where('user_id', '=', userId)
    .executeTakeFirst();
  return (row?.max ?? 0) + 1;
}

/** 番号の採番と、同じセッションの二重取り込みを防ぐ鎖（この取引のあいだだけ）。 */
const lockOwner = (tx: ScopedDb, userId: string) =>
  sql`SELECT pg_advisory_xact_lock(hashtextextended(${`agent_jobs:${userId}`}, 0))`.execute(tx);

export class AgentJobs {
  readonly #active = new Map<
    string,
    { controller: AbortController; root: string; sessionId: string; clock: RunClock }
  >();
  readonly #runs = new Set<Promise<void>>();
  /** 直すときにエージェントへ渡す、確かめの出力（DB には残さない）。 */
  readonly #failureOutput = new Map<string, string>();
  #timer: NodeJS.Timeout | null = null;
  #ticking = false;

  constructor(private readonly deps: AgentJobsDeps) {}

  #now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  start(intervalMs = 15_000): void {
    if (this.#timer) return;
    void this.recover().then(() => this.tick());
    this.#timer = setInterval(() => void this.tick(), intervalMs);
    this.#timer.unref?.();
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
    for (const { controller } of this.#active.values()) controller.abort();
  }

  /** 検査用: いま走っている実行が全部終わるまで待つ。 */
  async settled(): Promise<void> {
    while (this.#runs.size > 0) await Promise.all(this.#runs);
  }

  /**
   * 仕事を作る。完了条件のない仕事は作らない（エージェントの「終わりました」で完了にしないため）。
   * 依存は既にある仕事だけ指せるので、輪にはならない。
   */
  async create(input: JobInput): Promise<{ id: string; number: number }> {
    const adapter = this.deps.adapters[input.agent];
    if (!adapter?.runnable)
      throw new JobRefused(`${ADAPTER_LABELS[input.agent]}はまだ Genie から起動できません。`);
    if (input.criteria.length === 0) throw new JobRefused('完了条件を 1 つ以上決めてください。');
    if (!isAbsolute(input.projectRoot))
      throw new JobRefused('プロジェクトは絶対パスで指定してください。');
    const isDir = await stat(input.projectRoot).then(
      (s) => s.isDirectory(),
      () => false,
    );
    if (!isDir) throw new JobRefused('プロジェクトのフォルダが見つかりません。');
    for (const c of input.criteria) {
      if (c.kind !== 'manual' && !c.spec?.trim())
        throw new JobRefused(`「${c.text}」の中身がありません。`);
      if (c.kind === 'artifact' && !artifactPath(input.projectRoot, c.spec!))
        throw new JobRefused(`成果物「${c.spec!}」がプロジェクトの外を指しています。`);
    }
    const info = await this.deps.projectOf?.(input.projectRoot).catch(() => null);
    const id = uuidv7();
    return withTenant(this.deps.db, input.tenantId, async (tx) => {
      await lockOwner(tx, input.userId);
      const after = input.after ?? [];
      const deps = after.length
        ? await tx
            .selectFrom('agent_jobs')
            .select(['id', 'number'])
            .where('user_id', '=', input.userId)
            .where('control', '=', 'managed')
            .where('number', 'in', [...after])
            .execute()
        : [];
      const missing = after.filter((n) => !deps.some((d) => d.number === n));
      if (missing.length > 0) throw new JobRefused(`仕事 ${missing.join('・')} はありません。`);
      const number = await nextNumber(tx, input.userId);
      await tx
        .insertInto('agent_jobs')
        .values({
          id,
          tenant_id: input.tenantId,
          user_id: input.userId,
          number,
          agent: input.agent,
          control: 'managed',
          project_root: info?.root ?? input.projectRoot,
          project: input.projectName ?? info?.name ?? projectName(input.projectRoot),
          request: input.request,
          title: input.title?.trim() || titleOf(input.request),
          status: deps.length > 0 ? 'waiting_dependency' : 'queued',
          depends_on: deps.map((d) => d.id),
          ...(input.improve
            ? {
                improve_branch: input.improve.branch,
                improve_base_branch: input.improve.baseBranch,
                improve_base_sha: input.improve.baseSha,
              }
            : {}),
          ...(input.maxLifetimeHours ? { max_lifetime_hours: input.maxLifetimeHours } : {}),
          ...(input.maxAttempts ? { max_attempts: input.maxAttempts } : {}),
          ...(input.maxMinutes ? { max_minutes: input.maxMinutes } : {}),
          ...(input.maxTurns ? { max_turns: input.maxTurns } : {}),
          ...(input.maxCostUsd ? { max_cost_usd: input.maxCostUsd } : {}),
        })
        .execute();
      await tx
        .insertInto('work_criteria')
        .values(
          input.criteria.map((c) => ({
            id: uuidv7(),
            tenant_id: input.tenantId,
            user_id: input.userId,
            agent_job_id: id,
            text: c.text.slice(0, 200),
            kind: c.kind,
            spec: c.kind === 'manual' ? null : c.spec!,
          })),
        )
        .execute();
      return { id, number };
    });
  }

  /** gateway が落ちたときに走っていた仕事を列へ戻す（子プロセスは一緒に止まる）。次の回数に数える。 */
  async recover(): Promise<number> {
    const rows = await withIdentity(this.deps.db, (tx) =>
      tx
        .selectFrom('agent_jobs')
        .select(['id', 'tenant_id'])
        .where('control', '=', 'managed')
        .where('status', 'in', ['running', 'verifying'])
        .$if(Boolean(this.deps.onlyTenant), (q) =>
          q.where('tenant_id', '=', this.deps.onlyTenant!),
        )
        .execute(),
    );
    let n = 0;
    for (const row of rows) {
      if (this.#active.has(row.id)) continue;
      const moved = await withTenant(this.deps.db, row.tenant_id, (tx) =>
        tx
          .updateTable('agent_jobs')
          .set({
            status: 'queued',
            next_run_at: null,
            last_failure: 'Genie が再起動しました',
            updated_at: this.#now(),
          })
          .where('id', '=', row.id)
          .where('status', 'in', ['running', 'verifying'])
          .executeTakeFirst(),
      );
      n += Number(moved.numUpdatedRows);
    }
    return n;
  }

  /** 始められる仕事を始める。返すのは始めた数。 */
  async tick(): Promise<number> {
    if (this.#ticking) return 0;
    this.#ticking = true;
    try {
      const now = this.#now();
      const due = await withIdentity(this.deps.db, (tx) =>
        tx
          .selectFrom('agent_jobs')
          .select(['id', 'tenant_id'])
          .where('control', '=', 'managed')
          .where('status', 'in', ['queued', 'waiting_dependency'])
          .where((eb) => eb.or([eb('next_run_at', 'is', null), eb('next_run_at', '<=', now)]))
          .$if(Boolean(this.deps.onlyTenant), (q) =>
            q.where('tenant_id', '=', this.deps.onlyTenant!),
          )
          .orderBy('id')
          .limit(50)
          .execute(),
      );
      let started = 0;
      for (const row of due) {
        if (this.#active.size >= (this.deps.maxConcurrent ?? 2)) break;
        const ok = await this.#consider(row.tenant_id, row.id).catch((error: unknown) => {
          this.deps.log?.('agent_jobs.consider_failed', {
            id: row.id,
            error: (error as Error).message,
          });
          return false;
        });
        if (ok) started += 1;
      }
      return started;
    } finally {
      this.#ticking = false;
    }
  }

  async #consider(tenantId: string, id: string): Promise<boolean> {
    const now = this.#now();
    const claim = await withTenant(this.deps.db, tenantId, async (tx) => {
      const job = (await tx
        .selectFrom('agent_jobs')
        .selectAll()
        .where('id', '=', id)
        .where('status', 'in', ['queued', 'waiting_dependency'])
        .forUpdate()
        .executeTakeFirst()) as JobRow | undefined;
      if (!job) return null;
      const lifetimeEnd = new Date(job.created_at).getTime() + job.max_lifetime_hours * 3600_000;
      if (now.getTime() >= lifetimeEnd) return this.#halt(tx, job, 'lifetime');
      if (job.depends_on.length > 0) {
        const before = await tx
          .selectFrom('agent_jobs')
          .select(['status'])
          .where('id', 'in', job.depends_on)
          .execute();
        if (before.some((d) => d.status === 'cancelled'))
          return this.#halt(tx, job, 'dependency_cancelled');
        // 先の仕事が止まった・保留でも失敗にしない。終わるまで待つ
        if (!before.every((d) => d.status === 'done')) {
          if (job.status !== 'waiting_dependency')
            await tx
              .updateTable('agent_jobs')
              .set({ status: 'waiting_dependency', updated_at: now })
              .where('id', '=', id)
              .execute();
          return null;
        }
      }
      // 同じプロジェクトでは一度に 1 つだけ（同じファイルを同時に触らせない）
      for (const active of this.#active.values()) if (active.root === job.project_root) return null;
      // 本人の保留に当たるものは始めない（解除は本人の言葉で）
      const hold = await tx
        .selectFrom('work_holds')
        .select('id')
        .where('user_id', '=', job.user_id)
        .where('status', '=', 'active')
        .where((eb) =>
          eb.or([
            eb(sql`strpos(lower(${job.project}), lower(subject))`, '>', 0),
            eb(sql`strpos(lower(${job.title}), lower(subject))`, '>', 0),
          ]),
        )
        .limit(1)
        .executeTakeFirst();
      if (hold) {
        await tx
          .updateTable('agent_jobs')
          .set({ status: 'held', updated_at: now })
          .where('id', '=', id)
          .execute();
        return null;
      }
      if (job.attempts >= job.max_attempts) return this.#halt(tx, job, 'limit_attempts');
      if (Number(job.elapsed_ms) >= job.max_minutes * 60_000)
        return this.#halt(tx, job, 'limit_time');
      if (job.turns >= job.max_turns) return this.#halt(tx, job, 'limit_turns');
      // 費用の取れない実行があっても、分かっている分が超えていれば止める
      if (Number(job.cost_usd) >= Number(job.max_cost_usd))
        return this.#halt(tx, job, 'limit_cost');
      if (this.deps.dailyBudgetUsd !== undefined) {
        const spent = await tx
          .selectFrom('agent_job_runs as r')
          .innerJoin('agent_jobs as j', 'j.id', 'r.job_id')
          .select(sql<string>`coalesce(sum(r.cost_usd), 0)`.as('sum'))
          .where('j.user_id', '=', job.user_id)
          .where('r.started_at', '>', new Date(now.getTime() - SUMMARY_WINDOW_MS))
          .executeTakeFirst();
        if (Number(spent?.sum ?? 0) >= this.deps.dailyBudgetUsd)
          return this.#halt(tx, job, 'daily_budget');
      }
      // 前の実行でセッションが動いていれば、その続きから
      const worked = await tx
        .selectFrom('agent_job_runs')
        .select('id')
        .where('job_id', '=', id)
        .where('turns', 'is not', null)
        .limit(1)
        .executeTakeFirst();
      // 承認を待って止めたときは結果が返っていないが、セッションは残っている
      const continuing = Boolean(worked) || job.pending_approval !== null;
      const resumeSessionId = continuing ? job.external_session_id : null;
      const sessionId = resumeSessionId ?? uuidv7ForSession();
      const criteria = await tx
        .selectFrom('work_criteria')
        .select(['text', 'kind', 'spec'])
        .where('agent_job_id', '=', id)
        .orderBy('created_at')
        .execute();
      const attempt = job.attempts + 1;
      const kind =
        job.pending_instruction && continuing
          ? 'resume'
          : job.last_failure?.startsWith(UNMET) && continuing
            ? 'fix'
            : continuing
              ? 'resume'
              : 'work';
      const runId = uuidv7();
      await tx
        .insertInto('agent_job_runs')
        .values({ id: runId, tenant_id: tenantId, job_id: id, attempt, kind, started_at: now })
        .execute();
      // 起動の前に id を残す（最初の hooks が届いたとき、どの仕事か分かるように）
      await tx
        .updateTable('agent_jobs')
        .set({
          status: 'running',
          attempts: attempt,
          external_session_id: sessionId,
          pending_instruction: null,
          pending_approval: null,
          next_run_at: null,
          started_at: sql`coalesce(started_at, ${now})`,
          updated_at: now,
        })
        .where('id', '=', id)
        .execute();
      return { job, runId, sessionId, resumeSessionId, kind, criteria };
    });
    if (!claim || claim === 'halted') return false;
    const adapter = this.deps.adapters[claim.job.agent as AgentKind];
    const controller = new AbortController();
    const clock = new RunClock(
      Math.max(1_000, claim.job.max_minutes * 60_000 - Number(claim.job.elapsed_ms)),
      () => this.#now().getTime(),
    );
    this.#active.set(id, {
      controller,
      root: claim.job.project_root,
      sessionId: claim.sessionId,
      clock,
    });
    const prompt = this.#prompt(claim.job, claim.kind, claim.criteria);
    const run = this.#execute(
      tenantId,
      claim.job,
      claim.runId,
      claim.sessionId,
      claim.resumeSessionId,
      prompt,
      adapter,
      controller,
      clock,
    )
      .catch((error: unknown) => {
        this.deps.log?.('agent_jobs.run_failed', { id, error: (error as Error).message });
      })
      .finally(() => {
        this.#active.delete(id);
        this.#runs.delete(run);
      });
    this.#runs.add(run);
    return true;
  }

  #prompt(
    job: JobRow,
    kind: string,
    criteria: readonly { text: string; kind: string; spec: string | null }[],
  ): string {
    const instruction = job.pending_instruction
      ? `\n\n本人からの追加の指示:\n${job.pending_instruction}`
      : '';
    if (kind === 'work') {
      const list = criteria
        .map(
          (c) =>
            `- ${c.text}${c.kind === 'manual' ? '（本人が確かめます）' : c.spec ? `: ${c.spec}` : ''}`,
        )
        .join('\n');
      return `${job.request ?? ''}${instruction}\n\n完了条件（終わったあとで Genie が確かめます）:\n${list}`;
    }
    if (kind === 'fix') {
      const output = this.#failureOutput.get(job.id);
      return `完了条件を確かめたところ、満たしていないものがあります: ${job.last_failure ?? ''}${
        output ? `\n\n確かめの出力:\n${redactSecrets(output)}` : ''
      }\n\n原因を調べて直してください。${instruction}`;
    }
    const pausedAt = job.pending_approval
      ? `前回は本人の承認を待つあいだに一時停止しました（待っていた操作: ${job.pending_approval}）。いまの状態を確かめてから続けてください。その操作がまだ必要なら改めて実行してください（改めて本人に聞きます）。\n\n`
      : '';
    return `${pausedAt}${job.pending_instruction ?? '前回の続きを進めて、元の依頼を終わらせてください。'}`;
  }

  async #execute(
    tenantId: string,
    job: JobRow,
    runId: string,
    sessionId: string,
    resumeSessionId: string | null,
    prompt: string,
    adapter: AgentAdapter | undefined,
    controller: AbortController,
    clock: RunClock,
  ): Promise<void> {
    const startedAt = this.#now().getTime();
    const result: AgentRunResult = adapter
      ? await adapter.run({
          cwd: job.project_root,
          prompt,
          sessionId,
          resumeSessionId,
          maxTurns: Math.max(1, job.max_turns - job.turns),
          maxCostUsd: Math.max(0.01, Number(job.max_cost_usd) - Number(job.cost_usd)),
          clock,
          signal: controller.signal,
        })
      : {
          outcome: 'unavailable',
          sessionId: null,
          costUsd: null,
          turns: null,
          exitCode: null,
          permissionDenied: false,
          note: 'エージェントが登録されていません',
        };
    const now = this.#now();
    // 本人を待った時間は実行時間に数えない
    const waited = clock.pausedMs;
    const elapsed = Math.max(0, now.getTime() - startedAt - waited);
    const current = await withTenant(this.deps.db, tenantId, async (tx) => {
      await tx
        .updateTable('agent_job_runs')
        .set({
          outcome:
            result.permissionDenied && result.outcome === 'success' ? 'denied' : result.outcome,
          cost_usd: result.costUsd,
          turns: result.turns,
          exit_code: result.exitCode,
          note: result.note?.slice(0, 300) ?? null,
          ended_at: now,
        })
        .where('id', '=', runId)
        .execute();
      return (await tx
        .updateTable('agent_jobs')
        .set({
          turns: sql`turns + ${result.turns ?? 0}`,
          elapsed_ms: sql`elapsed_ms + ${elapsed}`,
          human_wait_ms: sql`human_wait_ms + ${waited}`,
          cost_usd: sql`cost_usd + ${result.costUsd ?? 0}`,
          // 一度でも費用が取れなければ、合計は「分かっている分だけ」
          ...(result.costUsd === null ? { cost_known: false } : {}),
          ...(result.sessionId ? { external_session_id: result.sessionId } : {}),
          updated_at: now,
        })
        .where('id', '=', job.id)
        .returningAll()
        .executeTakeFirstOrThrow()) as JobRow;
    });
    // 走っているあいだに本人が保留・取り消しにした（実行は止めた）。列へは戻さない
    if (current.status !== 'running') return;
    switch (result.outcome) {
      case 'limit_turns':
      case 'limit_cost':
      case 'limit_time':
      case 'unavailable':
        await this.#haltNow(tenantId, current, result.outcome);
        return;
      case 'transient':
      case 'crashed':
      case 'error':
        await this.#retry(tenantId, current, result);
        return;
      case 'success':
        await this.#verify(tenantId, current, result.permissionDenied);
    }
  }

  /** 走り切らなかった。回数の範囲で、間を置いてやり直す。 */
  async #retry(tenantId: string, job: JobRow, result: AgentRunResult): Promise<void> {
    const reason = result.note ?? result.outcome;
    if (result.outcome === 'error') {
      await this.#failed(tenantId, job, reason, failureSignature([result.outcome, reason]));
      return;
    }
    if (job.attempts >= job.max_attempts) {
      await this.#haltNow(tenantId, job, 'limit_attempts', reason);
      return;
    }
    await withTenant(this.deps.db, tenantId, (tx) =>
      tx
        .updateTable('agent_jobs')
        .set({
          status: 'queued',
          last_failure: reason.slice(0, 300),
          next_run_at: new Date(this.#now().getTime() + BACKOFF_MS * 2 ** (job.attempts - 1)),
          updated_at: this.#now(),
        })
        .where('id', '=', job.id)
        .execute(),
    );
  }

  /** 完了条件を確かめる。完了はここでしか決めない。 */
  async #verify(tenantId: string, job: JobRow, denied: boolean): Promise<void> {
    await withTenant(this.deps.db, tenantId, (tx) =>
      tx
        .updateTable('agent_jobs')
        .set({ status: 'verifying', updated_at: this.#now() })
        .where('id', '=', job.id)
        .execute(),
    );
    const criteria = await withTenant(this.deps.db, tenantId, (tx) =>
      tx
        .selectFrom('work_criteria')
        .select(['id', 'text', 'kind', 'spec', 'met_at'])
        .where('agent_job_id', '=', job.id)
        .orderBy('created_at')
        .execute(),
    );
    const runCheck = this.deps.runCheck ?? runCommand;
    const failures: { text: string; output: string }[] = [];
    const now = this.#now();
    for (const c of criteria) {
      if (c.kind === 'manual') continue;
      let ok = false;
      let output = '';
      if (c.kind === 'command') {
        ({ ok, output } = await runCheck(job.project_root, c.spec!));
      } else {
        const path = artifactPath(job.project_root, c.spec!);
        ok =
          path !== null &&
          (await stat(path).then(
            (s) => s.isFile() || s.isDirectory(),
            () => false,
          ));
        output = ok ? '' : `成果物がありません: ${c.spec!}`;
      }
      await withTenant(this.deps.db, tenantId, (tx) =>
        tx
          .updateTable('work_criteria')
          .set({ met_at: ok ? now : null })
          .where('id', '=', c.id)
          .execute(),
      );
      if (!ok) failures.push({ text: c.text, output });
    }
    // 確かめているあいだに本人が保留・取り消しにしたら、結果で上書きしない
    const fresh = await withTenant(this.deps.db, tenantId, (tx) =>
      tx
        .selectFrom('agent_jobs')
        .select(['pending_instruction', 'status'])
        .where('id', '=', job.id)
        .executeTakeFirstOrThrow(),
    );
    if (fresh.status !== 'verifying') return;
    if (failures.length > 0) {
      const names = failures.map((f) => f.text).join('、');
      this.#failureOutput.set(job.id, failures.map((f) => `[${f.text}]\n${f.output}`).join('\n\n'));
      // 承認が得られずに進めなかったのなら、やり直しても同じ。本人に聞く
      if (denied) {
        await this.#ask(
          tenantId,
          job,
          `承認が得られなかった操作があり、終えられませんでした（未達: ${names}）。「仕事 ${String(job.number)} を再開」で続けます。`,
          `${UNMET}: ${names}`,
        );
        return;
      }
      await this.#failed(
        tenantId,
        job,
        `${UNMET}: ${names}`,
        failureSignature(failures.flatMap((f) => [f.text, f.output])),
      );
      return;
    }
    this.#failureOutput.delete(job.id);
    // 走っているあいだに届いた指示があれば、完了にせず続きを進める
    if (fresh.pending_instruction) {
      await this.#requeue(tenantId, job.id);
      return;
    }
    const manual = criteria.filter((c) => c.kind === 'manual' && !c.met_at);
    if (manual.length > 0) {
      const artifacts = criteria.filter((c) => c.kind === 'artifact').map((c) => c.spec!);
      await this.#ask(
        tenantId,
        job,
        [
          `仕事 ${String(job.number)}「${job.title}」は自動の確かめを通りました。あなたの確認を待っています。`,
          `確認すること: ${manual.map((c) => c.text).join('、')}`,
          ...(artifacts.length ? [`成果物: ${artifacts.join('、')}`] : []),
          job.improve_branch
            ? `「仕事 ${String(job.number)} の変更」で中身を見て、入れるなら「仕事 ${String(job.number)} を取り込む」、直すなら「仕事 ${String(job.number)} に指示: …」と送ってください。`
            : `よければ「仕事 ${String(job.number)} を確認した」、直すなら「仕事 ${String(job.number)} に指示: …」と送ってください。`,
        ].join('\n'),
        null,
        'needs_review',
      );
      return;
    }
    await this.#finish(tenantId, job);
  }

  async #requeue(tenantId: string, id: string): Promise<void> {
    await withTenant(this.deps.db, tenantId, (tx) =>
      tx
        .updateTable('agent_jobs')
        .set({ status: 'queued', next_run_at: null, updated_at: this.#now() })
        .where('id', '=', id)
        .execute(),
    );
  }

  /** 失敗を数える。同じ失敗が続いた・回数を使い切ったら止める。ほかは直しに戻す。 */
  async #failed(tenantId: string, job: JobRow, reason: string, signature: string): Promise<void> {
    const count = signature === job.failure_signature ? job.same_failure_count + 1 : 1;
    const stopFor =
      count >= SAME_FAILURE_LIMIT
        ? 'same_failure'
        : job.attempts >= job.max_attempts
          ? 'limit_attempts'
          : null;
    await withTenant(this.deps.db, tenantId, (tx) =>
      tx
        .updateTable('agent_jobs')
        .set({
          failure_signature: signature,
          same_failure_count: count,
          last_failure: reason.slice(0, 300),
          ...(stopFor ? {} : { status: 'queued', next_run_at: null }),
          updated_at: this.#now(),
        })
        .where('id', '=', job.id)
        .execute(),
    );
    if (stopFor) await this.#haltNow(tenantId, job, stopFor, reason);
  }

  async #finish(tenantId: string, job: JobRow): Promise<void> {
    const now = this.#now();
    const rest = await withTenant(this.deps.db, tenantId, async (tx) => {
      await tx
        .updateTable('agent_jobs')
        .set({
          status: 'done',
          stop_reason: null,
          last_failure: null,
          finished_at: now,
          updated_at: now,
        })
        .where('id', '=', job.id)
        .execute();
      await this.#notice(
        tx,
        tenantId,
        job.user_id,
        `仕事 ${String(job.number)} が終わりました`,
        job.title,
      );
      const left = await tx
        .selectFrom('agent_jobs')
        .select((eb) => eb.fn.countAll<string>().as('n'))
        .where('user_id', '=', job.user_id)
        .where('control', '=', 'managed')
        .where('project_root', '=', job.project_root)
        .where('status', 'in', [
          'queued',
          'running',
          'verifying',
          'waiting_human',
          'waiting_dependency',
          'needs_review',
        ])
        .executeTakeFirst();
      return Number(left?.n ?? 0);
    });
    // 判断が要らない完了は Mac の通知だけ。そのプロジェクトの列が空になったらチャットへ 1 回
    if (rest === 0)
      await this.#tell(
        tenantId,
        job.user_id,
        `✓ ${job.project} の仕事はすべて終わりました（最後: 仕事 ${String(job.number)}「${job.title}」）。`,
      );
  }

  /** 本人の答えが要る状態にして知らせる。 */
  async #ask(
    tenantId: string,
    job: JobRow,
    text: string,
    failure: string | null,
    status: 'waiting_human' | 'needs_review' = 'waiting_human',
  ): Promise<void> {
    await withTenant(this.deps.db, tenantId, async (tx) => {
      await tx
        .updateTable('agent_jobs')
        .set({
          status,
          ...(failure ? { last_failure: failure.slice(0, 300) } : {}),
          ...(status === 'waiting_human' ? { waiting_since: this.#now() } : {}),
          updated_at: this.#now(),
        })
        .where('id', '=', job.id)
        .execute();
      await this.#notice(
        tx,
        tenantId,
        job.user_id,
        `仕事 ${String(job.number)} はあなたの答えを待っています`,
        text,
      );
    });
    await this.#tell(tenantId, job.user_id, `🔔 ${text}`);
  }

  /** 取引の中で止める（列を見ている最中に分かったとき）。知らせは取引のあとに送れないので、ここで残して送る。 */
  async #halt(tx: ScopedDb, job: JobRow, reason: string): Promise<'halted'> {
    const text = this.#stopText(job, reason, null);
    await tx
      .updateTable('agent_jobs')
      .set({
        status: 'stopped',
        stop_reason: reason,
        finished_at: this.#now(),
        updated_at: this.#now(),
      })
      .where('id', '=', job.id)
      .execute();
    const tenantId = await this.#noticeForJob(tx, job, text);
    void this.#tell(tenantId, job.user_id, `🔔 ${text}`);
    return 'halted';
  }

  async #noticeForJob(tx: ScopedDb, job: JobRow, text: string): Promise<string> {
    const row = await tx
      .selectFrom('agent_jobs')
      .select('tenant_id')
      .where('id', '=', job.id)
      .executeTakeFirstOrThrow();
    await this.#notice(
      tx,
      row.tenant_id,
      job.user_id,
      `仕事 ${String(job.number)} を止めました`,
      text,
    );
    return row.tenant_id;
  }

  async #haltNow(
    tenantId: string,
    job: JobRow,
    reason: string,
    detail: string | null = null,
  ): Promise<void> {
    const text = this.#stopText(job, reason, detail);
    await withTenant(this.deps.db, tenantId, async (tx) => {
      await tx
        .updateTable('agent_jobs')
        .set({
          status: 'stopped',
          stop_reason: reason,
          ...(detail ? { last_failure: detail.slice(0, 300) } : {}),
          finished_at: this.#now(),
          updated_at: this.#now(),
        })
        .where('id', '=', job.id)
        .execute();
      await this.#notice(
        tx,
        tenantId,
        job.user_id,
        `仕事 ${String(job.number)} を止めました`,
        text,
      );
    });
    await this.#tell(tenantId, job.user_id, `🔔 ${text}`);
  }

  #stopText(job: JobRow, reason: string, detail: string | null): string {
    const why = STOP_TEXT[reason] ?? reason;
    return [
      `仕事 ${String(job.number)}「${job.title}」を止めました: ${why}。`,
      ...(detail ? [detail] : []),
      `続けるなら「仕事 ${String(job.number)} を再開」、指示を足すなら「仕事 ${String(job.number)} に指示: …」と送ってください。`,
    ].join('\n');
  }

  async #notice(
    tx: ScopedDb,
    tenantId: string,
    userId: string,
    title: string,
    body: string,
  ): Promise<void> {
    await tx
      .insertInto('user_notices')
      .values({
        id: uuidv7(),
        tenant_id: tenantId,
        user_id: userId,
        kind: 'agent_job',
        title: title.slice(0, 200),
        body: body.slice(0, 2000),
      })
      .execute();
  }

  /** チャットへ。届かなくても仕事の状態は変えない（通知は Mac にも残っている）。 */
  async #tell(tenantId: string, userId: string, text: string): Promise<void> {
    await Promise.resolve(this.deps.notify?.(tenantId, userId, text)).catch((error: unknown) =>
      this.deps.log?.('agent_jobs.notify_failed', { error: (error as Error).message }),
    );
  }

  /**
   * 届いたセッションを仕事に結び付ける（hooks・発見の両方から呼ばれる）。
   * Genie が起動したものは、その仕事へ。本人が直接始めたものは observed の仕事として取り込む（読むだけ）。
   */
  async observe(
    tenantId: string,
    userId: string,
    session: AgentSession,
    cwd: string | undefined,
  ): Promise<void> {
    const info = cwd ? await this.deps.projectOf?.(cwd).catch(() => null) : null;
    const now = this.#now();
    await withTenant(this.deps.db, tenantId, async (tx) => {
      await lockOwner(tx, userId);
      const job = await tx
        .selectFrom('agent_jobs')
        .select(['id', 'control', 'status', 'request'])
        .where('user_id', '=', userId)
        .where('external_session_id', '=', session.externalSessionId)
        .where('agent', '=', session.source)
        .orderBy('created_at', 'desc')
        .executeTakeFirst();
      let jobId = job?.id ?? null;
      if (job?.control === 'observed') {
        await tx
          .updateTable('agent_jobs')
          .set({
            status: observedStatus(session),
            ...(session.title && !job.request
              ? { request: session.title, title: session.title }
              : {}),
            updated_at: now,
          })
          .where('id', '=', job.id)
          .execute();
      } else if (!job) {
        // 終わったセッションを新しく取り込まない（古い出来事で列を増やさない）
        if (session.state === 'ended') return;
        // Genie が再開した仕事の、前のセッションは既に結び付いている
        const linked = await tx
          .selectFrom('agent_sessions')
          .select('agent_job_id')
          .where('id', '=', session.id)
          .executeTakeFirst();
        if (linked?.agent_job_id) return;
        jobId = uuidv7();
        const root = info?.root ?? cwd ?? null;
        const project = info?.name ?? session.project ?? '不明なプロジェクト';
        await tx
          .insertInto('agent_jobs')
          .values({
            id: jobId,
            tenant_id: tenantId,
            user_id: userId,
            number: await nextNumber(tx, userId),
            agent: session.source,
            control: 'observed',
            project_root: root ?? project,
            project,
            request: session.title,
            title: session.title ?? `${ADAPTER_LABELS[session.source]}のセッション`,
            status: observedStatus(session),
            external_session_id: session.externalSessionId,
            started_at: now,
          })
          .execute();
      }
      if (jobId)
        await tx
          .updateTable('agent_sessions')
          .set({ agent_job_id: jobId })
          .where('id', '=', session.id)
          .where('agent_job_id', 'is', null)
          .execute();
    });
  }

  /** 本人の仕事の一覧（開いているものと、この 1 日に終わったもの）。 */
  async list(tenantId: string, userId: string) {
    const since = new Date(this.#now().getTime() - SUMMARY_WINDOW_MS);
    const rows = await withTenant(this.deps.db, tenantId, (tx) =>
      tx
        .selectFrom('agent_jobs')
        .selectAll()
        .where('user_id', '=', userId)
        .where((eb) =>
          eb.or([
            eb('status', 'not in', ['done', 'cancelled', 'ended', 'stopped']),
            eb('updated_at', '>', since),
          ]),
        )
        .orderBy('number')
        .execute(),
    );
    return rows as unknown as (JobRow & { created_at: Date; finished_at: Date | null })[];
  }

  /** 「今どうなってる？」の答え。プロジェクトごとに、確認待ち・進行中・保留中・止めた・完了。仕事がなければ null。 */
  async summary(tenantId: string, userId: string): Promise<string | null> {
    const jobs = await this.list(tenantId, userId);
    if (jobs.length === 0) return null;
    const now = this.#now().getTime();
    const groups = new Map<string, typeof jobs>();
    for (const job of jobs) groups.set(job.project, [...(groups.get(job.project) ?? []), job]);
    const lines: string[] = [];
    const name = (j: (typeof jobs)[number]) =>
      `仕事 ${String(j.number)}「${j.title}」（${ADAPTER_LABELS[j.agent as AgentKind]}${j.control === 'observed' ? '・見守りのみ' : ''}）`;
    const section = (
      label: string,
      items: typeof jobs,
      extra?: (j: (typeof jobs)[number]) => string,
    ) => {
      if (items.length === 0) return;
      lines.push(`${label}:`);
      for (const j of items) lines.push(`・${name(j)}${extra?.(j) ?? ''}`);
    };
    for (const [project, items] of groups) {
      if (lines.length > 0) lines.push('');
      lines.push(`■ ${project}`);
      const quiet = (j: (typeof jobs)[number]) =>
        j.control === 'observed' &&
        j.status === 'running' &&
        now - new Date(j.updated_at).getTime() > OBSERVED_QUIET_MS;
      section(
        '確認待ち',
        items.filter((j) => ['needs_review', 'waiting_user', 'waiting_human'].includes(j.status)),
        (j) => (j.last_failure && j.control === 'managed' ? ` 未達: ${j.last_failure}` : ''),
      );
      section(
        '進行中',
        items.filter((j) => ['running', 'verifying'].includes(j.status) && !quiet(j)),
      );
      section('止まっていそう', items.filter(quiet));
      section(
        '先の仕事待ち',
        items.filter((j) => j.status === 'waiting_dependency'),
      );
      section(
        '順番待ち',
        items.filter((j) => j.status === 'queued'),
      );
      section(
        '次の頼み待ち',
        items.filter((j) => j.status === 'idle'),
      );
      section(
        '保留中',
        items.filter((j) => j.status === 'held'),
      );
      section(
        '止めた',
        items.filter((j) => j.status === 'stopped'),
        (j) => (j.stop_reason ? ` ${STOP_TEXT[j.stop_reason] ?? j.stop_reason}` : ''),
      );
      section(
        '完了',
        items.filter((j) => j.status === 'done'),
      );
    }
    return lines.join('\n');
  }

  async #byNumber(tenantId: string, userId: string, number: number) {
    return (await withTenant(this.deps.db, tenantId, (tx) =>
      tx
        .selectFrom('agent_jobs')
        .selectAll()
        .where('user_id', '=', userId)
        .where('number', '=', number)
        .executeTakeFirst(),
    )) as JobRow | undefined;
  }

  /** 本人が保留にする。走っていれば止める。解除は「再開」だけ。 */
  async hold(tenantId: string, userId: string, number: number): Promise<string> {
    const job = await this.#byNumber(tenantId, userId, number);
    const refused = refuse(job, number);
    if (refused) return refused;
    if (
      ![
        'queued',
        'running',
        'verifying',
        'waiting_human',
        'waiting_dependency',
        'needs_review',
        'stopped',
      ].includes(job!.status)
    )
      return `仕事 ${String(number)} は保留にできる状態ではありません。`;
    await withTenant(this.deps.db, tenantId, (tx) =>
      tx
        .updateTable('agent_jobs')
        .set({ status: 'held', next_run_at: null, updated_at: this.#now() })
        .where('id', '=', job!.id)
        .execute(),
    );
    this.#active.get(job!.id)?.controller.abort();
    return `仕事 ${String(number)} を保留にしました。「仕事 ${String(number)} を再開」と言われるまで始めません。`;
  }

  /** 本人が再開する。回数は数え直す（本人が見て決めたので）。時間・手数は使った分を戻す。費用の上限は戻さない。 */
  async resume(
    tenantId: string,
    userId: string,
    number: number,
    instruction?: string,
  ): Promise<string> {
    const job = await this.#byNumber(tenantId, userId, number);
    const refused = refuse(job, number);
    if (refused) return refused;
    if (
      ![
        'held',
        'stopped',
        'waiting_human',
        'waiting_dependency',
        'needs_review',
        'queued',
        'running',
        'verifying',
      ].includes(job!.status)
    )
      return `仕事 ${String(number)} は終わっています。続きは新しい仕事にしてください。`;
    if (
      instruction &&
      ['running', 'verifying', 'queued', 'waiting_dependency'].includes(job!.status)
    ) {
      await withTenant(this.deps.db, tenantId, (tx) =>
        tx
          .updateTable('agent_jobs')
          .set({ pending_instruction: instruction.slice(0, 2000), updated_at: this.#now() })
          .where('id', '=', job!.id)
          .execute(),
      );
      return `仕事 ${String(number)} への指示を預かりました。次の実行で渡します。`;
    }
    if (job!.status === 'waiting_dependency')
      return `仕事 ${String(number)} は先の仕事を待っています。終わったら自動で始めます。`;
    if (!instruction && !['held', 'stopped', 'waiting_human'].includes(job!.status))
      return `仕事 ${String(number)} は止まっていません。`;
    if (job!.stop_reason === 'limit_cost')
      return `仕事 ${String(number)} は費用の上限で止めました。上限を上げて新しい仕事として頼んでください。`;
    if (job!.stop_reason === 'lifetime')
      return `仕事 ${String(number)} は再開できる期間を過ぎました。新しい仕事として頼んでください。`;
    // 上限で止めたものは、本人が見て決めたので数え直す。本人を待っていただけのものは、残りの予算のまま続ける
    const paused = job!.status !== 'stopped';
    const waitedMs = job!.waiting_since
      ? Math.max(0, this.#now().getTime() - new Date(job!.waiting_since).getTime())
      : 0;
    await withTenant(this.deps.db, tenantId, (tx) =>
      tx
        .updateTable('agent_jobs')
        .set({
          status: 'queued',
          stop_reason: null,
          // 本人を待って止めた実行は回数に数えない
          ...(paused
            ? { attempts: sql<number>`greatest(attempts - 1, 0)` }
            : { attempts: 0, turns: 0, elapsed_ms: 0 }),
          human_wait_ms: sql`human_wait_ms + ${waitedMs}`,
          waiting_since: null,
          failure_signature: null,
          same_failure_count: 0,
          next_run_at: null,
          finished_at: null,
          ...(instruction ? { pending_instruction: instruction.slice(0, 2000) } : {}),
          updated_at: this.#now(),
        })
        .where('id', '=', job!.id)
        .execute(),
    );
    await this.tick();
    return `仕事 ${String(number)} を再開します。`;
  }

  /** 承認の窓口（agent-approvals.ts）から呼ばれる。Genie が起動した仕事のセッションだけに効く。 */
  readonly humanWait = {
    started: (_tenantId: string, _userId: string, sessionId: string): void => {
      this.#bySession(sessionId)?.[1].clock.pause();
    },
    answered: (_tenantId: string, _userId: string, sessionId: string): void => {
      this.#bySession(sessionId)?.[1].clock.resume();
    },
    /** 答えがないまま終わった。作業を止めて待つ（失敗にしない・別の方法を試させない）。 */
    unanswered: async (
      tenantId: string,
      userId: string,
      sessionId: string,
      asked: { operation: string; summary: string; reason: 'expired' | 'undelivered' },
    ): Promise<void> => {
      const entry = this.#bySession(sessionId);
      if (!entry) return;
      const [id, active] = entry;
      const now = this.#now();
      const job = await withTenant(this.deps.db, tenantId, async (tx) => {
        const row = (await tx
          .updateTable('agent_jobs')
          .set({
            status: 'waiting_human',
            waiting_since: now,
            pending_approval: `${asked.operation}: ${asked.summary}`.slice(0, 500),
            updated_at: now,
          })
          .where('id', '=', id)
          .where('status', '=', 'running')
          .returningAll()
          .executeTakeFirst()) as JobRow | undefined;
        if (!row) return null;
        await this.#notice(
          tx,
          tenantId,
          userId,
          `仕事 ${String(row.number)} を一時停止しました`,
          row.title,
        );
        return row;
      });
      // 止めてから知らせる。Claude Code に別の方法を試させない
      active.controller.abort();
      if (!job) return;
      const leftMin = Math.max(
        0,
        Math.ceil((job.max_minutes * 60_000 - Number(job.elapsed_ms)) / 60_000),
      );
      await this.#tell(
        tenantId,
        userId,
        [
          `🔔 ${job.project} の仕事 ${String(job.number)}「${job.title}」を安全に一時停止しました。`,
          asked.reason === 'expired'
            ? '理由: 承認の期限が切れました（失敗ではありません）。'
            : '理由: 承認のカードを届けられませんでした（失敗ではありません）。',
          `待っていた操作: ${asked.operation}: ${asked.summary}`.slice(0, 300),
          `進み具合は保存しました。残りの実行時間は最大 ${String(leftMin)} 分です。`,
          `戻ったら「仕事 ${String(job.number)} を再開」と送ってください。操作が要るときは改めて承認を聞きます。`,
        ].join('\n'),
      );
    },
  };

  #bySession(sessionId: string) {
    for (const entry of this.#active) if (entry[1].sessionId === sessionId) return entry;
    return null;
  }

  /** 本人が「確かめた」と言った。手で確かめる条件を満たしたことにして完了へ。 */
  async confirm(
    tenantId: string,
    userId: string,
    number: number,
    options: { readonly adopted?: boolean } = {},
  ): Promise<string> {
    const job = await this.#byNumber(tenantId, userId, number);
    const refused = refuse(job, number);
    if (refused) return refused;
    if (job!.status !== 'needs_review') return `仕事 ${String(number)} は確認を待っていません。`;
    // 改善の仕事は、確認＝本体への取り込み。言葉を分けて、取り込まずに完了にしない
    if (job!.improve_branch && !options.adopted)
      return `仕事 ${String(number)} は「仕事 ${String(number)} を取り込む」で本体へ入れます。やめるなら「仕事 ${String(number)} を取り消す」と送ってください。`;
    await withTenant(this.deps.db, tenantId, (tx) =>
      tx
        .updateTable('work_criteria')
        .set({ met_at: this.#now() })
        .where('agent_job_id', '=', job!.id)
        .where('kind', '=', 'manual')
        .execute(),
    );
    await this.#finish(tenantId, job!);
    await this.tick();
    return `仕事 ${String(number)} を完了にしました。`;
  }

  async cancel(tenantId: string, userId: string, number: number): Promise<string> {
    const job = await this.#byNumber(tenantId, userId, number);
    const refused = refuse(job, number);
    if (refused) return refused;
    if (job!.status === 'done' || job!.status === 'cancelled')
      return `仕事 ${String(number)} は終わっています。`;
    await withTenant(this.deps.db, tenantId, (tx) =>
      tx
        .updateTable('agent_jobs')
        .set({ status: 'cancelled', finished_at: this.#now(), updated_at: this.#now() })
        .where('id', '=', job!.id)
        .execute(),
    );
    this.#active.get(job!.id)?.controller.abort();
    return `仕事 ${String(number)} を取り消しました。`;
  }

  /** 1 件の詳しい様子（条件と実行の履歴）。 */
  async detail(tenantId: string, userId: string, number: number): Promise<string> {
    const job = await this.#byNumber(tenantId, userId, number);
    if (!job) return `仕事 ${String(number)} はありません。`;
    const { criteria, runs, sessions } = await withTenant(this.deps.db, tenantId, async (tx) => ({
      criteria: await tx
        .selectFrom('work_criteria')
        .select(['text', 'kind', 'met_at'])
        .where('agent_job_id', '=', job.id)
        .orderBy('created_at')
        .execute(),
      runs: await tx
        .selectFrom('agent_job_runs')
        .select(['attempt', 'kind', 'outcome', 'cost_usd', 'turns'])
        .where('job_id', '=', job.id)
        .orderBy('started_at')
        .execute(),
      sessions: await tx
        .selectFrom('agent_sessions')
        .select((eb) => eb.fn.countAll<string>().as('n'))
        .where('agent_job_id', '=', job.id)
        .executeTakeFirst(),
    }));
    const cost = job.cost_known
      ? `${Number(job.cost_usd).toFixed(2)} ドル`
      : `分かっている分 ${Number(job.cost_usd).toFixed(2)} ドル（費用の取れない実行あり）`;
    return [
      `仕事 ${String(job.number)}「${job.title}」`,
      `プロジェクト: ${job.project}／${ADAPTER_LABELS[job.agent as AgentKind]}／${job.control === 'observed' ? '見守りのみ' : 'Genie が実行'}`,
      `状態: ${job.status}${job.stop_reason ? `（${STOP_TEXT[job.stop_reason] ?? job.stop_reason}）` : ''}`,
      ...(job.last_failure ? [`直近の未達: ${job.last_failure}`] : []),
      ...(criteria.length
        ? ['完了条件:', ...criteria.map((c) => `・${c.met_at ? '✓' : '□'} ${c.text}`)]
        : ['完了条件: 未確認（本人が直接始めたセッション）']),
      `セッション: ${String(Number(sessions?.n ?? 0))} 件`,
      ...(runs.length
        ? [
            `実行: ${String(runs.length)} 回（費用 ${cost}）`,
            ...runs.map(
              (r) =>
                `・${String(r.attempt)} 回目 ${r.kind}: ${r.outcome ?? '実行中'}${r.turns !== null ? ` ${String(r.turns)} 手` : ''}`,
            ),
          ]
        : []),
    ].join('\n');
  }

  /** チャットの決まった言い方。当たらなければ null（ふつうの会話へ）。 */
  async command(tenantId: string, userId: string, text: string): Promise<string | null> {
    const t = text.trim().replace(/[　\s]+/g, ' ');
    if (/^(?:今|いま)どうなってる|^(?:エージェント|仕事)の(?:状況|様子|一覧)/.test(t))
      return this.summary(tenantId, userId);
    const instruct = /^仕事 ?(\d+) ?に指示[:：は]? ?([\s\S]+)$/.exec(text.trim());
    if (instruct) return this.resume(tenantId, userId, Number(instruct[1]), instruct[2]!.trim());
    const act =
      /^仕事 ?(\d+) ?(?:を|の)? ?(保留|再開|確認した|確認しました|取り消|やめ|詳しく|様子)/.exec(t);
    if (!act) return null;
    const number = Number(act[1]);
    switch (act[2]) {
      case '保留':
        return this.hold(tenantId, userId, number);
      case '再開':
        return this.resume(tenantId, userId, number);
      case '確認した':
      case '確認しました':
        return this.confirm(tenantId, userId, number);
      case '取り消':
      case 'やめ':
        return this.cancel(tenantId, userId, number);
      default:
        return this.detail(tenantId, userId, number);
    }
  }

  /** そのセッションが属する仕事の名前（承認カードの「タスク」の行）。無ければ null。 */
  async jobLabel(
    tenantId: string,
    userId: string,
    externalSessionId: string,
  ): Promise<string | null> {
    const job = await withTenant(this.deps.db, tenantId, (tx) =>
      tx
        .selectFrom('agent_jobs')
        .select(['number', 'title', 'control'])
        .where('user_id', '=', userId)
        .where('external_session_id', '=', externalSessionId)
        .where('control', '=', 'managed')
        .orderBy('created_at', 'desc')
        .executeTakeFirst(),
    );
    return job ? `仕事 ${String(job.number)}「${job.title}」` : null;
  }
}

/** 本人に見せられる断り（作るときの条件違反）。 */
export class JobRefused extends Error {}

/** Genie が操作してよい仕事か。observed は読むだけ。 */
function refuse(job: JobRow | undefined, number: number): string | null {
  if (!job) return `仕事 ${String(number)} はありません。`;
  if (job.control === 'observed')
    return `仕事 ${String(number)} はご自身で始めたセッションなので、Genie からは操作しません（見守りのみ）。`;
  return null;
}

/** Claude Code の --session-id は UUID（v7 でよい）。 */
function uuidv7ForSession(): string {
  return uuidv7();
}
