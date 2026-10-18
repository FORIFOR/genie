/**
 * DB スコープ。実装仕様 §4.4 / §5.4。
 *
 * **DB へのアクセスは必ずここを通す。**生の `pool.query` を service から直接呼ばない
 * （実装仕様 §14.3-1 で CI が機械検査する）。
 * RLS は二重防御の DB 層でしかなく、アプリ層の防御がこのモジュール。
 *
 * スコープは 3 種類:
 *   withTenant   テナントに属する全処理。既定。
 *   withSystem   テナントを持たない処理（プラグインカタログ）。RLS 対象は 1 行も見えない。
 *   withIdentity 認証だけ。テナント確定前に users を引く必要があるため（逸脱 D-14）。
 *   withShare    共有リンクの解決だけ。同じ理由でテナントが分からない（逸脱 D-22）。
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { sql, type Transaction } from 'kysely';
import { GenieError, TenantId } from '@genie/contracts';
import type { Db, DbHandle } from './pool.js';
import type { Database } from './types.js';

export type ScopedDb = Transaction<Database>;
export type ScopeKind = 'tenant' | 'system' | 'identity' | 'share';

interface Scope {
  readonly tenantId: string | null;
  readonly db: ScopedDb;
  readonly kind: ScopeKind;
}

const scope = new AsyncLocalStorage<Scope>();

/** 現在のテナント。テナントスコープ外なら null。ログと監査の付帯情報に使う。 */
export function currentTenantId(): string | null {
  const s = scope.getStore();
  return s?.kind === 'tenant' ? s.tenantId : null;
}

export function currentScopeKind(): ScopeKind | null {
  return scope.getStore()?.kind ?? null;
}

function rejectNesting(outer: Scope, wanted: ScopeKind): never {
  throw new GenieError(
    'common.internal',
    `${wanted} scope cannot be opened inside a ${outer.kind} scope`,
  );
}

async function runScoped<T>(
  db: Db,
  kind: ScopeKind,
  tenantId: string | null,
  fn: (tx: ScopedDb) => Promise<T>,
): Promise<T> {
  return db.transaction().execute(async (tx) => {
    if (tenantId !== null) {
      // SET LOCAL はバインド変数を取れないため set_config(..., is_local => true) を使う。
      // GUC を文字列連結で組み立てない。
      await sql`select set_config('app.tenant_id', ${tenantId}, true)`.execute(tx);
    }
    return scope.run({ tenantId, db: tx, kind }, () => fn(tx));
  });
}

/**
 * テナントスコープでトランザクションを開く。
 *
 * `SET LOCAL` 相当の設定はトランザクション内でしか効かない。外で設定しても
 * PostgreSQL は WARNING を出すだけで無視し、`astra_current_tenant()` が NULL になって
 * 全行が不可視になる（fail-closed だが原因が分かりにくい）。
 * そのため GUC 設定とトランザクションを分離せず、この関数が一体で扱う。
 *
 * ネストした場合:
 *   - 同一テナントなら既存トランザクションに相乗りする。in-process composition で
 *     サービスをまたいで呼び合ってもトランザクションが分裂しない（ADR 0001）
 *   - 別テナントなら例外。テナントをまたぐ書き込みを 1 つの論理処理にさせない
 */
export async function withTenant<T>(
  handle: DbHandle,
  tenantId: string,
  fn: (tx: ScopedDb) => Promise<T>,
): Promise<T> {
  if (!TenantId.safeParse(tenantId).success) {
    throw new GenieError('common.validation_failed', `invalid tenant id: ${tenantId}`);
  }

  const existing = scope.getStore();
  if (existing) {
    if (existing.kind !== 'tenant') rejectNesting(existing, 'tenant');
    if (existing.tenantId !== tenantId) {
      throw new GenieError(
        'auth.forbidden',
        `nested withTenant for a different tenant (outer=${existing.tenantId}, inner=${tenantId})`,
      );
    }
    return fn(existing.db);
  }

  return runScoped(handle.app, 'tenant', tenantId, fn);
}

/**
 * テナントを持たない処理専用（プラグインカタログ、publisher 登録）。
 *
 * `app.tenant_id` を設定しないので、RLS の効くテーブルは **1 行も見えない**。
 * 誤ってテナントデータを触っても情報が漏れない側へ倒れる。
 */
export async function withSystem<T>(
  handle: DbHandle,
  fn: (tx: ScopedDb) => Promise<T>,
): Promise<T> {
  const existing = scope.getStore();
  if (existing) rejectNesting(existing, 'system');
  return runScoped(handle.app, 'system', null, fn);
}

/**
 * 認証専用スコープ（逸脱 D-14）。
 *
 * ログインとサインアップはテナントが決まる**前**に走る。RLS 下では
 * `users` の SELECT が membership 依存、INSERT も membership 不在で弾かれるため、
 * このスコープだけ identity テーブルに限定した BYPASSRLS ロールを使う。
 *
 * 使ってよいのは `tenants` `users` `memberships` `devices` `sessions` `user_identities` と、
 * チャネル連携の照合（`channel_links` の SELECT / UPDATE）のみ。
 * ロール側の GRANT でも他テーブルは触れない（infra/db/bootstrap.sql）。
 * テナントが判明したあとの処理は必ず `withTenant` へ移すこと。
 */
export async function withIdentity<T>(
  handle: DbHandle,
  fn: (tx: ScopedDb) => Promise<T>,
): Promise<T> {
  const existing = scope.getStore();
  if (existing) rejectNesting(existing, 'identity');
  if (!handle.identity) {
    throw new GenieError(
      'common.internal',
      'identity scope requires ASTRA_DB_IDENTITY_URL; refusing to fall back to the app role',
    );
  }
  return runScoped(handle.identity, 'identity', null, fn);
}

/**
 * 共有リンクの解決専用スコープ（逸脱 D-22）。
 *
 * 公開 viewer はトークンしか持たない。テナントが分からないので RLS 下では
 * `shares` を引けない。`withIdentity` と同じ形で、**共有テーブルにしか
 * GRANT されていない** BYPASSRLS ロールを使う。
 *
 * ここで触ってよいのは `shares` と `share_access_logs` だけ。
 * artifact の読み出しは、解決した share の `tenant_id` で `withTenant` へ移る。
 * BYPASSRLS の影響範囲を GRANT で物理的に閉じ込めるのが要点。
 */
export async function withShare<T>(handle: DbHandle, fn: (tx: ScopedDb) => Promise<T>): Promise<T> {
  const existing = scope.getStore();
  if (existing) rejectNesting(existing, 'share');
  if (!handle.share) {
    throw new GenieError(
      'common.internal',
      'share scope requires ASTRA_DB_SHARE_URL; refusing to fall back to the app role',
    );
  }
  return runScoped(handle.share, 'share', null, fn);
}

/** 現在のトランザクションで DB 側が見ているテナント。テストと診断用。 */
export async function readTenantSetting(tx: ScopedDb): Promise<string | null> {
  const result = await sql<{ tenant: string | null }>`
    select nullif(current_setting('app.tenant_id', true), '') as tenant
  `.execute(tx);
  return result.rows[0]?.tenant ?? null;
}
