/**
 * @genie/db
 *
 * PostgreSQL への型付きアクセスとテナント境界。
 * スキーマの正本は `infra/db/migrations/*.sql`（ADR 0002）。
 *
 * 規約:
 *   - service コードは withTenant / withSystem / withIdentity 以外から DB を触らない
 *   - 所有していないテーブルに直接 SQL を投げない（実装仕様 §5.1 の所有権表）
 *   - サービス境界をまたぐトランザクションを張らない
 */
export { dbConfigFromEnv, type DbConfig } from './config.js';
export { createDb, pingDb, type Db, type DbHandle } from './pool.js';
export {
  withTenant,
  withSystem,
  withIdentity,
  withShare,
  currentTenantId,
  currentScopeKind,
  readTenantSetting,
  type ScopedDb,
  type ScopeKind,
} from './tenant.js';
export type { Database } from './types.js';
export type * from './generated/schema.js';
export { isTransactionAuthorizationApprovalActive } from './transaction-authority.js';
