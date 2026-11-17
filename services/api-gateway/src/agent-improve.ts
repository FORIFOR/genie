/**
 * Genie 自身の改善（本人の方針 2026-10-31「LINE から Genie を直せるように。自己改善も」）。
 *
 *   「Genie を直して: …」 → 別の作業コピー（git worktree）と枝を作り、Claude Code の仕事として進める
 *   自動の確かめ（変更がある・型・gateway の検査）が通る → 本人に「仕事 N の変更」「仕事 N を取り込む」を案内
 *   「仕事 N を取り込む」 → 手元の元の枝へ merge（1 コミットにまとまるので「仕事 N を戻す」で戻せる）
 *
 *   自己改善: 自分の仕事が同じ理由で何度も止まっていたら、提案する（週に同じ理由は 1 回・開いた提案は 1 つだけ）
 *             **提案するだけで勝手に始めない。**「改善の提案を進めて」で上と同じ流れに入る
 *
 * 守ること:
 *   - 頼めるのはこの Mac の持ち主（Claude Code の hooks を登録した本人）だけ。LINE の他の利用者は断る
 *   - 動いている Genie のファイルには、取り込むまで触らない。走らせる枝は本体と別の作業コピーなので、承認ルールも引き継がない
 *   - 操作の許可は変えない。作業中の問いはいつもどおり LINE のカードへ
 *   - push しない。再起動もしない（起動できない変更で LINE の入口ごと失わないよう、再起動は本人が Mac で行う）
 *   - 検査を消す・ゲートを変える変更は、LINE からは取り込まない（Mac で本人が見る）
 *   - 取り込みは本人の言葉でだけ行う。verify-all は通していないので、そう伝える
 */
import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { uuidv7 } from '@genie/contracts';
import { withIdentity, withTenant, type DbHandle } from '@genie/db';
import { JobRefused, type AgentJobs, type CriterionInput } from './agent-jobs.js';

const exec = promisify(execFile);
const PROPOSAL_WINDOW_MS = 7 * 24 * 3600_000;
const PROPOSAL_MIN_STOPS = 2;
const STAT_LIMIT = 1500;
/** 改善の提案のもとにする止まり方（本人を待っているものは失敗ではないので入れない）。 */
const SIGNALS: Record<string, string> = {
  same_failure: '同じ失敗が続いて',
  limit_attempts: '再試行の上限で',
  unavailable: 'エージェントを起動できず',
  limit_time: '時間の上限で',
  limit_turns: '手数の上限で',
};

export type RunTool = (cwd: string, file: string, args: readonly string[]) => Promise<string>;

const runTool: RunTool = async (cwd, file, args) =>
  (await exec(file, [...args], { cwd, timeout: 5 * 60_000, maxBuffer: 4 * 1024 * 1024 })).stdout;

export interface GenieImproverDeps {
  readonly db: DbHandle;
  readonly jobs: Pick<AgentJobs, 'create' | 'tick' | 'confirm'>;
  /** Genie のリポジトリ。無ければこの環境では使えない。 */
  readonly repoRoot: string | null;
  readonly worktreesDir?: string;
  readonly notify?: (tenantId: string, userId: string, text: string) => Promise<void>;
  /** 検査用に差し替える。 */
  readonly run?: RunTool;
  readonly criteria?: readonly CriterionInput[];
  readonly now?: () => Date;
  readonly log?: (event: string, detail: Record<string, unknown>) => void;
}

/** 落としてはいけないもの（検査の削除・ゲートの変更）。git の --name-status の行から探す。 */
export function protectedChanges(nameStatus: string): string[] {
  const out: string[] = [];
  for (const line of nameStatus.split('\n')) {
    const [status, ...paths] = line.split('\t');
    if (!status) continue;
    // 名前を変えて外へ出すのも同じ（元と先の両方を見る）
    const gate = paths.find(
      (path) =>
        /^scripts\/(verify-|memguard)/.test(path) ||
        /^\.github\//.test(path) ||
        /(^|\/)CLAUDE\.md$/.test(path),
    );
    const test = paths.find((path) => /(\.test\.|(^|\/)tests?\/)/.test(path));
    const removedTest = status.startsWith('D') ? test : undefined;
    const hit = gate ?? removedTest;
    if (hit) out.push(hit);
  }
  return out;
}

const titleOf = (text: string) => {
  const line = text.split('\n')[0]!.trim();
  return `Genie の改善: ${line.length > 60 ? `${line.slice(0, 59)}…` : line}`;
};

/** 依頼の前に置く、作業の決まり。 */
const requestFor = (text: string) =>
  [
    'Genie 自身の改善です。今のフォルダは本体とは別の作業コピーと枝です。',
    '- 変更はこのフォルダの中だけで行う。push しない。本体のフォルダ・動いている Genie に触らない',
    '- 検査を消さない・弱めない。振る舞いを変えたら検査を足す',
    '- .env と data/ の中身、鍵は読まない',
    '',
    `本人の依頼: ${text}`,
  ].join('\n');

type ImproveRow = {
  id: string;
  number: number;
  title: string;
  status: string;
  project_root: string;
  improve_branch: string | null;
  improve_base_branch: string | null;
  improve_base_sha: string | null;
  improve_commit: string | null;
};

export class GenieImprover {
  readonly #runs = new Set<Promise<void>>();
  #timer: NodeJS.Timeout | null = null;

  constructor(private readonly deps: GenieImproverDeps) {}

  #now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  #git(cwd: string, ...args: string[]): Promise<string> {
    return (this.deps.run ?? runTool)(cwd, '/usr/bin/git', args).then((s) => s.trim());
  }

  #criteria(baseSha: string): readonly CriterionInput[] {
    return (
      this.deps.criteria ?? [
        {
          kind: 'command',
          text: '変更がある',
          spec: `test -n "$(git status --porcelain)" || ! git diff --quiet ${baseSha} HEAD`,
        },
        { kind: 'command', text: '型の検査が通る', spec: 'pnpm -s build && pnpm -s typecheck' },
        {
          kind: 'command',
          text: 'gateway の検査が通る',
          spec: 'PATH=/opt/homebrew/opt/libpq/bin:$PATH ./infra/db/with-test-db.sh pnpm -s --filter @genie/service-api-gateway test',
        },
        { kind: 'manual', text: '変更を見て、Genie に取り込むかを決める' },
      ]
    );
  }

  start(intervalMs = 6 * 3600_000): void {
    if (this.#timer) return;
    this.#timer = setInterval(() => void this.scan().catch(() => 0), intervalMs);
    this.#timer.unref?.();
    void this.scan().catch(() => 0);
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
  }

  /** 検査用: 準備が全部終わるまで待つ。 */
  async settled(): Promise<void> {
    while (this.#runs.size > 0) await Promise.all(this.#runs);
  }

  async #isOwner(tenantId: string, userId: string): Promise<boolean> {
    const row = await withIdentity(this.deps.db, (tx) =>
      tx
        .selectFrom('agent_connections')
        .select('id')
        .where('tenant_id', '=', tenantId)
        .where('user_id', '=', userId)
        .where('source', '=', 'claude_code')
        .where('revoked_at', 'is', null)
        .limit(1)
        .executeTakeFirst(),
    );
    return row !== undefined;
  }

  async command(tenantId: string, userId: string, text: string): Promise<string | null> {
    const t = text.trim();
    const ask = /^(?:Genie|ジーニー) ?(?:を|の)? ?(?:直して|改善して)[:：は]?\s*([\s\S]*)$/i.exec(
      t,
    );
    const job = /^仕事 ?(\d+) ?(?:を|の)? ?(変更|取り込|戻)/.exec(t);
    const proposal = /^(?:改善の)?提案を ?(進めて|見送)/.exec(t);
    if (!ask && !job && !proposal) return null;
    if (!this.deps.repoRoot) return 'この環境では Genie の改善を使えません。';
    if (!(await this.#isOwner(tenantId, userId)))
      return 'Genie の改善は、この Mac の持ち主だけが頼めます。';
    if (ask) {
      if (!ask[1]!.trim()) return '「Genie を直して: 直したいこと」の形で送ってください。';
      return this.#begin(tenantId, userId, ask[1]!.trim());
    }
    if (proposal) return this.#decide(tenantId, userId, proposal[1] === '進めて');
    const number = Number(job![1]);
    const row = await this.#job(tenantId, userId, number);
    // 改善の仕事でなければ、ふつうの仕事の言葉へ回す
    if (!row?.improve_branch) return null;
    if (job![2] === '変更') return this.#changes(row);
    if (job![2] === '取り込') return this.#adopt(tenantId, userId, row);
    return this.#revert(tenantId, row);
  }

  async #job(tenantId: string, userId: string, number: number): Promise<ImproveRow | undefined> {
    return withTenant(this.deps.db, tenantId, (tx) =>
      tx
        .selectFrom('agent_jobs')
        .select([
          'id',
          'number',
          'title',
          'status',
          'project_root',
          'improve_branch',
          'improve_base_branch',
          'improve_base_sha',
          'improve_commit',
        ])
        .where('user_id', '=', userId)
        .where('number', '=', number)
        .executeTakeFirst(),
    );
  }

  /** 改善は同時に 1 つだけ（取り込みがぶつからないように）。 */
  async #begin(tenantId: string, userId: string, text: string): Promise<string> {
    const open = await withTenant(this.deps.db, tenantId, (tx) =>
      tx
        .selectFrom('agent_jobs')
        .select('number')
        .where('user_id', '=', userId)
        .where('improve_branch', 'is not', null)
        .where('status', 'not in', ['done', 'cancelled'])
        .executeTakeFirst(),
    );
    if (open)
      return `Genie の改善は 1 つずつ進めます。先に仕事 ${String(open.number)} を取り込むか取り消してください。`;
    const run = this.#prepare(tenantId, userId, text).finally(() => this.#runs.delete(run));
    this.#runs.add(run);
    return 'Genie の改善の準備を始めます。本体とは別の作業コピーで進め、取り込む前に確認をお願いします。';
  }

  async #prepare(tenantId: string, userId: string, text: string): Promise<void> {
    const repo = this.deps.repoRoot!;
    const slug = uuidv7();
    const branch = `genie-improve/${slug}`;
    const path = join(this.deps.worktreesDir ?? join(homedir(), '.genie', 'improve'), slug);
    let added = false;
    try {
      const baseBranch = await this.#git(repo, 'symbolic-ref', '--quiet', '--short', 'HEAD');
      const baseSha = await this.#git(repo, 'rev-parse', 'HEAD');
      await this.#git(repo, 'worktree', 'add', '-b', branch, path, baseSha);
      added = true;
      await (this.deps.run ?? runTool)(path, 'pnpm', ['install', '--frozen-lockfile', '--offline']);
      const job = await this.deps.jobs.create({
        tenantId,
        userId,
        agent: 'claude_code',
        projectRoot: path,
        projectName: 'Genie の改善',
        request: requestFor(text),
        title: titleOf(text),
        criteria: this.#criteria(baseSha),
        maxMinutes: 60,
        maxTurns: 80,
        maxCostUsd: 3,
        improve: { branch, baseBranch, baseSha },
      });
      await this.deps.notify?.(
        tenantId,
        userId,
        `仕事 ${String(job.number)} として Genie の改善を始めました。元のコミットは ${baseSha.slice(0, 8)} です（未コミットの変更は含みません）。`,
      );
      await this.deps.jobs.tick();
    } catch (error) {
      this.deps.log?.('improve.prepare_failed', { error: String(error).slice(0, 300) });
      if (added) {
        await this.#git(repo, 'worktree', 'remove', '--force', path).catch(() => '');
        await this.#git(repo, 'branch', '-D', branch).catch(() => '');
      }
      await this.deps.notify?.(
        tenantId,
        userId,
        error instanceof JobRefused
          ? `Genie の改善を始められません: ${error.message}`
          : 'Genie の改善の準備に失敗しました。Mac で git の状態と pnpm を確かめてください。',
      );
    }
  }

  /** 作業コピーの変更を全部ステージして、元のコミットとの差を見る。 */
  async #staged(row: ImproveRow, ...args: string[]): Promise<string> {
    await this.#git(row.project_root, 'add', '-A');
    return this.#git(row.project_root, 'diff', '--cached', ...args, row.improve_base_sha!);
  }

  async #changes(row: ImproveRow): Promise<string> {
    if (row.improve_commit)
      return `仕事 ${String(row.number)} は取り込み済みです（${row.improve_commit.slice(0, 8)}）。`;
    if (row.status === 'cancelled') return `仕事 ${String(row.number)} は取り消しました。`;
    if (row.status === 'running' || row.status === 'verifying')
      return `仕事 ${String(row.number)} はまだ進めているところです。`;
    const stat = await this.#staged(row, '--stat=60');
    if (!stat) return `仕事 ${String(row.number)} に変更はありません。`;
    const warned = protectedChanges(await this.#staged(row, '--name-status'));
    return [
      `仕事 ${String(row.number)} の変更:`,
      stat.length > STAT_LIMIT ? `${stat.slice(0, STAT_LIMIT)}…` : stat,
      ...(warned.length
        ? [`検査やゲートに触れています（LINE からは取り込めません）: ${warned.join('、')}`]
        : []),
      `入れるなら「仕事 ${String(row.number)} を取り込む」、直すなら「仕事 ${String(row.number)} に指示: …」と送ってください。`,
    ].join('\n');
  }

  async #adopt(tenantId: string, userId: string, row: ImproveRow): Promise<string> {
    const n = String(row.number);
    if (row.status !== 'needs_review')
      return `仕事 ${n} は取り込める状態ではありません（自動の確かめが終わってから取り込めます）。`;
    const repo = this.deps.repoRoot!;
    const warned = protectedChanges(await this.#staged(row, '--name-status'));
    if (warned.length > 0)
      return `仕事 ${n} は検査やゲートに触れているので、LINE からは取り込みません。Mac で確かめてください: ${warned.join('、')}`;
    const current = await this.#git(repo, 'symbolic-ref', '--quiet', '--short', 'HEAD').catch(
      () => '',
    );
    if (current !== row.improve_base_branch)
      return `本体の枝が ${current || '不明'} に変わっているので取り込みません（元は ${row.improve_base_branch ?? '不明'}）。`;
    const staged = await this.#git(row.project_root, 'diff', '--cached', '--name-only');
    if (staged) await this.#git(row.project_root, 'commit', '-m', row.title);
    try {
      await this.#git(
        repo,
        'merge',
        '--no-ff',
        '--no-edit',
        '-m',
        `merge: ${row.title}（仕事 ${n}）`,
        row.improve_branch!,
      );
    } catch {
      // ぶつかったら本体を元のままに戻す（本人の未コミットの変更には触れない）
      await this.#git(repo, 'merge', '--abort').catch(() => '');
      return `仕事 ${n} は本体の変更とぶつかったので取り込みませんでした。本体は元のままです。`;
    }
    const commit = await this.#git(repo, 'rev-parse', 'HEAD');
    await withTenant(this.deps.db, tenantId, (tx) =>
      tx
        .updateTable('agent_jobs')
        .set({ improve_commit: commit })
        .where('id', '=', row.id)
        .execute(),
    );
    await this.deps.jobs.confirm(tenantId, userId, row.number, { adopted: true });
    await this.#git(repo, 'worktree', 'remove', '--force', row.project_root).catch(() => '');
    await this.#git(repo, 'branch', '-d', row.improve_branch!).catch(() => '');
    return [
      `仕事 ${n} を手元の ${row.improve_base_branch!} に取り込みました（${commit.slice(0, 8)}。push はしていません）。`,
      '型と gateway の検査は通っていますが、verify-all は通していません。',
      `動いている Genie には、Mac で再起動するまで反映されません。戻すなら「仕事 ${n} を戻す」と送ってください。`,
    ].join('\n');
  }

  async #revert(tenantId: string, row: ImproveRow): Promise<string> {
    const n = String(row.number);
    if (!row.improve_commit) return `仕事 ${n} はまだ取り込んでいません。`;
    const repo = this.deps.repoRoot!;
    try {
      await this.#git(repo, 'revert', '-m', '1', '--no-edit', row.improve_commit);
    } catch {
      await this.#git(repo, 'revert', '--abort').catch(() => '');
      return `仕事 ${n} は後の変更とぶつかるので戻せませんでした。本体は元のままです。`;
    }
    await withTenant(this.deps.db, tenantId, (tx) =>
      tx.updateTable('agent_jobs').set({ improve_commit: null }).where('id', '=', row.id).execute(),
    );
    return `仕事 ${n} の取り込みを戻しました。Mac で再起動すると反映されます。`;
  }

  async #decide(tenantId: string, userId: string, go: boolean): Promise<string> {
    const open = await withTenant(this.deps.db, tenantId, (tx) =>
      tx
        .selectFrom('genie_improvement_proposals')
        .select(['id', 'text'])
        .where('user_id', '=', userId)
        .where('status', '=', 'proposed')
        .orderBy('created_at', 'desc')
        .executeTakeFirst(),
    );
    if (!open) return '今、開いている改善の提案はありません。';
    const started = go
      ? await this.#begin(tenantId, userId, open.text)
      : '改善の提案を見送りました。';
    // 始められなかった（別の改善が途中）ときは、提案を開いたままにする
    if (go && !started.includes('準備を始めます')) return started;
    await withTenant(this.deps.db, tenantId, (tx) =>
      tx
        .updateTable('genie_improvement_proposals')
        .set({ status: go ? 'started' : 'dismissed', decided_at: this.#now() })
        .where('id', '=', open.id)
        .execute(),
    );
    return started;
  }

  /** 持ち主ごとに、最近の止まり方から提案を 1 つ作る。返すのは作った提案の数。 */
  async scan(): Promise<number> {
    if (!this.deps.repoRoot) return 0;
    const owners = await withIdentity(this.deps.db, (tx) =>
      tx
        .selectFrom('agent_connections')
        .select(['tenant_id', 'user_id'])
        .distinct()
        .where('source', '=', 'claude_code')
        .where('revoked_at', 'is', null)
        .execute(),
    );
    const now = this.#now();
    const week = Math.floor(now.getTime() / (7 * 24 * 3600_000));
    let made = 0;
    for (const owner of owners) {
      const text = await withTenant(this.deps.db, owner.tenant_id, async (tx) => {
        const open = await tx
          .selectFrom('genie_improvement_proposals')
          .select('id')
          .where('user_id', '=', owner.user_id)
          .where('status', '=', 'proposed')
          .executeTakeFirst();
        if (open) return null;
        const stops = await tx
          .selectFrom('agent_jobs')
          .select(['stop_reason', (eb) => eb.fn.countAll<string>().as('count')])
          .where('user_id', '=', owner.user_id)
          .where('control', '=', 'managed')
          // 改善の仕事自身の止まり方からは提案しない（提案が提案を呼ばないように）
          .where('improve_branch', 'is', null)
          .where('stop_reason', 'in', Object.keys(SIGNALS))
          .where('updated_at', '>=', new Date(now.getTime() - PROPOSAL_WINDOW_MS))
          .groupBy('stop_reason')
          .orderBy('count', 'desc')
          .execute();
        for (const stop of stops) {
          const count = Number(stop.count);
          if (count < PROPOSAL_MIN_STOPS) continue;
          const body = `この 7 日で、仕事が${SIGNALS[stop.stop_reason!]!}止まることが ${String(count)} 回ありました（${stop.stop_reason!}）。agent_jobs と agent_job_runs の記録と services/api-gateway/src/agent-jobs.ts から原因を調べ、Genie の側で直せるなら直してください。`;
          const inserted = await tx
            .insertInto('genie_improvement_proposals')
            .values({
              id: uuidv7(),
              tenant_id: owner.tenant_id,
              user_id: owner.user_id,
              signature: `stop:${stop.stop_reason!}:${String(week)}`,
              text: body,
            })
            .onConflict((oc) => oc.doNothing())
            .returning('id')
            .executeTakeFirst();
          if (inserted) return body;
        }
        return null;
      });
      if (!text) continue;
      made += 1;
      await this.deps
        .notify?.(
          owner.tenant_id,
          owner.user_id,
          `Genie の改善の提案です。\n${text}\n進めるなら「改善の提案を進めて」、見送るなら「改善の提案を見送る」と送ってください。`,
        )
        .catch(() => undefined);
    }
    return made;
  }
}
