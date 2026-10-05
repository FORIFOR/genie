/**
 * 調査の 4 段を、モデルと検索を差し替えて DB の上で通す。
 *
 *   ./infra/db/with-test-db.sh pnpm --filter @genie/service-research test
 *
 * 見るのは 1 つ: **モデルや検索を呼ぶ間、トランザクションを開いていないこと。**
 * 端末のモデルへの依頼は行を置いて端末が取りに来るのを待つ。開いたままだと
 * その行は端末から見えず、誰も取らない依頼を上限まで待つことになる。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uuidv7 } from '@genie/contracts';
import { createDb, currentScopeKind, withIdentity, withTenant, type DbHandle } from '@genie/db';
import { ResearchService } from '../src/service.js';
import type { LanguageModel, SearchProvider } from '../src/providers.js';

const url = process.env['TEST_DATABASE_URL'];
const identityUrl = process.env['TEST_IDENTITY_DATABASE_URL'];

describe.skipIf(!url)('research steps and the model', () => {
  let db: DbHandle;
  const tenantId = uuidv7();
  const userId = uuidv7();
  const taskId = uuidv7();
  /** どの呼び出しが、どのスコープの中で起きたか。外なら null。 */
  const scopes: { call: string; scope: string | null }[] = [];
  const seen = (call: string): void => {
    scopes.push({ call, scope: currentScopeKind() });
  };

  const model: LanguageModel = {
    name: 'fixture',
    isStandIn: true,
    async decompose(question) {
      seen('decompose');
      return [question];
    },
    async extractClaims(_question, hit) {
      seen('extractClaims');
      return [{ claim: `${hit.title} は 2026 年に公開された。`, supportText: hit.snippet }];
    },
    async synthesize(_question, claims) {
      seen('synthesize');
      return claims.map((claim, index) => ({ text: claim, supports: [index] }));
    },
    async answer() {
      seen('answer');
      return '';
    },
    async compose() {
      seen('compose');
      return '';
    },
    async followUp(_question, claims) {
      seen('followUp');
      return claims.length > 0 ? ['資料 A の続報'] : [];
    },
    async assess(_question, claims) {
      seen('assess');
      return claims.map((claim, index) => ({ text: `${claim} ので有力`, supports: [index] }));
    },
  };
  const search: SearchProvider = {
    name: 'fixture',
    isStandIn: true,
    async search() {
      seen('search');
      return [
        {
          url: 'https://example.com/a',
          title: '資料 A',
          snippet: '資料 A は 2026 年に公開された。',
          publisher: 'example.com',
          publishedAt: '2026-09-01T00:00:00.000Z',
          sourceType: 'official',
        },
      ];
    },
  };

  beforeAll(async () => {
    db = createDb({
      url: url!,
      identityUrl: identityUrl!,
      maxConnections: 4,
      identityMaxConnections: 2,
      idleTimeoutMillis: 5_000,
      connectionTimeoutMillis: 5_000,
      statementTimeoutMillis: 20_000,
      applicationName: 'genie-research-test',
    });
    await withIdentity(db, async (tx) => {
      await tx
        .insertInto('tenants')
        .values({ id: tenantId, name: 'research-test', kind: 'personal' })
        .execute();
      await tx
        .insertInto('users')
        .values({ id: userId, email: `research-${userId}@example.com`, display_name: '調査試験' })
        .execute();
      await tx
        .insertInto('memberships')
        .values({ tenant_id: tenantId, user_id: userId, role: 'owner' })
        .execute();
    });
    await withTenant(db, tenantId, (tx) =>
      tx
        .insertInto('tasks')
        .values({
          id: taskId,
          tenant_id: tenantId,
          created_by: userId,
          conversation_id: null,
          kind: 'research',
          title: 'テスト',
          status: 'RUNNING',
          input: JSON.stringify({}),
          idempotency_key: `k-${taskId}`,
          workflow_id: `wf-${taskId}`,
        })
        .execute(),
    );
  }, 120_000);

  afterAll(async () => {
    await db?.close();
  });

  it('never calls the model or the search while a transaction is open, in any step', async () => {
    const research = new ResearchService({ db, search, model });
    await research.plan(tenantId, taskId, '資料 A の公開時期を予想して');
    await research.search(tenantId, taskId);
    const deepened = await research.deepen(tenantId, taskId);
    await research.verify(tenantId, taskId);
    const report = await research.report(tenantId, taskId);

    expect(scopes.map((entry) => entry.call)).toEqual([
      'decompose',
      'search',
      'extractClaims',
      'followUp',
      'search',
      'extractClaims',
      'synthesize',
      'assess',
    ]);
    expect(scopes.filter((entry) => entry.scope !== null)).toEqual([]);

    // 外へ出しても、結果は同じところへ残る。
    // 深掘りの検索も同じ代役なので、同じ出典が見つかるだけ（数は増えない）
    expect(deepened.result).toEqual({ sources: 1, claims: 1 });
    expect(report.result).toEqual({ sources: 1 });
    expect(report.artifact?.markdown).toContain('資料 A は 2026 年に公開された。');
    expect(report.artifact?.markdown).toContain('## 見立て');
    const run = await withTenant(db, tenantId, (tx) =>
      tx
        .selectFrom('research_runs')
        .select('status')
        .where('task_id', '=', taskId)
        .executeTakeFirstOrThrow(),
    );
    expect(run.status).toBe('COMPLETE');
  });
});
