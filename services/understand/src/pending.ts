/**
 * 本人に確かめている途中のこと（「家計簿に付けますか？」「カレンダーに入れますか？」）。会話に 1 つ、10 分。
 *
 * DB に置く（pending_confirmations）。プロセスの記憶だけだと、再起動で「はい」が効かなくなる
 * （仕様 v1.0 §9: 失敗してもやり直させない）。試験では記憶の版（MemoryPending）を使う。
 */
import { withTenant, type DbHandle } from '@genie/db';
import type { NewExpense } from './expenses.js';

export type Pending =
  | { readonly kind: 'expense'; readonly expense: NewExpense; readonly expiresAt: number }
  | { readonly kind: 'event'; readonly request: string; readonly expiresAt: number };

export interface PendingBox {
  get(tenantId: string, conversationId: string, now: number): Promise<Pending | null>;
  set(tenantId: string, conversationId: string, pending: Pending): Promise<void>;
  delete(tenantId: string, conversationId: string): Promise<void>;
}

/** プロセスの記憶（試験・DB の無い組み立て）。 */
export class MemoryPending implements PendingBox {
  readonly #items = new Map<string, Pending>();
  async get(tenantId: string, conversationId: string, now: number) {
    const p = this.#items.get(`${tenantId}:${conversationId}`);
    if (!p) return null;
    if (p.expiresAt < now) {
      this.#items.delete(`${tenantId}:${conversationId}`);
      return null;
    }
    return p;
  }
  async set(tenantId: string, conversationId: string, pending: Pending) {
    this.#items.set(`${tenantId}:${conversationId}`, pending);
  }
  async delete(tenantId: string, conversationId: string) {
    this.#items.delete(`${tenantId}:${conversationId}`);
  }
}

export class PendingStore implements PendingBox {
  constructor(private readonly db: DbHandle) {}

  async get(tenantId: string, conversationId: string, now: number): Promise<Pending | null> {
    const row = await withTenant(this.db, tenantId, (tx) =>
      tx
        .selectFrom('pending_confirmations')
        .select(['kind', 'payload', 'expires_at'])
        .where('conversation_id', '=', conversationId)
        .executeTakeFirst(),
    );
    if (!row) return null;
    const expiresAt = new Date(row.expires_at).getTime();
    if (expiresAt < now) {
      await this.delete(tenantId, conversationId);
      return null;
    }
    const payload = row.payload as Record<string, unknown>;
    if (row.kind === 'expense')
      return { kind: 'expense', expense: payload['expense'] as NewExpense, expiresAt };
    return { kind: 'event', request: String(payload['request'] ?? ''), expiresAt };
  }

  async set(tenantId: string, conversationId: string, pending: Pending): Promise<void> {
    const payload =
      pending.kind === 'expense' ? { expense: pending.expense } : { request: pending.request };
    const values = {
      tenant_id: tenantId,
      conversation_id: conversationId,
      kind: pending.kind,
      payload: JSON.stringify(payload),
      expires_at: new Date(pending.expiresAt),
    };
    await withTenant(this.db, tenantId, (tx) =>
      tx
        .insertInto('pending_confirmations')
        .values(values)
        .onConflict((oc) =>
          oc.columns(['tenant_id', 'conversation_id']).doUpdateSet({
            kind: values.kind,
            payload: values.payload,
            expires_at: values.expires_at,
            created_at: new Date(),
          }),
        )
        .execute(),
    );
  }

  async delete(tenantId: string, conversationId: string): Promise<void> {
    await withTenant(this.db, tenantId, (tx) =>
      tx
        .deleteFrom('pending_confirmations')
        .where('conversation_id', '=', conversationId)
        .execute(),
    );
  }
}
