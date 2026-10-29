/**
 * 仕事の台帳（work-ledger.ts）を DB で。
 *
 * 見ること:
 *   - Claude Code の出来事が、種類と時刻だけの印として残る（頼みの文・コマンドは残らない）
 *   - 「genie の完了条件は〜」で条件を覚え、テストの条件はテストの結果で、ほかは本人の「確かめた」で満たす
 *   - 「genie はどこまで進んだ？」に台帳で答え、頼みの頭を出さない
 *   - Genie の仕事にも完了条件を付けられ、GET /v1/work/ledger?task= で台帳が読める
 *   - ほかの人のセッション・仕事の台帳は読めない（404）
 *   ./infra/db/with-test-db.sh pnpm --filter @genie/service-api-gateway test
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type TokenResponse, uuidv7 } from '@genie/contracts';
import { withTenant } from '@genie/db';
import { AgentSessionStore, type AgentConnection } from '../src/agent-sessions.js';
import { WorkDesk } from '../src/work-desk.js';
import { registerWorkDeskRoutes } from '../src/routes/work-desk.js';
import type { Ledger } from '../src/work-ledger.js';
import { makeTestApp, makeTokens, testDbConfig, type TestApp } from './support.js';

const url = process.env['TEST_DATABASE_URL'];
const identityUrl = process.env['TEST_IDENTITY_DATABASE_URL'];
const TZ = 'Asia/Tokyo';

describe.skipIf(!url)('work ledger', () => {
  let harness: TestApp;
  let store: AgentSessionStore;
  let desk: WorkDesk;
  const deskRef: { current: WorkDesk | null } = { current: null };

  const signIn = async () => {
    const issued = await harness.app.inject({
      method: 'POST',
      url: '/v1/auth/dev/token',
      payload: { email: `l-${uuidv7()}@example.com`, display_name: 'L' },
    });
    const auth = { authorization: `Bearer ${issued.json<TokenResponse>().access_token}` };
    const key = await harness.app.inject({
      method: 'POST',
      url: '/v1/agent-connections',
      headers: auth,
      payload: { source: 'claude_code' },
    });
    const connection = (await store.identify(key.json<{ token: string }>().token))!;
    const conversation = await harness.app.inject({
      method: 'POST',
      url: '/v1/conversations',
      headers: auth,
      payload: {},
    });
    return { auth, connection, conversationId: conversation.json<{ id: string }>().id };
  };
  const principal = (c: AgentConnection) => ({ tenantId: c.tenantId, userId: c.userId });

  const ledger = async (auth: Record<string, string>, query: string) =>
    harness.app.inject({ method: 'GET', url: `/v1/work/ledger?${query}`, headers: auth });

  beforeAll(async () => {
    harness = await makeTestApp({
      dbConfig: testDbConfig(url!, identityUrl),
      tokens: await makeTokens(),
      configure: (app) => {
        registerWorkDeskRoutes(app, {
          get ledger() {
            return deskRef.current!.ledger;
          },
        } as unknown as WorkDesk);
      },
    });
    store = new AgentSessionStore(harness.db);
    desk = new WorkDesk({ db: harness.db, tasks: harness.tasks, library: harness.library, schedules: null, tz: TZ });
    deskRef.current = desk;
  });

  afterAll(async () => {
    await harness?.close();
  });

  it('keeps a content-free trail of a session and checks its criteria', async () => {
    const { auth, connection: c, conversationId } = await signIn();
    const project = `ledger-${uuidv7().slice(-6)}`;
    const record = (event: string, over: Record<string, string> = {}) =>
      store.record(c, { event, sessionId: 'l1', cwd: `/x/${project}`, ...over });
    await record('UserPromptSubmit', { prompt: '秘密の決済仕様を直して' });
    await record('PostToolUse', { toolName: 'Edit' });
    await record('PostToolUse', { toolName: 'Edit' });
    await record('PostToolUseFailure', { toolName: 'Bash', command: 'pnpm test --secret-flag' });
    await record('Stop');

    const said = await desk.command(
      principal(c),
      conversationId,
      `${project}の完了条件はテストが通ること、LINE に届くこと`,
    );
    expect(said).toBe(
      [
        `Claude Code（${project}）の完了条件を 2 つ覚えました。`,
        '・「テストが通る」… Claude Code のテストの結果で確かめます',
        `・「LINE に届く」… 自動では確かめられないので、確かめたら「${project}の完了条件は確かめた」と言ってください`,
        '満たすまでは「終わった」とは言いません。',
      ].join('\n'),
    );

    const [session] = await store.list(c.tenantId, c.userId);
    const first = await ledger(auth, `session=${session!.id}`);
    expect(first.statusCode).toBe(200);
    const l = first.json<Ledger>();
    // 印は種類だけ。2 回目の Edit は印にしない
    expect(l.timeline.map((e) => e.text)).toEqual([
      '頼まれました',
      'ファイルを変えました',
      'テストが失敗しました',
      '応答を終えました',
    ]);
    expect(l.criteria.map((x) => [x.text, x.state])).toEqual([
      ['テストが通る', 'unmet'],
      ['LINE に届く', 'unchecked'],
    ]);
    expect(l.next).toMatch(/^「テストが通る」を満たしていません/);
    // 頼みの文・コマンドはどこにも残っていない
    const marks = await withTenant(harness.db, c.tenantId, (tx) =>
      tx
        .selectFrom('agent_session_marks')
        .selectAll()
        .where('session_id', '=', session!.id)
        .execute(),
    );
    expect(JSON.stringify(marks)).not.toMatch(/決済|secret-flag/);

    // テストが通り、本人が残りを確かめたと言うと、すべて満たす
    await record('UserPromptSubmit', { prompt: '直して' });
    await record('PostToolUse', { toolName: 'Bash', command: 'pnpm test' });
    await record('Stop');
    expect(await desk.command(principal(c), conversationId, `${project}の完了条件は確かめた`)).toBe(
      `Claude Code（${project}）の「LINE に届く」を、あなたが確かめたものとして記録しました。「テストが通る」は、言葉ではなくテストの結果で確かめます。`,
    );
    const answer = await desk.command(principal(c), conversationId, `${project}はどこまで進んだ？`);
    expect(answer).toContain(`Claude Code（${project}）: 変えたあと、テストが通っています。`);
    expect(answer).toContain('・済「LINE に届く」');
    expect(answer).toContain('次: 完了条件はすべて満たしています。');
    expect(answer).not.toContain('決済');

    // ほかの人は読めない
    const other = await signIn();
    expect((await ledger(other.auth, `session=${session!.id}`)).statusCode).toBe(404);
    // 同じテナントのほかの人も読めない（テナントの壁だけに頼らない）
    expect(await desk.ledger.forSession(c.tenantId, uuidv7(), session!.id)).toBeNull();
  });

  it('puts criteria on a Genie task and reads its ledger', async () => {
    const { auth, connection: c, conversationId } = await signIn();
    const title = `経費精算-${uuidv7().slice(-6)}`;
    const { task } = await harness.tasks.create({
      tenantId: c.tenantId,
      userId: c.userId,
      request: {
        kind: 'echo',
        title,
        input: { message: '10 月分の経費を精算して' },
        conversation_id: conversationId as never,
      },
      idempotencyKey: `t:${uuidv7()}`,
    });
    expect(
      await desk.command(principal(c), conversationId, `${title}の完了条件は経理に提出すること`),
    ).toBe(
      [
        `「${title}」の完了条件を 1 つ覚えました。`,
        `・「経理に提出する」… 自動では確かめられないので、確かめたら「${title}の完了条件は確かめた」と言ってください`,
        '満たすまでは「終わった」とは言いません。',
      ].join('\n'),
    );
    // 承認と成果物は、持ち主（task・library）から読む
    await withTenant(harness.db, c.tenantId, (tx) =>
      tx
        .insertInto('approvals')
        .values({
          id: uuidv7(),
          tenant_id: c.tenantId,
          task_id: task.id,
          step_index: 0,
          risk: 'EXTERNAL_COMMIT',
          summary: '経理に精算書を送ります',
          details: JSON.stringify([]),
          status: 'PENDING',
          expires_at: new Date(Date.now() + 30 * 60_000),
        })
        .execute(),
    );
    for (const name of ['精算書', '領収書の一覧'])
      await harness.library.create({
        tenantId: c.tenantId,
        ownerId: c.userId,
        type: 'REPORT',
        title: name,
        mimeType: 'text/markdown',
        body: Buffer.from(name, 'utf8'),
        sourceTaskId: task.id,
      });
    const read = await ledger(auth, `task=${task.id}`);
    expect(read.statusCode).toBe(200);
    expect(read.json<Ledger>()).toMatchObject({
      name: `「${title}」`,
      request: '10 月分の経費を精算して',
      decisions: [{ text: '「経理に精算書を送ります」: 承認を待っています' }],
      artifacts: [{ title: '精算書' }, { title: '領収書の一覧' }],
      criteria: [{ text: '経理に提出する', kind: 'manual', state: 'unchecked' }],
    });
    const other = await signIn();
    expect((await ledger(other.auth, `task=${task.id}`)).statusCode).toBe(404);
    expect(await desk.ledger.forTask(c.tenantId, uuidv7(), task.id)).toBeNull();
    expect((await ledger(auth, `task=${task.id}&session=${task.id}`)).statusCode).toBe(400);
  });

  it('says it could not tell which work was meant, and leaves the overview question alone', async () => {
    const { connection: c, conversationId } = await signIn();
    expect(
      await desk.command(principal(c), conversationId, 'ないもの-zz の完了条件はテストが通ること'),
    ).toBe('「ないもの-zz」に当たる仕事が見つかりませんでした。');
    // 「今の作業はどこまで進んだ？」は全体の見通しの答えになる
    expect(await desk.command(principal(c), conversationId, '今の作業はどこまで進んだ？')).toBe(
      'いま動いている仕事も、待っているものもありません。',
    );
  });
});
