/**
 * 締切のある「やること」の置き場（todos）。本人ごと。テナントの RLS の内側で読み書きする。
 */
import { uuidv7 } from '@genie/contracts';
import { withTenant, type DbHandle } from '@genie/db';
import { sql } from 'kysely';

export type TodoStatus = 'open' | 'done' | 'deleted';

export interface Todo {
  readonly id: string;
  readonly tenantId: string;
  readonly userId: string;
  readonly conversationId: string | null;
  readonly title: string;
  /** 'YYYY-MM-DD'（本人のタイムゾーンの日付） */
  readonly dueDate: string;
  readonly status: TodoStatus;
  /** 締切の朝の知らせ（scheduled_jobs）。済んだら取り消す */
  readonly reminderJobId: string | null;
  readonly createdAt: Date;
  readonly doneAt: Date | null;
}

interface Row {
  id: string;
  tenant_id: string;
  user_id: string;
  conversation_id: string | null;
  title: string;
  due_date: string | Date;
  status: string;
  reminder_job_id: string | null;
  created_at: Date;
  done_at: Date | null;
}

const isoDate = (v: string | Date) =>
  typeof v === 'string'
    ? v.slice(0, 10)
    : `${String(v.getFullYear())}-${String(v.getMonth() + 1).padStart(2, '0')}-${String(v.getDate()).padStart(2, '0')}`;

function toTodo(row: Row): Todo {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    userId: row.user_id,
    conversationId: row.conversation_id,
    title: row.title,
    dueDate: isoDate(row.due_date),
    status: row.status as TodoStatus,
    reminderJobId: row.reminder_job_id,
    createdAt: row.created_at,
    doneAt: row.done_at,
  };
}

export class TodoStore {
  constructor(private readonly db: DbHandle) {}

  /**
   * やることを置く。同じ名前のまだ済んでいないものがあれば、締切だけ変える（2 つにしない）。
   * 返すのは置いたもの・前の締切（変えたときだけ）。
   */
  async upsert(input: {
    tenantId: string;
    userId: string;
    conversationId: string | null;
    title: string;
    dueDate: string;
  }): Promise<{ todo: Todo; previousDue: string | null }> {
    return withTenant(this.db, input.tenantId, async (tx) => {
      const existing = await tx
        .selectFrom('todos')
        .selectAll()
        .where('user_id', '=', input.userId)
        .where('status', '=', 'open')
        .where('title', '=', input.title)
        .executeTakeFirst();
      if (existing) {
        const row = await tx
          .updateTable('todos')
          .set({ due_date: input.dueDate, updated_at: sql`now()` })
          .where('id', '=', existing.id)
          .returningAll()
          .executeTakeFirstOrThrow();
        const before = isoDate(existing.due_date as string | Date);
        return { todo: toTodo(row as Row), previousDue: before === input.dueDate ? null : before };
      }
      const row = await tx
        .insertInto('todos')
        .values({
          id: uuidv7(),
          tenant_id: input.tenantId,
          user_id: input.userId,
          conversation_id: input.conversationId,
          title: input.title,
          due_date: input.dueDate,
          status: 'open',
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      return { todo: toTodo(row as Row), previousDue: null };
    });
  }

  async setReminder(tenantId: string, todoId: string, jobId: string | null): Promise<void> {
    await withTenant(this.db, tenantId, async (tx) => {
      await tx
        .updateTable('todos')
        .set({ reminder_job_id: jobId, updated_at: sql`now()` })
        .where('id', '=', todoId)
        .execute();
    });
  }

  /** まだ済んでいないやること（締切の早い順、同じ日は置いた順）。 */
  async open(tenantId: string, userId: string, limit = 50): Promise<Todo[]> {
    return withTenant(this.db, tenantId, async (tx) => {
      const rows = await tx
        .selectFrom('todos')
        .selectAll()
        .where('user_id', '=', userId)
        .where('status', '=', 'open')
        .orderBy('due_date', 'asc')
        .orderBy('created_at', 'asc')
        .limit(limit)
        .execute();
      return rows.map((r) => toTodo(r as Row));
    });
  }

  /** 済んだ・消した。変えられたら新しい行（もう済んでいれば null）。 */
  async close(
    tenantId: string,
    userId: string,
    todoId: string,
    status: 'done' | 'deleted',
  ): Promise<Todo | null> {
    return withTenant(this.db, tenantId, async (tx) => {
      const row = await tx
        .updateTable('todos')
        .set({
          status,
          done_at: status === 'done' ? sql`now()` : null,
          updated_at: sql`now()`,
        })
        .where('id', '=', todoId)
        .where('user_id', '=', userId)
        .where('status', '=', 'open')
        .returningAll()
        .executeTakeFirst();
      return row ? toTodo(row as Row) : null;
    });
  }
}
