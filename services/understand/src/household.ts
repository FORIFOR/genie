/**
 * 共有スペース（家族・夫婦の LINE グループ）と、個人のリスト。買い物リスト・TODO・日程の候補。
 *
 * 行は持ち主（グループで「使う」と言った連携済みの本人）のテナントに置く。household が null の行は
 * 本人の個人のリスト（1:1 のトークと Task Dock から使う）。誰が足した・買った・済ませたかは、
 * LINE の表示名で残す（グループのほかの人は Genie の利用者でなくてよい）。
 */
import { uuidv7 } from '@genie/contracts';
import { withTenant, type DbHandle } from '@genie/db';
import { sql } from 'kysely';
import type { ExpenseScope } from './expenses.js';

export type ListScope = ExpenseScope;

const inScope = (householdId: string | null) =>
  sql<boolean>`household_id is not distinct from ${householdId}::uuid`;

export interface Household {
  readonly id: string;
  readonly name: string;
  readonly autoReceipts: boolean;
}

export class HouseholdStore {
  constructor(private readonly db: DbHandle) {}

  async create(tenantId: string, ownerUserId: string, name: string): Promise<Household> {
    return withTenant(this.db, tenantId, async (tx) => {
      const row = await tx
        .insertInto('households')
        .values({
          id: uuidv7(),
          tenant_id: tenantId,
          owner_user_id: ownerUserId,
          name: name.slice(0, 100),
        })
        .returning(['id', 'name', 'auto_receipts'])
        .executeTakeFirstOrThrow();
      return { id: row.id, name: row.name, autoReceipts: row.auto_receipts };
    });
  }

  async get(tenantId: string, id: string): Promise<Household | null> {
    return withTenant(this.db, tenantId, async (tx) => {
      const row = await tx
        .selectFrom('households')
        .select(['id', 'name', 'auto_receipts'])
        .where('id', '=', id)
        .executeTakeFirst();
      return row ? { id: row.id, name: row.name, autoReceipts: row.auto_receipts } : null;
    });
  }

  /** 本人が持ち主の共有スペース（新しい順）。 */
  async forOwner(tenantId: string, ownerUserId: string): Promise<Household[]> {
    return withTenant(this.db, tenantId, async (tx) => {
      const rows = await tx
        .selectFrom('households')
        .select(['id', 'name', 'auto_receipts'])
        .where('owner_user_id', '=', ownerUserId)
        .orderBy('created_at', 'desc')
        .execute();
      return rows.map((r) => ({ id: r.id, name: r.name, autoReceipts: r.auto_receipts }));
    });
  }

  async setAutoReceipts(tenantId: string, id: string, on: boolean): Promise<void> {
    await withTenant(this.db, tenantId, (tx) =>
      tx.updateTable('households').set({ auto_receipts: on }).where('id', '=', id).execute(),
    );
  }
}

export interface ShoppingItem {
  readonly id: string;
  readonly name: string;
  readonly addedBy: string | null;
}

export class ShoppingStore {
  constructor(private readonly db: DbHandle) {}

  /** 足す。もう載っているもの（まだ買っていない同じ名前）は足さない。足した名前を返す。 */
  async add(scope: ListScope, names: readonly string[], by: string | null): Promise<string[]> {
    return withTenant(this.db, scope.tenantId, async (tx) => {
      const open = await tx
        .selectFrom('shopping_items')
        .select('name')
        .where('user_id', '=', scope.userId)
        .where(inScope(scope.householdId))
        .where('bought_at', 'is', null)
        .execute();
      const have = new Set(open.map((r) => normalize(r.name)));
      const added: string[] = [];
      for (const name of names) {
        if (have.has(normalize(name))) continue;
        have.add(normalize(name));
        await tx
          .insertInto('shopping_items')
          .values({
            id: uuidv7(),
            tenant_id: scope.tenantId,
            user_id: scope.userId,
            household_id: scope.householdId,
            name,
            added_by: by,
          })
          .execute();
        added.push(name);
      }
      return added;
    });
  }

  async open(scope: ListScope): Promise<ShoppingItem[]> {
    return withTenant(this.db, scope.tenantId, async (tx) => {
      const rows = await tx
        .selectFrom('shopping_items')
        .select(['id', 'name', 'added_by'])
        .where('user_id', '=', scope.userId)
        .where(inScope(scope.householdId))
        .where('bought_at', 'is', null)
        // 同じトランザクションで足したものは時刻が同じ。id（uuidv7）は足した順
        .orderBy('created_at')
        .orderBy('id')
        .limit(100)
        .execute();
      return rows.map((r) => ({ id: r.id, name: r.name, addedBy: r.added_by }));
    });
  }

  /** 買った印を付ける。names が null なら全部。印を付けた名前を返す。 */
  async bought(
    scope: ListScope,
    names: readonly string[] | null,
    by: string | null,
  ): Promise<string[]> {
    const open = await this.open(scope);
    const targets =
      names === null ? open : open.filter((item) => names.some((n) => matches(item.name, n)));
    if (targets.length === 0) return [];
    await withTenant(this.db, scope.tenantId, (tx) =>
      tx
        .updateTable('shopping_items')
        .set({ bought_at: sql`now()`, bought_by: by })
        .where(
          'id',
          'in',
          targets.map((t) => t.id),
        )
        .execute(),
    );
    return targets.map((t) => t.name);
  }
}

export interface Todo {
  readonly id: string;
  readonly title: string;
  readonly assignee: string | null;
}

export class TodoStore {
  constructor(private readonly db: DbHandle) {}

  async add(
    scope: ListScope,
    title: string,
    assignee: string | null,
    by: string | null,
  ): Promise<Todo> {
    return withTenant(this.db, scope.tenantId, async (tx) => {
      const row = await tx
        .insertInto('household_todos')
        .values({
          id: uuidv7(),
          tenant_id: scope.tenantId,
          user_id: scope.userId,
          household_id: scope.householdId,
          title: title.slice(0, 200),
          assignee,
          created_by: by,
        })
        .returning(['id', 'title', 'assignee'])
        .executeTakeFirstOrThrow();
      return row;
    });
  }

  async open(scope: ListScope): Promise<Todo[]> {
    return withTenant(this.db, scope.tenantId, async (tx) =>
      tx
        .selectFrom('household_todos')
        .select(['id', 'title', 'assignee'])
        .where('user_id', '=', scope.userId)
        .where(inScope(scope.householdId))
        .where('done_at', 'is', null)
        .orderBy('created_at')
        .orderBy('id')
        .limit(100)
        .execute(),
    );
  }

  /** 名前が合う、まだ済んでいない TODO。 */
  async find(scope: ListScope, title: string): Promise<Todo | null> {
    return (await this.open(scope)).find((t) => matches(t.title, title)) ?? null;
  }

  async assign(scope: ListScope, id: string, assignee: string): Promise<void> {
    await withTenant(this.db, scope.tenantId, (tx) =>
      tx.updateTable('household_todos').set({ assignee }).where('id', '=', id).execute(),
    );
  }

  async done(scope: ListScope, id: string, by: string | null): Promise<void> {
    await withTenant(this.db, scope.tenantId, (tx) =>
      tx
        .updateTable('household_todos')
        .set({ done_at: sql`now()`, done_by: by })
        .where('id', '=', id)
        .execute(),
    );
  }
}

export interface DatePoll {
  readonly id: string;
  readonly title: string;
  readonly candidates: readonly string[];
}

export interface PollTally {
  readonly date: string;
  readonly names: readonly string[];
}

export class PollStore {
  constructor(private readonly db: DbHandle) {}

  async create(
    tenantId: string,
    householdId: string,
    title: string,
    candidates: readonly string[],
    by: string | null,
  ): Promise<DatePoll> {
    return withTenant(this.db, tenantId, async (tx) => {
      // 開いている候補は 1 つだけ（新しく作ったら前のは閉じる）
      await tx
        .updateTable('date_polls')
        .set({ closed_at: sql`now()` })
        .where('household_id', '=', householdId)
        .where('closed_at', 'is', null)
        .execute();
      const row = await tx
        .insertInto('date_polls')
        .values({
          id: uuidv7(),
          tenant_id: tenantId,
          household_id: householdId,
          title: title.slice(0, 200),
          candidates: JSON.stringify(candidates),
          created_by: by,
        })
        .returning(['id', 'title'])
        .executeTakeFirstOrThrow();
      return { id: row.id, title: row.title, candidates };
    });
  }

  async open(tenantId: string, householdId: string): Promise<DatePoll | null> {
    return withTenant(this.db, tenantId, async (tx) => {
      const row = await tx
        .selectFrom('date_polls')
        .select(['id', 'title', 'candidates'])
        .where('household_id', '=', householdId)
        .where('closed_at', 'is', null)
        .orderBy('created_at', 'desc')
        .executeTakeFirst();
      return row
        ? { id: row.id, title: row.title, candidates: row.candidates as unknown as string[] }
        : null;
    });
  }

  async vote(
    tenantId: string,
    pollId: string,
    voter: string,
    voterName: string | null,
    available: readonly string[],
  ): Promise<void> {
    await withTenant(this.db, tenantId, (tx) =>
      tx
        .insertInto('date_poll_votes')
        .values({
          poll_id: pollId,
          tenant_id: tenantId,
          voter,
          voter_name: voterName,
          available: JSON.stringify(available),
        })
        .onConflict((oc) =>
          oc.columns(['poll_id', 'voter']).doUpdateSet({
            available: JSON.stringify(available),
            voter_name: voterName,
            updated_at: sql`now()`,
          }),
        )
        .execute(),
    );
  }

  /** 候補ごとの行ける人（候補の順）と、答えた人の数。 */
  async tally(tenantId: string, poll: DatePoll): Promise<{ rows: PollTally[]; voters: number }> {
    return withTenant(this.db, tenantId, async (tx) => {
      const votes = await tx
        .selectFrom('date_poll_votes')
        .select(['voter_name', 'voter', 'available'])
        .where('poll_id', '=', poll.id)
        .execute();
      const rows = poll.candidates.map((date) => ({
        date,
        names: votes
          .filter((v) => (v.available as unknown as string[]).includes(date))
          .map((v) => v.voter_name ?? v.voter),
      }));
      return { rows, voters: votes.length };
    });
  }

  async close(tenantId: string, pollId: string, decided: string | null): Promise<void> {
    await withTenant(this.db, tenantId, (tx) =>
      tx
        .updateTable('date_polls')
        .set({ closed_at: sql`now()`, decided })
        .where('id', '=', pollId)
        .execute(),
    );
  }
}

/** 比べるための形（空白・全角半角・大文字小文字をそろえる）。 */
export function normalize(s: string): string {
  return s.normalize('NFKC').replace(/\s+/g, '').toLowerCase();
}

/** 「牛乳」と「牛乳 1 本」、「ゴミ出し」と「ゴミ出しの当番」を同じものとみなす。 */
function matches(have: string, said: string): boolean {
  const a = normalize(have);
  const b = normalize(said);
  return a === b || (b.length >= 2 && (a.includes(b) || b.includes(a)));
}
