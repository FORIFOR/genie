/**
 * 予定とやることの候補（schedule_candidates）の置き場。本人ごと・会話ごと。テナントの RLS の内側で読み書きする。
 */
import { uuidv7 } from '@genie/contracts';
import { withTenant, type DbHandle } from '@genie/db';
import { sql } from 'kysely';
import type { Candidate } from './extract.js';
import { dueFromIso, dueIso } from './todo-parse.js';

export type CandidateSource = 'text' | 'call_minutes';
export type CandidateStatus = 'pending' | 'added' | 'dismissed';

export type StoredCandidate = Candidate & {
  readonly id: string;
  readonly batchId: string;
  readonly position: number;
  readonly status: CandidateStatus;
  readonly createdAt: Date;
};

interface Row {
  id: string;
  batch_id: string;
  position: number;
  kind: string;
  title: string;
  start_at: Date | null;
  end_at: Date | null;
  due_date: string | Date | null;
  excerpt: string;
  status: string;
  created_at: Date;
}

const isoDate = (v: string | Date) =>
  typeof v === 'string'
    ? v.slice(0, 10)
    : `${String(v.getFullYear())}-${String(v.getMonth() + 1).padStart(2, '0')}-${String(v.getDate()).padStart(2, '0')}`;

function toCandidate(r: Row): StoredCandidate {
  const base = {
    id: r.id,
    batchId: r.batch_id,
    position: r.position,
    status: r.status as CandidateStatus,
    createdAt: r.created_at,
    title: r.title,
    excerpt: r.excerpt,
  };
  return r.kind === 'event'
    ? {
        ...base,
        kind: 'event',
        start: r.start_at!.getTime(),
        end: r.end_at ? r.end_at.getTime() : null,
      }
    : { ...base, kind: 'todo', due: dueFromIso(isoDate(r.due_date!)) };
}

export class CandidateStore {
  constructor(private readonly db: DbHandle) {}

  /** 1 回の提案として置く（番号は 1 から）。 */
  async addBatch(input: {
    tenantId: string;
    userId: string;
    conversationId: string;
    source: CandidateSource;
    candidates: readonly Candidate[];
  }): Promise<StoredCandidate[]> {
    const batchId = uuidv7();
    return withTenant(this.db, input.tenantId, async (tx) => {
      const rows = await tx
        .insertInto('schedule_candidates')
        .values(
          input.candidates.map((c, i) => ({
            id: uuidv7(),
            tenant_id: input.tenantId,
            user_id: input.userId,
            conversation_id: input.conversationId,
            batch_id: batchId,
            position: i + 1,
            kind: c.kind,
            title: c.title.slice(0, 200),
            start_at: c.kind === 'event' ? new Date(c.start) : null,
            end_at: c.kind === 'event' && c.end ? new Date(c.end) : null,
            due_date: c.kind === 'todo' ? dueIso(c.due) : null,
            source: input.source,
            excerpt: c.excerpt.slice(0, 400),
            status: 'pending',
          })),
        )
        .returningAll()
        .execute();
      return rows.map((r) => toCandidate(r as Row)).sort((a, b) => a.position - b.position);
    });
  }

  /** この会話のいちばん新しい提案（since より後のもの）。無ければ []。 */
  async latestBatch(
    tenantId: string,
    userId: string,
    conversationId: string,
    since: Date,
  ): Promise<StoredCandidate[]> {
    return withTenant(this.db, tenantId, async (tx) => {
      const last = await tx
        .selectFrom('schedule_candidates')
        .select('batch_id')
        .where('conversation_id', '=', conversationId)
        .where('user_id', '=', userId)
        .where('created_at', '>', since)
        .orderBy('created_at', 'desc')
        .orderBy('id', 'desc')
        .limit(1)
        .executeTakeFirst();
      if (!last) return [];
      const rows = await tx
        .selectFrom('schedule_candidates')
        .selectAll()
        .where('batch_id', '=', last.batch_id)
        .orderBy('position')
        .execute();
      return rows.map((r) => toCandidate(r as Row));
    });
  }

  /** 決めた（入れた・いらない）。まだ pending のものだけ変える。変えた数を返す。 */
  async decide(
    tenantId: string,
    ids: readonly string[],
    status: 'added' | 'dismissed',
  ): Promise<number> {
    if (ids.length === 0) return 0;
    return withTenant(this.db, tenantId, async (tx) => {
      const res = await tx
        .updateTable('schedule_candidates')
        .set({ status, decided_at: sql`now()` })
        .where('id', 'in', ids)
        .where('status', '=', 'pending')
        .executeTakeFirst();
      return Number(res.numUpdatedRows);
    });
  }
}
