/**
 * 家計簿の行。付ける・取り消す・月の集計・予算。
 *
 * **同じレシートを二度付けない。**店・日付・合計の指紋と、写真の指紋のどちらかが同じなら 'duplicate'。
 * 取り消した行は消さずに印を付ける（同じレシートをもう一度付け直せる）。
 */
import { createHash } from 'node:crypto';
import { uuidv7 } from '@genie/contracts';
import { withTenant, type DbHandle } from '@genie/db';
import { sql } from 'kysely';

export interface Expense {
  readonly id: string;
  readonly amount: number;
  readonly currency: string;
  readonly category: string;
  readonly merchant: string | null;
  readonly spentOn: string;
  readonly createdAt: string;
}

/**
 * どの家計簿か。household が null なら本人の個人の家計簿、あれば共有スペース（グループ）の家計簿。
 * 共有スペースの行も持ち主（user）のテナントに置く。
 */
export interface ExpenseScope {
  readonly tenantId: string;
  readonly userId: string;
  readonly householdId: string | null;
}

export interface NewExpense {
  readonly amount: number;
  readonly currency: string;
  readonly category: string;
  readonly merchant: string | null;
  readonly spentOn: string;
  readonly source: string;
  readonly imageSha256: string | null;
  /** 共有スペースで付けた人（表示名）。 */
  readonly recordedBy?: string | null;
}

/** 店・日付・合計の指紋。店の名前は空白と大文字小文字をそろえてから。 */
export function receiptKey(e: Pick<NewExpense, 'merchant' | 'spentOn' | 'amount' | 'currency'>) {
  const merchant = (e.merchant ?? '').normalize('NFKC').replace(/\s+/g, '').toLowerCase();
  return createHash('sha256')
    .update(`${merchant}|${e.spentOn}|${e.amount.toFixed(2)}|${e.currency}`)
    .digest('hex');
}

const toExpense = (r: {
  id: string;
  amount: string;
  currency: string;
  category: string;
  merchant: string | null;
  spent_on: Date | string;
  created_at: Date;
}): Expense => ({
  id: r.id,
  amount: Number(r.amount),
  currency: r.currency,
  category: r.category,
  merchant: r.merchant,
  spentOn: typeof r.spent_on === 'string' ? r.spent_on.slice(0, 10) : isoDate(r.spent_on),
  createdAt: r.created_at.toISOString(),
});

// date 列は時刻の無い日付。Date に化けたら、その日の年月日だけを取る
/** household の条件（個人なら null の行だけ）。 */
const inScope = (householdId: string | null) =>
  sql<boolean>`household_id is not distinct from ${householdId}::uuid`;

const isoDate = (d: Date) =>
  `${String(d.getFullYear())}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

export class ExpenseStore {
  constructor(private readonly db: DbHandle) {}

  /** 付ける。同じレシート（店・日付・合計、または同じ写真）がもうあれば、その行を返す。 */
  async add(
    scope: ExpenseScope,
    e: NewExpense,
  ): Promise<{ result: 'added' | 'duplicate'; expense: Expense }> {
    const { tenantId, userId, householdId } = scope;
    const key = receiptKey(e);
    return withTenant(this.db, tenantId, async (tx) => {
      const existing = await tx
        .selectFrom('expenses')
        .select(['id', 'amount', 'currency', 'category', 'merchant', 'spent_on', 'created_at'])
        .where('user_id', '=', userId)
        .where(inScope(householdId))
        .where('voided_at', 'is', null)
        .where((w) =>
          e.imageSha256
            ? w.or([w('receipt_key', '=', key), w('image_sha256', '=', e.imageSha256)])
            : w('receipt_key', '=', key),
        )
        .executeTakeFirst();
      if (existing) return { result: 'duplicate', expense: toExpense(existing) };
      const row = await tx
        .insertInto('expenses')
        .values({
          id: uuidv7(),
          tenant_id: tenantId,
          user_id: userId,
          amount: e.amount.toFixed(2),
          currency: e.currency,
          category: e.category,
          merchant: e.merchant,
          spent_on: e.spentOn,
          source: e.source,
          receipt_key: key,
          image_sha256: e.imageSha256,
          household_id: householdId,
          recorded_by: e.recordedBy ?? null,
        })
        .returning(['id', 'amount', 'currency', 'category', 'merchant', 'spent_on', 'created_at'])
        .executeTakeFirstOrThrow();
      return { result: 'added', expense: toExpense(row) };
    });
  }

  /** 取り消す（印を付ける）。本人の、まだ取り消していない行だけ。 */
  async void({ tenantId, userId }: ExpenseScope, id: string): Promise<boolean> {
    return withTenant(this.db, tenantId, async (tx) => {
      const result = await tx
        .updateTable('expenses')
        .set({ voided_at: sql`now()` })
        .where('id', '=', id)
        .where('user_id', '=', userId)
        .where('voided_at', 'is', null)
        .executeTakeFirst();
      return Number(result.numUpdatedRows) > 0;
    });
  }

  /** その月（YYYY-MM）の費目ごとの合計。通貨ごとに分ける。 */
  async monthTotals(
    { tenantId, userId, householdId }: ExpenseScope,
    month: string,
  ): Promise<{ category: string; currency: string; total: number; count: number }[]> {
    const start = `${month}-01`;
    return withTenant(this.db, tenantId, async (tx) => {
      const rows = await tx
        .selectFrom('expenses')
        .select([
          'category',
          'currency',
          sql<string>`sum(amount)`.as('total'),
          sql<string>`count(*)`.as('count'),
        ])
        .where('user_id', '=', userId)
        .where(inScope(householdId))
        .where('voided_at', 'is', null)
        .where('spent_on', '>=', sql<Date>`${start}::date`)
        .where('spent_on', '<', sql<Date>`(${start}::date + interval '1 month')`)
        .groupBy(['category', 'currency'])
        .orderBy(sql`sum(amount)`, 'desc')
        .execute();
      return rows.map((r) => ({
        category: r.category,
        currency: r.currency,
        total: Number(r.total),
        count: Number(r.count),
      }));
    });
  }

  async budgets({
    tenantId,
    userId,
    householdId,
  }: ExpenseScope): Promise<{ category: string; currency: string; monthly: number }[]> {
    return withTenant(this.db, tenantId, async (tx) => {
      const rows = await tx
        .selectFrom('expense_budgets')
        .select(['category', 'currency', 'monthly'])
        .where('user_id', '=', userId)
        .where(inScope(householdId))
        .execute();
      return rows.map((r) => ({
        category: r.category,
        currency: r.currency,
        monthly: Number(r.monthly),
      }));
    });
  }

  async setBudget(
    { tenantId, userId, householdId }: ExpenseScope,
    category: string,
    currency: string,
    monthly: number,
  ): Promise<void> {
    await withTenant(this.db, tenantId, async (tx) => {
      // 一意は式の索引（household が null の行も 1 つに）なので、ON CONFLICT ではなく書き換え→無ければ足す
      const updated = await tx
        .updateTable('expense_budgets')
        .set({ monthly: monthly.toFixed(2), updated_at: sql`now()` })
        .where('user_id', '=', userId)
        .where(inScope(householdId))
        .where('category', '=', category)
        .where('currency', '=', currency)
        .executeTakeFirst();
      if (Number(updated.numUpdatedRows) > 0) return;
      await tx
        .insertInto('expense_budgets')
        .values({
          tenant_id: tenantId,
          user_id: userId,
          household_id: householdId,
          category,
          currency,
          monthly: monthly.toFixed(2),
        })
        .execute();
    });
  }
}
