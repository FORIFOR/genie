/**
 * エージェントの仕事（src/agent-jobs.ts）。代役のエージェントで、列・確かめ・再試行・上限・保留・取り込みを見る。
 *   ./infra/db/with-test-db.sh pnpm --filter @genie/service-api-gateway test
 */
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type TokenResponse, uuidv7 } from '@genie/contracts';
import { withTenant } from '@genie/db';
import { makeTestApp, makeTokens, testDbConfig, type TestApp } from './support.js';
import type {
  AgentAdapter,
  AgentReviewRequest,
  AgentReviewResult,
  AgentRunRequest,
  AgentRunResult,
} from '../src/agent-adapters.js';
import { AgentJobs, JobRefused, type CheckResult } from '../src/agent-jobs.js';
import { AgentSessionStore } from '../src/agent-sessions.js';

const url = process.env['TEST_DATABASE_URL'];
const identityUrl = process.env['TEST_IDENTITY_DATABASE_URL'];

const ok = (over: Partial<AgentRunResult> = {}): AgentRunResult => ({
  outcome: 'success',
  sessionId: null,
  costUsd: 0.01,
  turns: 2,
  exitCode: 0,
  permissionDenied: false,
  note: null,
  ...over,
});

describe.skipIf(!url)('agent jobs', () => {
  let harness: TestApp;
  let tenantId: string;
  let userId: string;
  let root: string;
  let told: string[];
  let script: AgentRunResult[];
  let requests: AgentRunRequest[];
  let checks: CheckResult[];
  let hold: { release: () => void } | null;
  let notifyFails: boolean;

  const adapter = (reportsCost = true): AgentAdapter => ({
    agent: 'claude_code',
    label: 'Claude Code',
    runnable: true,
    reportsCost,
    available: async () => true,
    run: async (request) => {
      requests.push(request);
      if (hold) {
        await new Promise<void>((resolve) => {
          const current = hold!;
          const release = current.release;
          current.release = () => {
            release();
            resolve();
          };
          request.signal?.addEventListener('abort', () => resolve());
        });
      }
      return script.shift() ?? ok();
    },
  });

  const make = (over: Partial<ConstructorParameters<typeof AgentJobs>[0]> = {}) =>
    new AgentJobs({
      db: harness.db,
      adapters: { claude_code: adapter() },
      notify: async (_t, _u, text) => {
        if (notifyFails) throw new Error('line down');
        told.push(text);
      },
      runCheck: async () => checks.shift() ?? { ok: true, output: '' },
      onlyTenant: tenantId,
      ...over,
    });

  const add = (jobs: AgentJobs, over: Partial<Parameters<AgentJobs['create']>[0]> = {}) =>
    jobs.create({
      tenantId,
      userId,
      agent: 'claude_code',
      projectRoot: root,
      request: 'テストを直す',
      criteria: [{ kind: 'command', text: 'テストが通る', spec: 'pnpm test' }],
      ...over,
    });

  const job = (number: number) =>
    withTenant(harness.db, tenantId, (tx) =>
      tx
        .selectFrom('agent_jobs')
        .selectAll()
        .where('user_id', '=', userId)
        .where('number', '=', number)
        .executeTakeFirstOrThrow(),
    );

  /** 列が進まなくなるまで回す。 */
  const drain = async (jobs: AgentJobs) => {
    for (let i = 0; i < 12; i += 1) {
      const started = await jobs.tick();
      await jobs.settled();
      if (started === 0) return;
    }
  };

  beforeAll(async () => {
    harness = await makeTestApp({
      dbConfig: testDbConfig(url!, identityUrl),
      tokens: await makeTokens(),
    });
    const issued = await harness.app.inject({
      method: 'POST',
      url: '/v1/auth/dev/token',
      payload: { email: `j-${uuidv7()}@example.com`, display_name: 'J' },
    });
    const access = issued.json<TokenResponse>().access_token;
    tenantId = (
      JSON.parse(Buffer.from(access.split('.')[1]!, 'base64url').toString()) as { tid: string }
    ).tid;
    userId = (
      await harness.app.inject({
        method: 'GET',
        url: '/v1/me',
        headers: { authorization: `Bearer ${access}` },
      })
    ).json<{ user: { id: string } }>().user.id;
  });
  afterAll(async () => {
    await harness?.close();
  });

  // 試験ごとに列を空にする（番号は 1 から）
  beforeEach(async () => {
    await withTenant(harness.db, tenantId, async (tx) => {
      await tx.deleteFrom('agent_sessions').where('user_id', '=', userId).execute();
      await tx.deleteFrom('agent_jobs').where('user_id', '=', userId).execute();
      await tx.deleteFrom('work_holds').where('user_id', '=', userId).execute();
      await tx.deleteFrom('user_notices').where('user_id', '=', userId).execute();
    });
    root = await mkdtemp(join(tmpdir(), 'agent-job-'));
    told = [];
    script = [];
    requests = [];
    checks = [];
    hold = null;
    notifyFails = false;
  });

  it('refuses work without completion criteria, outside artifacts and unknown dependencies', async () => {
    const jobs = make();
    await expect(add(jobs, { criteria: [] })).rejects.toBeInstanceOf(JobRefused);
    await expect(
      add(jobs, { criteria: [{ kind: 'artifact', text: 'x', spec: '../x' }] }),
    ).rejects.toBeInstanceOf(JobRefused);
    await expect(add(jobs, { after: [99] })).rejects.toBeInstanceOf(JobRefused);
    await expect(add(jobs, { projectRoot: '/no/such/folder' })).rejects.toBeInstanceOf(JobRefused);
    await expect(add(jobs, { agent: 'browser' })).rejects.toBeInstanceOf(JobRefused);
  });

  it('runs, verifies, and only then moves on to the next job', async () => {
    const jobs = make();
    const first = await add(jobs);
    await add(jobs, { request: '次の仕事', after: [first.number] });
    expect(await jobs.tick()).toBe(1);
    // 前の仕事が終わるまで、次は始めない
    expect((await job(2)).status).toBe('waiting_dependency');
    await jobs.settled();
    expect((await job(1)).status).toBe('done');
    await drain(jobs);
    expect((await job(2)).status).toBe('done');
    expect(requests.map((r) => r.prompt.split('\n')[0])).toEqual(['テストを直す', '次の仕事']);
    expect(requests[0]!.prompt).toContain('完了条件');
    // 判断が要らない途中の完了は黙っている。列が空になったら 1 回だけ
    expect(told).toHaveLength(1);
    expect(told[0]).toContain('すべて終わりました');
    const runs = await withTenant(harness.db, tenantId, (tx) =>
      tx
        .selectFrom('agent_job_runs')
        .select(['outcome', 'kind', 'cost_usd'])
        .where('job_id', '=', first.id)
        .execute(),
    );
    expect(runs).toEqual([{ outcome: 'success', kind: 'work', cost_usd: '0.0100' }]);
  });

  it('does not take the agent at its word: a failed check sends it back to fix, in the same session', async () => {
    const jobs = make();
    await add(jobs);
    script = [ok({ sessionId: 'sess-1' }), ok({ sessionId: 'sess-1' })];
    checks = [
      { ok: false, output: 'AssertionError: 1 != 2 token=sk-ant-api03-abcdefghijklmnop' },
      { ok: true, output: '' },
    ];
    await drain(jobs);
    expect((await job(1)).status).toBe('done');
    expect(requests).toHaveLength(2);
    expect(requests[1]!.resumeSessionId).toBe('sess-1');
    expect(requests[1]!.prompt).toContain('AssertionError');
    expect(requests[1]!.prompt).not.toContain('sk-ant');
    // 本人を呼ばずに直した
    expect(told.every((t) => t.includes('すべて終わりました'))).toBe(true);
    const stored = JSON.stringify(await job(1));
    expect(stored).not.toContain('AssertionError');
  });

  it('stops when the same failure happens twice', async () => {
    const jobs = make();
    await add(jobs);
    checks = [
      { ok: false, output: 'same error at 10:01 in 12ms' },
      { ok: false, output: 'same error at 10:07 in 40ms' },
    ];
    await drain(jobs);
    const row = await job(1);
    expect(row).toMatchObject({ status: 'stopped', stop_reason: 'same_failure', attempts: 2 });
    expect(told).toHaveLength(1);
    expect(told[0]).toContain('同じ失敗が続きました');
    // 本人の言葉がなければ動かない
    expect(await jobs.tick()).toBe(0);
  });

  it('stops after three attempts with different failures', async () => {
    const jobs = make();
    await add(jobs);
    checks = ['a', 'b', 'c'].map((output) => ({ ok: false, output }));
    await drain(jobs);
    expect(await job(1)).toMatchObject({
      status: 'stopped',
      stop_reason: 'limit_attempts',
      attempts: 3,
    });
    expect(requests).toHaveLength(3);
  });

  it('waits and retries passing trouble, within the attempt limit', async () => {
    let clock = Date.now();
    const jobs = make({ now: () => new Date(clock) });
    await add(jobs);
    script = [ok({ outcome: 'transient', costUsd: null, turns: null, note: '混雑' })];
    await drain(jobs);
    const row = await job(1);
    expect(row.status).toBe('queued');
    expect(new Date(row.next_run_at!).getTime()).toBeGreaterThan(clock);
    // 時間が来るまで始めない
    expect(await jobs.tick()).toBe(0);
    clock += 61_000;
    await drain(jobs);
    expect((await job(1)).status).toBe('done');
    // 動かなかった実行のセッションには戻らない
    expect(requests[1]!.resumeSessionId).toBeNull();
  });

  it('stops at the turn, time and cost limits and at the daily budget', async () => {
    const jobs = make({ dailyBudgetUsd: 1 });
    await add(jobs);
    script = [ok({ outcome: 'limit_turns', note: '手数' })];
    await drain(jobs);
    expect(await job(1)).toMatchObject({ status: 'stopped', stop_reason: 'limit_turns' });

    await add(jobs);
    script = [ok({ outcome: 'limit_time', costUsd: null })];
    await drain(jobs);
    expect(await job(2)).toMatchObject({
      status: 'stopped',
      stop_reason: 'limit_time',
      cost_known: false,
    });

    // 費用の上限を使い切った仕事は、確かめで落ちても次を始めない
    await add(jobs, { maxCostUsd: 0.5 });
    script = [ok({ costUsd: 0.6 })];
    checks = [{ ok: false, output: 'x' }];
    await drain(jobs);
    expect(await job(3)).toMatchObject({ status: 'stopped', stop_reason: 'limit_cost' });
    expect(await jobs.resume(tenantId, userId, 3)).toContain('費用の上限');

    // 1 日の上限（取れた費用だけを数える）
    await add(jobs);
    script = [ok({ costUsd: 0.5 })];
    await drain(jobs);
    expect((await job(4)).status).toBe('done');
    await add(jobs);
    await drain(jobs);
    expect(await job(5)).toMatchObject({ status: 'stopped', stop_reason: 'daily_budget' });
  });

  it('uses time and attempts when an agent cannot report its cost', async () => {
    const jobs = make({ adapters: { claude_code: adapter(false) } });
    await add(jobs, { maxCostUsd: 0.01 });
    script = [ok({ costUsd: null }), ok({ costUsd: null })];
    checks = [
      { ok: false, output: 'x' },
      { ok: true, output: '' },
    ];
    await drain(jobs);
    // 費用が分からないので費用の上限では止めず、推した値も入れない
    expect(await job(1)).toMatchObject({ status: 'done', cost_known: false, cost_usd: '0.0000' });
    expect(await jobs.detail(tenantId, userId, 1)).toContain('費用の取れない実行あり');
  });

  it('never restarts held work on its own', async () => {
    const jobs = make();
    await add(jobs);
    expect(await jobs.command(tenantId, userId, '仕事 1 を保留')).toContain('保留にしました');
    await drain(jobs);
    expect(requests).toHaveLength(0);
    expect((await job(1)).status).toBe('held');
    expect(await jobs.command(tenantId, userId, '仕事1を再開')).toContain('再開します');
    await jobs.settled();
    await drain(jobs);
    expect((await job(1)).status).toBe('done');
  });

  it('holding a running job stops it and keeps it held', async () => {
    const jobs = make();
    await add(jobs);
    hold = { release: () => undefined };
    await jobs.tick();
    await expect.poll(() => requests.length).toBe(1);
    await jobs.hold(tenantId, userId, 1);
    script = [ok({ outcome: 'crashed' })];
    await jobs.settled();
    expect((await job(1)).status).toBe('held');
    expect(await jobs.tick()).toBe(0);
  });

  it('respects the holds the user already made (work_holds)', async () => {
    const jobs = make();
    await withTenant(harness.db, tenantId, (tx) =>
      tx
        .insertInto('work_holds')
        .values({ id: uuidv7(), tenant_id: tenantId, user_id: userId, subject: 'テストを直す' })
        .execute(),
    );
    await add(jobs);
    await drain(jobs);
    expect(requests).toHaveLength(0);
    expect((await job(1)).status).toBe('held');
  });

  it('asks the user when an approval was refused and the work could not finish', async () => {
    const jobs = make();
    await add(jobs);
    script = [ok({ permissionDenied: true })];
    checks = [{ ok: false, output: 'x' }];
    await drain(jobs);
    expect((await job(1)).status).toBe('waiting_human');
    expect(requests).toHaveLength(1);
    expect(told[0]).toContain('承認が得られなかった');
    await jobs.command(tenantId, userId, '仕事 1 を再開');
    await jobs.settled();
    expect((await job(1)).status).toBe('done');
  });

  describe('review by a second agent', () => {
    const BASE = 'a'.repeat(40);
    let reviews: AgentReviewRequest[];
    let verdicts: AgentReviewResult[];
    const said = (
      text: string | null,
      over: Partial<AgentReviewResult> = {},
    ): AgentReviewResult => ({
      outcome: 'success',
      text,
      // Codex は費用を返さない
      costUsd: null,
      turns: 3,
      note: null,
      ...over,
    });
    const reviewer = (): AgentAdapter => ({
      agent: 'codex',
      label: 'Codex',
      runnable: true,
      reportsCost: false,
      available: async () => true,
      run: async () => ok(),
      review: async (request) => {
        reviews.push(request);
        return verdicts.shift() ?? said('VERDICT: PASS');
      },
    });
    const withReview = () =>
      make({
        adapters: { claude_code: adapter(), codex: reviewer() },
        headOf: async () => BASE,
      });
    const criteria = [
      { kind: 'command' as const, text: 'テストが通る', spec: 'pnpm test' },
      { kind: 'agent_review' as const, text: 'Codex のレビューに通る', spec: 'codex' },
    ];

    beforeEach(() => {
      reviews = [];
      verdicts = [];
    });

    it('sends the findings back to the implementer, and finishes only after the review passes', async () => {
      const jobs = withReview();
      await add(jobs, { criteria });
      script = [ok({ sessionId: 'impl-1' }), ok({ sessionId: 'impl-1' })];
      verdicts = [
        said(
          '- src/a.ts:3 期限切れのトークンを通している token=sk-ant-api03-abcdefghijklmnop\nVERDICT: FAIL',
        ),
        said('直っている\nVERDICT: PASS'),
      ];
      await drain(jobs);
      expect((await job(1)).status).toBe('done');
      expect(reviews).toHaveLength(2);
      // 読むだけのレビューに、依頼・起点からの差分の見方・判定の書き方を渡す
      expect(reviews[0]!.prompt).toContain('テストを直す');
      expect(reviews[0]!.prompt).toContain(`git diff ${BASE}`);
      expect(reviews[0]!.prompt).toContain('VERDICT: PASS');
      // 指摘は同じセッションの実装担当へ（秘密の値は伏せる）
      expect(requests).toHaveLength(2);
      expect(requests[1]!.resumeSessionId).toBe('impl-1');
      expect(requests[1]!.prompt).toContain('期限切れのトークン');
      expect(requests[1]!.prompt).not.toContain('sk-ant');
      // 指摘の本文は DB に残さない。実行の履歴に review として残る
      const stored = await job(1);
      expect(stored.base_sha).toBe(BASE);
      expect(JSON.stringify(stored)).not.toContain('期限切れ');
      const runs = await withTenant(harness.db, tenantId, (tx) =>
        tx
          .selectFrom('agent_job_runs')
          .select(['kind', 'outcome', 'note'])
          .where('job_id', '=', stored.id)
          .orderBy('started_at')
          .execute(),
      );
      expect(runs.map((r) => r.kind)).toEqual(['work', 'review', 'fix', 'review']);
      expect(runs.map((r) => r.note).join('|')).not.toContain('期限切れ');
      // 費用の取れないレビュー担当を混ぜたので、合計は「分かっている分だけ」
      expect(stored.cost_known).toBe(false);
    });

    it('does not ask for a review while the checks still fail', async () => {
      const jobs = withReview();
      await add(jobs, { criteria });
      checks = [
        { ok: false, output: 'FAIL a' },
        { ok: true, output: '' },
      ];
      await drain(jobs);
      expect((await job(1)).status).toBe('done');
      expect(requests).toHaveLength(2);
      expect(reviews).toHaveLength(1);
    });

    it('stops and tells the user when the reviewer gives no verdict, instead of passing the work', async () => {
      const jobs = withReview();
      await add(jobs, { criteria });
      verdicts = [said('たぶん大丈夫です')];
      await drain(jobs);
      const stopped = await job(1);
      expect(stopped.status).toBe('stopped');
      expect(stopped.stop_reason).toBe('review_unavailable');
      expect(requests).toHaveLength(1);
      expect(told.join('\n')).toContain('レビュー担当が判定を返せませんでした');
    });

    it('stops when the same review failure comes back, like any other failure', async () => {
      const jobs = withReview();
      await add(jobs, { criteria });
      verdicts = [
        said('- a.ts:1 同じ問題\nVERDICT: FAIL'),
        said('- a.ts:1 同じ問題\nVERDICT: FAIL'),
      ];
      await drain(jobs);
      expect((await job(1)).stop_reason).toBe('same_failure');
      expect(reviews).toHaveLength(2);
    });

    it('refuses a reviewer Genie cannot ask', async () => {
      const jobs = make({ headOf: async () => BASE });
      await expect(
        add(jobs, { criteria: [{ kind: 'agent_review', text: 'x', spec: 'codex' }] }),
      ).rejects.toBeInstanceOf(JobRefused);
      await expect(
        add(withReview(), { criteria: [{ kind: 'agent_review', text: 'x', spec: 'browser' }] }),
      ).rejects.toBeInstanceOf(JobRefused);
    });
  });

  it('checks artifacts and waits for the user on review criteria; instructions go to the next run', async () => {
    const jobs = make();
    await add(jobs, {
      criteria: [
        { kind: 'artifact', text: '報告書', spec: 'report.md' },
        { kind: 'manual', text: '内容を確認する' },
      ],
    });
    script = [ok({ sessionId: 's1' }), ok({ sessionId: 's1' })];
    await drain(jobs);
    // 成果物が無いので直しに戻る → それでも無いので同じ失敗で止まる
    expect(await job(1)).toMatchObject({ status: 'stopped', stop_reason: 'same_failure' });

    await writeFile(join(root, 'report.md'), 'ok');
    await jobs.command(tenantId, userId, '仕事 1 を再開');
    await jobs.settled();
    await drain(jobs);
    expect((await job(1)).status).toBe('needs_review');
    const asked = told.at(-1)!;
    expect(asked).toContain('内容を確認する');
    expect(asked).toContain('report.md');

    // 確認の前に直しを頼める
    expect(await jobs.command(tenantId, userId, '仕事 1 に指示: 表を足して')).toContain('再開');
    await jobs.settled();
    await drain(jobs);
    expect(requests.at(-1)!.prompt).toContain('表を足して');
    expect((await job(1)).status).toBe('needs_review');

    expect(await jobs.command(tenantId, userId, '仕事 1 を確認した')).toContain('完了');
    expect((await job(1)).status).toBe('done');
    expect(await jobs.detail(tenantId, userId, 1)).toContain('✓ 内容を確認する');
  });

  it('puts work back in the queue after a restart, and counts the attempt', async () => {
    const jobs = make();
    await add(jobs);
    await withTenant(harness.db, tenantId, (tx) =>
      tx
        .updateTable('agent_jobs')
        .set({ status: 'running', attempts: 1 })
        .where('user_id', '=', userId)
        .execute(),
    );
    const restarted = make();
    expect(await restarted.recover()).toBeGreaterThanOrEqual(1);
    expect(await job(1)).toMatchObject({ status: 'queued', attempts: 1 });
    await drain(restarted);
    expect(await job(1)).toMatchObject({ status: 'done', attempts: 2 });
  });

  describe('waiting for the user is not a failure', () => {
    /** 代役のエージェントが許可を待っている状態にする。 */
    const running = async (jobs: AgentJobs) => {
      hold = { release: () => undefined };
      await jobs.tick();
      await expect.poll(() => requests.length).toBeGreaterThan(0);
      return requests.at(-1)!.sessionId;
    };
    const asked = { operation: 'ファイルの変更', summary: 'add.js', reason: 'expired' as const };

    it('does not count the wait for an approval against the running time', async () => {
      let clock = Date.now();
      const jobs = make({ now: () => new Date(clock) });
      await add(jobs, { maxMinutes: 15 });
      const session = await running(jobs);
      jobs.humanWait.started(tenantId, userId, session);
      clock += 20 * 60_000;
      expect(requests[0]!.clock.pausedMs).toBe(20 * 60_000);
      jobs.humanWait.answered(tenantId, userId, session);
      clock += 60_000;
      hold!.release();
      await jobs.settled();
      expect(await job(1)).toMatchObject({
        status: 'done',
        elapsed_ms: '60000',
        human_wait_ms: '1200000',
      });
    });

    it('stops the agent when the card expires, tells once, and continues the same session later', async () => {
      let clock = Date.now();
      const jobs = make({ now: () => new Date(clock) });
      await add(jobs);
      const session = await running(jobs);
      jobs.humanWait.started(tenantId, userId, session);
      clock += 9 * 60_000;
      await Promise.all([
        jobs.humanWait.unanswered(tenantId, userId, session, asked),
        jobs.humanWait.unanswered(tenantId, userId, session, asked),
      ]);
      // 別の方法を試させない
      expect(requests[0]!.signal!.aborted).toBe(true);
      await jobs.settled();
      const paused = await job(1);
      expect(paused).toMatchObject({
        status: 'waiting_human',
        pending_approval: 'ファイルの変更: add.js',
      });
      expect(told).toHaveLength(1);
      expect(told[0]).toContain('安全に一時停止');
      expect(told[0]).toContain('仕事 1 を再開');
      // 何日たっても勝手に動かない・失敗にもしない
      clock += 48 * 3600_000;
      expect(await jobs.tick()).toBe(0);
      expect((await job(1)).status).toBe('waiting_human');

      // Genie を再起動しても待ちは残り、再開できる
      hold = null;
      const restarted = make({ now: () => new Date(clock) });
      expect(await restarted.recover()).toBe(0);
      expect(await restarted.command(tenantId, userId, '今どうなってる？')).toContain('確認待ち');
      expect(await restarted.command(tenantId, userId, '仕事 1 を再開')).toContain('再開します');
      await restarted.settled();
      expect(requests[1]!.resumeSessionId).toBe(session);
      expect(requests[1]!.prompt).toContain('ファイルの変更: add.js');
      expect(requests[1]!.prompt).toContain('改めて本人に聞きます');
      const done = await job(1);
      // 待っただけなので回数に数えない。待った時間は残る
      expect(done).toMatchObject({ status: 'done', attempts: 1, pending_approval: null });
      expect(Number(done.human_wait_ms)).toBeGreaterThanOrEqual(48 * 3600_000);
    });

    it('does nothing for sessions Genie did not start', async () => {
      const jobs = make();
      await jobs.humanWait.unanswered(tenantId, userId, 'someone-elses', asked);
      expect(told).toHaveLength(0);
    });

    it('keeps the remaining budget when resuming after a wait', async () => {
      const jobs = make();
      await add(jobs, { maxMinutes: 15 });
      const session = await running(jobs);
      await withTenant(harness.db, tenantId, (tx) =>
        tx
          .updateTable('agent_jobs')
          .set({ elapsed_ms: 600_000 })
          .where('user_id', '=', userId)
          .execute(),
      );
      await jobs.humanWait.unanswered(tenantId, userId, session, asked);
      await jobs.settled();
      hold = null;
      await jobs.command(tenantId, userId, '仕事 1 を再開');
      await jobs.settled();
      expect(Number((await job(1)).elapsed_ms)).toBeGreaterThanOrEqual(600_000);
    });

    it('keeps dependent work waiting, then starts it when the earlier job really finishes', async () => {
      const jobs = make();
      await add(jobs);
      await add(jobs, { request: '次の仕事', after: [1] });
      expect((await job(2)).status).toBe('waiting_dependency');
      script = [ok({ outcome: 'limit_time' })];
      await drain(jobs);
      expect(await job(1)).toMatchObject({ status: 'stopped', stop_reason: 'limit_time' });
      await drain(jobs);
      expect(await job(2)).toMatchObject({ status: 'waiting_dependency', stop_reason: null });
      expect(await jobs.command(tenantId, userId, '仕事 2 を再開')).toContain(
        '先の仕事を待っています',
      );
      expect(await jobs.summary(tenantId, userId)).toContain('先の仕事待ち');
      // 保留でも待つ
      await jobs.hold(tenantId, userId, 1);
      await drain(jobs);
      expect((await job(2)).status).toBe('waiting_dependency');
      await jobs.command(tenantId, userId, '仕事 1 を再開');
      await jobs.settled();
      await drain(jobs);
      expect((await job(1)).status).toBe('done');
      expect((await job(2)).status).toBe('done');
      expect(requests.at(-1)!.prompt).toContain('次の仕事');
    });

    it('tells the user when the earlier job was cancelled, since it can never finish', async () => {
      const jobs = make();
      await add(jobs);
      await add(jobs, { after: [1] });
      await jobs.cancel(tenantId, userId, 1);
      await drain(jobs);
      expect(await job(2)).toMatchObject({
        status: 'stopped',
        stop_reason: 'dependency_cancelled',
      });
    });

    it('ends resumability at the task lifetime, not at the card', async () => {
      let clock = Date.now();
      const jobs = make({ now: () => new Date(clock) });
      await add(jobs, { maxLifetimeHours: 24 });
      const session = await running(jobs);
      await jobs.humanWait.unanswered(tenantId, userId, session, asked);
      await jobs.settled();
      hold = null;
      clock += 25 * 3600_000;
      await jobs.command(tenantId, userId, '仕事 1 を再開');
      expect(await job(1)).toMatchObject({ status: 'stopped', stop_reason: 'lifetime' });
      expect(await jobs.resume(tenantId, userId, 1)).toContain('期間を過ぎました');
    });
  });

  it('keeps going when the chat is down', async () => {
    const jobs = make();
    notifyFails = true;
    await add(jobs);
    checks = [
      { ok: false, output: 'x' },
      { ok: false, output: 'x' },
    ];
    await drain(jobs);
    expect((await job(1)).status).toBe('stopped');
    // 届かなくても Mac の通知には残る
    const notices = await withTenant(harness.db, tenantId, (tx) =>
      tx
        .selectFrom('user_notices')
        .select('title')
        .where('user_id', '=', userId)
        .where('kind', '=', 'agent_job')
        .execute(),
    );
    expect(notices.map((n) => n.title)).toEqual(['仕事 1 を止めました']);
  });

  describe('sessions the user started directly', () => {
    const connect = () =>
      new AgentSessionStore(harness.db).ownConnection(tenantId, userId, 'claude_code', 'test');

    it('takes them in once, read-only, and follows their state', async () => {
      const jobs = make({
        projectOf: async () => ({ root: '/Users/taro/genie', name: 'genie', branch: 'main' }),
      });
      const store = new AgentSessionStore(harness.db);
      const connection = await connect();
      const cwd = '/Users/taro/genie/services';
      const see = async (e: Parameters<AgentSessionStore['record']>[1]) =>
        jobs.observe(tenantId, userId, await store.record(connection, e), cwd);
      await see({ event: 'SessionStart', sessionId: 'mine', cwd });
      // 同時に届いても 1 件だけ
      const session = await store.record(connection, {
        event: 'UserPromptSubmit',
        sessionId: 'mine',
        cwd,
        prompt: '請求画面を直す',
      });
      await Promise.all([
        jobs.observe(tenantId, userId, session, cwd),
        jobs.observe(tenantId, userId, session, cwd),
      ]);
      const rows = await jobs.list(tenantId, userId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        control: 'observed',
        status: 'running',
        project: 'genie',
        title: '請求画面を直す',
        project_root: '/Users/taro/genie',
      });

      await see({ event: 'PermissionRequest', sessionId: 'mine', cwd });
      expect((await job(1)).status).toBe('waiting_user');
      await see({ event: 'Stop', sessionId: 'mine', cwd });
      expect((await job(1)).status).toBe('idle');

      // 読むだけ: Genie からは動かさない。列にも乗らない
      for (const command of [
        '仕事 1 を保留',
        '仕事 1 を再開',
        '仕事 1 に指示: 直して',
        '仕事 1 を取り消して',
      ])
        expect(await jobs.command(tenantId, userId, command)).toContain('Genie からは操作しません');
      expect(await jobs.tick()).toBe(0);
      expect(requests).toHaveLength(0);

      await see({ event: 'SessionEnd', sessionId: 'mine', cwd });
      expect((await job(1)).status).toBe('ended');
    });

    it('does not take in sessions that have already ended', async () => {
      const jobs = make();
      const store = new AgentSessionStore(harness.db);
      const session = await store.record(await connect(), {
        event: 'SessionEnd',
        sessionId: 'old',
      });
      await jobs.observe(tenantId, userId, session, undefined);
      expect(await jobs.list(tenantId, userId)).toHaveLength(0);
    });

    it('links the sessions Genie started to their job, and several sessions can share one job', async () => {
      const jobs = make();
      const store = new AgentSessionStore(harness.db);
      const connection = await connect();
      await add(jobs);
      script = [ok({ outcome: 'crashed', turns: null, costUsd: null }), ok()];
      await jobs.tick();
      await expect.poll(() => requests.length).toBe(1);
      const firstId = requests[0]!.sessionId;
      await jobs.observe(
        tenantId,
        userId,
        await store.record(connection, { event: 'SessionStart', sessionId: firstId }),
        undefined,
      );
      await jobs.settled();
      expect(await jobs.jobLabel(tenantId, userId, firstId)).toBe('仕事 1「テストを直す」');
      // 動かなかったので新しいセッションでやり直す
      await withTenant(harness.db, tenantId, (tx) =>
        tx
          .updateTable('agent_jobs')
          .set({ next_run_at: null })
          .where('user_id', '=', userId)
          .execute(),
      );
      await drain(jobs);
      const secondId = requests[1]!.sessionId;
      expect(secondId).not.toBe(firstId);
      await jobs.observe(
        tenantId,
        userId,
        await store.record(connection, { event: 'SessionStart', sessionId: secondId }),
        undefined,
      );
      const list = await jobs.list(tenantId, userId);
      expect(list).toHaveLength(1);
      expect(await jobs.detail(tenantId, userId, 1)).toContain('セッション: 2 件');
    });

    it('answers 今どうなってる by project, and stays out of the way when there is nothing', async () => {
      const jobs = make({
        projectOf: async (cwd) => ({ root: cwd, name: cwd.split('/').pop()!, branch: null }),
      });
      expect(await jobs.command(tenantId, userId, '今どうなってる？')).toBeNull();
      const store = new AgentSessionStore(harness.db);
      const connection = await connect();
      await add(jobs, { title: '直す仕事', criteria: [{ kind: 'manual', text: '見る' }] });
      await add(jobs, { title: '保留の仕事' });
      await jobs.hold(tenantId, userId, 2);
      await drain(jobs);
      const session = await store.record(connection, {
        event: 'UserPromptSubmit',
        sessionId: 'x',
        cwd: '/w/other',
        prompt: '別の作業',
      });
      await jobs.observe(tenantId, userId, session, '/w/other');
      const said = (await jobs.command(tenantId, userId, '今どうなってる？'))!;
      expect(said).toContain('確認待ち:\n・仕事 1「直す仕事」（Claude Code）');
      expect(said).toContain('保留中:\n・仕事 2「保留の仕事」');
      expect(said).toContain('■ other\n進行中:\n・仕事 3「別の作業」（Claude Code・見守りのみ）');
      // 関係のない文は会話へ
      expect(await jobs.command(tenantId, userId, '明日の天気は？')).toBeNull();
    });
  });
});
