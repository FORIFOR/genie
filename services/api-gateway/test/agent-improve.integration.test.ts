/**
 * Genie 自身の改善（src/agent-improve.ts）。本物の git と代役のエージェントで、作業コピー・取り込み・戻す・提案を見る。
 *   ./infra/db/with-test-db.sh pnpm --filter @genie/service-api-gateway test
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type TokenResponse, uuidv7 } from '@genie/contracts';
import { withTenant } from '@genie/db';
import { makeTestApp, makeTokens, testDbConfig, type TestApp } from './support.js';
import type { AgentAdapter, AgentRunRequest } from '../src/agent-adapters.js';
import { GenieImprover, protectedChanges } from '../src/agent-improve.js';
import { AgentJobs } from '../src/agent-jobs.js';
import { AgentSessionStore } from '../src/agent-sessions.js';

const url = process.env['TEST_DATABASE_URL'];
const identityUrl = process.env['TEST_IDENTITY_DATABASE_URL'];

describe('protectedChanges', () => {
  it('finds removed tests and gate scripts only', () => {
    expect(
      protectedChanges(
        [
          'M\tservices/a.ts',
          'D\tservices/b.test.ts',
          'M\tscripts/verify-all.sh',
          'M\tservices/c.test.ts',
          'D\tservices/d.ts',
        ].join('\n'),
      ),
    ).toEqual(['services/b.test.ts', 'scripts/verify-all.sh']);
  });

  it('notices a gate script renamed away', () => {
    expect(protectedChanges('R100\tscripts/memguard.py\tscripts/other.py')).toEqual([
      'scripts/memguard.py',
    ]);
  });
});

describe.skipIf(!url)('genie improver', () => {
  let harness: TestApp;
  let tenantId: string;
  let userId: string;
  let otherUserId: string;
  let repo: string;
  let dir: string;
  let told: string[];
  let work: (cwd: string) => void;
  let jobs: AgentJobs;
  let improver: GenieImprover;

  const git = (cwd: string, ...args: string[]) =>
    execFileSync('/usr/bin/git', args, { cwd, encoding: 'utf8' }).trim();

  const adapter: AgentAdapter = {
    agent: 'claude_code',
    label: 'Claude Code',
    runnable: true,
    reportsCost: true,
    available: async () => true,
    run: async (request: AgentRunRequest) => {
      work(request.cwd);
      return {
        outcome: 'success',
        sessionId: null,
        costUsd: 0.01,
        turns: 1,
        exitCode: 0,
        permissionDenied: false,
        note: null,
      };
    },
  };

  const say = (text: string, who = userId) => improver.command(tenantId, who, text);
  const lastNumber = async () => {
    const row = await withTenant(harness.db, tenantId, (tx) =>
      tx
        .selectFrom('agent_jobs')
        .select(['number', 'status', 'project_root', 'improve_branch', 'improve_commit'])
        .where('user_id', '=', userId)
        .orderBy('number', 'desc')
        .executeTakeFirstOrThrow(),
    );
    return row;
  };
  /** 頼んで、確かめが終わるまで進める。 */
  const improve = async (text = 'Genie を直して: 足し算を足す') => {
    const reply = await say(text);
    expect(reply).toContain('準備を始めます');
    await improver.settled();
    await jobs.tick();
    await jobs.settled();
    return lastNumber();
  };

  beforeAll(async () => {
    harness = await makeTestApp({
      dbConfig: testDbConfig(url!, identityUrl),
      tokens: await makeTokens(),
    });
    const issued = await harness.app.inject({
      method: 'POST',
      url: '/v1/auth/dev/token',
      payload: { email: `i-${uuidv7()}@example.com`, display_name: 'I' },
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
    await new AgentSessionStore(harness.db).ownConnection(tenantId, userId, 'claude_code', 'test');
    otherUserId = uuidv7();
  });

  afterAll(async () => {
    await harness?.close();
  });

  beforeEach(async () => {
    told = [];
    await withTenant(harness.db, tenantId, async (tx) => {
      await tx.deleteFrom('genie_improvement_proposals').where('user_id', '=', userId).execute();
      await tx.deleteFrom('agent_jobs').where('user_id', '=', userId).execute();
    });
    dir = mkdtempSync(join(tmpdir(), 'genie-improve-'));
    repo = join(dir, 'repo');
    execFileSync('/bin/mkdir', ['-p', join(repo, 'tests')]);
    git(repo, 'init', '-b', 'main');
    git(repo, 'config', 'user.email', 'test@example.test');
    git(repo, 'config', 'user.name', 'test');
    writeFileSync(join(repo, 'a.txt'), 'one\n');
    writeFileSync(join(repo, 'tests', 'a.test.ts'), 'test\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-m', 'init');
    work = (cwd) => writeFileSync(join(cwd, 'b.txt'), 'new\n');
    const notify = async (_t: string, _u: string, text: string) => {
      told.push(text);
    };
    jobs = new AgentJobs({
      db: harness.db,
      adapters: { claude_code: adapter },
      notify,
      onlyTenant: tenantId,
    });
    improver = new GenieImprover({
      db: harness.db,
      jobs,
      repoRoot: repo,
      worktreesDir: join(dir, 'worktrees'),
      notify,
      criteria: [
        { kind: 'command', text: '変更がある', spec: 'test -f b.txt -o ! -f tests/a.test.ts' },
        { kind: 'manual', text: '取り込むかを決める' },
      ],
      run: (cwd, file, args) =>
        file === 'pnpm'
          ? Promise.resolve('')
          : Promise.resolve(execFileSync(file, [...args], { cwd, encoding: 'utf8' })),
    });
  });

  it('works in a separate copy and leaves the repo alone until adopted', async () => {
    const job = await improve();
    expect(job.status).toBe('needs_review');
    expect(job.project_root).not.toBe(repo);
    expect(existsSync(join(job.project_root, 'b.txt'))).toBe(true);
    expect(existsSync(join(repo, 'b.txt'))).toBe(false);
    expect(told.join('\n')).toContain('を取り込む');
    const n = job.number;
    // 「確認した」では本体へ入らず、完了にもならない
    expect(await jobs.confirm(tenantId, userId, n)).toContain('を取り込む');
    expect((await lastNumber()).status).toBe('needs_review');
    expect(await say(`仕事 ${n} の変更`)).toContain('b.txt');

    const adopted = await say(`仕事 ${n} を取り込む`);
    expect(adopted).toContain('verify-all は通していません');
    expect(adopted).toContain('再起動');
    expect(readFileSync(join(repo, 'b.txt'), 'utf8')).toBe('new\n');
    const after = await lastNumber();
    expect(after.status).toBe('done');
    expect(after.improve_commit).toBe(git(repo, 'rev-parse', 'HEAD'));
    expect(existsSync(after.project_root)).toBe(false);

    expect(await say(`仕事 ${n} を戻す`)).toContain('戻しました');
    expect(existsSync(join(repo, 'b.txt'))).toBe(false);
  });

  it('refuses anyone but the owner of this Mac', async () => {
    expect(await say('Genie を直して: 何か', otherUserId)).toContain('持ち主だけ');
    await improver.settled();
    const rows = await withTenant(harness.db, tenantId, (tx) =>
      tx.selectFrom('agent_jobs').select('id').where('improve_branch', 'is not', null).execute(),
    );
    expect(rows).toHaveLength(0);
  });

  it('runs one improvement at a time', async () => {
    const job = await improve();
    expect(await say('Genie を直して: 別のこと')).toContain(`仕事 ${job.number}`);
  });

  it('does not adopt a change that removes a test', async () => {
    work = (cwd) => unlinkSync(join(cwd, 'tests', 'a.test.ts'));
    const job = await improve();
    expect(job.status).toBe('needs_review');
    expect(await say(`仕事 ${job.number} を取り込む`)).toContain('LINE からは取り込みません');
    expect(existsSync(join(repo, 'tests', 'a.test.ts'))).toBe(true);
    expect((await lastNumber()).status).toBe('needs_review');
  });

  it('leaves the repo as it was when the merge conflicts', async () => {
    work = (cwd) => {
      writeFileSync(join(cwd, 'a.txt'), 'theirs\n');
      writeFileSync(join(cwd, 'b.txt'), 'new\n');
    };
    const job = await improve();
    writeFileSync(join(repo, 'a.txt'), 'ours\n');
    git(repo, 'commit', '-am', 'moved on');
    const head = git(repo, 'rev-parse', 'HEAD');
    expect(await say(`仕事 ${job.number} を取り込む`)).toContain('ぶつかった');
    expect(git(repo, 'rev-parse', 'HEAD')).toBe(head);
    expect(git(repo, 'status', '--porcelain')).toBe('');
    expect((await lastNumber()).status).toBe('needs_review');
  });

  it("keeps the user's uncommitted work and refuses a moved branch", async () => {
    const job = await improve();
    git(repo, 'switch', '-c', 'other');
    expect(await say(`仕事 ${job.number} を取り込む`)).toContain('枝');
    git(repo, 'switch', 'main');
    writeFileSync(join(repo, 'a.txt'), 'uncommitted\n');
    await say(`仕事 ${job.number} を取り込む`);
    expect(readFileSync(join(repo, 'a.txt'), 'utf8')).toBe('uncommitted\n');
  });

  it('proposes from repeated stops but starts only when asked', async () => {
    const stop = async () => {
      const made = await jobs.create({
        tenantId,
        userId,
        agent: 'claude_code',
        projectRoot: repo,
        request: 'x',
        criteria: [{ kind: 'manual', text: 'x' }],
        after: [],
      });
      await withTenant(harness.db, tenantId, (tx) =>
        tx
          .updateTable('agent_jobs')
          .set({ status: 'stopped', stop_reason: 'same_failure' })
          .where('id', '=', made.id)
          .execute(),
      );
    };
    await stop();
    expect(await improver.scan()).toBe(0);
    await stop();
    expect(await improver.scan()).toBe(1);
    expect(told.join('\n')).toContain('改善の提案を進めて');
    // 開いている間は重ねない
    expect(await improver.scan()).toBe(0);
    const count = async () =>
      (
        await withTenant(harness.db, tenantId, (tx) =>
          tx
            .selectFrom('agent_jobs')
            .select('id')
            .where('improve_branch', 'is not', null)
            .execute(),
        )
      ).length;
    expect(await count()).toBe(0);
    expect(await say('改善の提案を進めて')).toContain('準備を始めます');
    await improver.settled();
    expect(await count()).toBe(1);
    // 同じ週に同じ理由では重ねない
    expect(await improver.scan()).toBe(0);
  });

  it('can dismiss a proposal, and ordinary jobs fall through', async () => {
    expect(await say('改善の提案を見送る')).toContain('ありません');
    expect(await say('今日の天気は')).toBeNull();
    expect(await say('仕事 999 を取り込む')).toBeNull();
  });

  afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });
});
