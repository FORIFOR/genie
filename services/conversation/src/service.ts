/**
 * Conversation Engine の保存側。正本 §7.3、Phase 7 実装仕様 §2。
 *
 * 会話そのものは DB が正本。**打ち切っても出した分は消さない**（D-50）。
 */
import { createHash } from 'node:crypto';
import {
  GenieError,
  COMPACTION_BATCH,
  RECENT_TURN_WINDOW,
  uuidv7,
  type ConversationState,
  type ConversationSummary,
  type Modality,
  type Referent,
  type Turn,
} from '@genie/contracts';
import { withTenant, type DbHandle } from '@genie/db';
import { readEventsAfter } from '@genie/service-task';

export interface ConversationDeps {
  readonly db: DbHandle;
  readonly now?: () => Date;
  readonly findAcceptedTask?: (
    tenantId: string,
    userId: string,
    conversationId: string,
    turnId: string,
  ) => Promise<string | null>;
}

export interface AppendTurnInput {
  readonly tenantId: string;
  readonly conversationId: string;
  readonly role: 'user' | 'assistant' | 'system';
  readonly modality: Modality;
  readonly text: string;
  readonly id?: string;
}

export class ConversationService {
  readonly #db: DbHandle;
  readonly #now: () => Date;
  readonly #findAcceptedTask: ConversationDeps['findAcceptedTask'];

  constructor(deps: ConversationDeps) {
    this.#db = deps.db;
    this.#findAcceptedTask = deps.findAcceptedTask;
    this.#now = deps.now ?? (() => new Date());
  }

  /** A receipt is scoped to the caller, not merely to tenant membership. */
  async reserveRequest(
    tenantId: string,
    userId: string,
    conversationId: string,
    requestId: string,
    body: unknown,
  ): Promise<{
    fresh: boolean;
    turnId: string;
    response: Record<string, unknown> | null;
    status: number | null;
  }> {
    const bodyHash = createHash('sha256').update(canonicalJson(body)).digest('hex');
    return withTenant(this.#db, tenantId, async (tx) => {
      const conversation = await tx
        .selectFrom('conversations')
        .select('id')
        .where('id', '=', conversationId)
        .where('created_by', '=', userId)
        .executeTakeFirst();
      if (!conversation) throw new GenieError('common.not_found', 'conversation not found');
      const inserted = await tx
        .insertInto('conversation_requests')
        .values({
          tenant_id: tenantId,
          user_id: userId,
          conversation_id: conversationId,
          request_id: requestId,
          body_hash: bodyHash,
          turn_id: uuidv7(),
        })
        .onConflict((oc) =>
          oc.columns(['tenant_id', 'user_id', 'conversation_id', 'request_id']).doNothing(),
        )
        .returningAll()
        .executeTakeFirst();
      const receipt =
        inserted ??
        (await tx
          .selectFrom('conversation_requests')
          .selectAll()
          .where('tenant_id', '=', tenantId)
          .where('user_id', '=', userId)
          .where('conversation_id', '=', conversationId)
          .where('request_id', '=', requestId)
          .executeTakeFirstOrThrow());
      if (receipt.body_hash !== bodyHash)
        throw new GenieError('common.conflict', 'request_id already used with different input');
      return {
        fresh: !!inserted,
        turnId: receipt.turn_id,
        response: receipt.response as Record<string, unknown> | null,
        status: receipt.response_status,
      };
    });
  }

  async prepareRequest(
    tenantId: string,
    userId: string,
    conversationId: string,
    requestId: string,
    response: Record<string, unknown>,
  ): Promise<void> {
    await withTenant(this.#db, tenantId, (tx) =>
      tx
        .updateTable('conversation_requests')
        .set({ prepared_response: JSON.stringify(response) })
        .where('tenant_id', '=', tenantId)
        .where('user_id', '=', userId)
        .where('conversation_id', '=', conversationId)
        .where('request_id', '=', requestId)
        .where('response', 'is', null)
        .execute(),
    );
  }

  async finishRequest(
    tenantId: string,
    userId: string,
    conversationId: string,
    requestId: string,
    status: number,
    response: Record<string, unknown>,
  ): Promise<void> {
    await withTenant(this.#db, tenantId, (tx) =>
      tx
        .updateTable('conversation_requests')
        .set({ response: JSON.stringify(response), response_status: status })
        .where('tenant_id', '=', tenantId)
        .where('user_id', '=', userId)
        .where('conversation_id', '=', conversationId)
        .where('request_id', '=', requestId)
        .where('response', 'is', null)
        .execute(),
    );
  }

  /** Read-only: never restarts work, even when reservation was followed by a crash. */
  async requestStatus(
    tenantId: string,
    userId: string,
    conversationId: string,
    requestId: string,
  ): Promise<{ status: 'pending' | 'resolved'; response?: Record<string, unknown> }> {
    return withTenant(this.#db, tenantId, async (tx) => {
      const row = await tx
        .selectFrom('conversation_requests')
        .selectAll()
        .where('tenant_id', '=', tenantId)
        .where('user_id', '=', userId)
        .where('conversation_id', '=', conversationId)
        .where('request_id', '=', requestId)
        .executeTakeFirst();
      if (!row) throw new GenieError('common.not_found', 'request not found');
      if (row.response)
        return { status: 'resolved', response: row.response as Record<string, unknown> };
      // Task insertion is durable before the response is finalized. Its ID is safe
      // to recover; queued/running is NOT a claim that execution has completed.
      if (row.prepared_response) {
        const task = await this.#findAcceptedTask?.(tenantId, userId, conversationId, row.turn_id);
        if (task)
          return {
            status: 'resolved',
            response: {
              ...(row.prepared_response as Record<string, unknown>),
              task_id: task,
              // Keep prepared capability limits/disclosures when dispatch acknowledgement is lost.
            },
          };
      }
      return { status: 'pending' };
    });
  }

  async start(
    tenantId: string,
    userId: string,
    options: { title?: string | undefined; responseMode?: Modality } = {},
  ): Promise<{ id: string; state: ConversationState }> {
    const id = uuidv7();
    const at = this.#now();

    const state = await withTenant(this.#db, tenantId, async (tx) => {
      await tx
        .insertInto('conversations')
        .values({
          id,
          tenant_id: tenantId,
          created_by: userId,
          title: options.title ?? null,
          created_at: at,
          updated_at: at,
        })
        .execute();

      const row = await tx
        .insertInto('conversation_states')
        .values({
          conversation_id: id,
          tenant_id: tenantId,
          response_mode: options.responseMode ?? 'text',
          referents: JSON.stringify([]),
          updated_at: at,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      return row;
    });

    return { id, state: toState(state) };
  }

  async state(tenantId: string, conversationId: string): Promise<ConversationState> {
    const row = await withTenant(this.#db, tenantId, (tx) =>
      tx
        .selectFrom('conversation_states')
        .selectAll()
        .where('conversation_id', '=', conversationId)
        .executeTakeFirst(),
    );
    // 別テナントの会話は「無い」（AC7-10）
    if (!row) throw new GenieError('common.not_found', 'conversation not found');
    return toState(row);
  }

  /**
   * 直前の応答を打ち切る。
   *
   * **消さずに印を付ける。**消すと、何が起きたか分からなくなる。
   */
  async interruptLastAssistantTurn(tenantId: string, conversationId: string): Promise<Turn | null> {
    const row = await withTenant(this.#db, tenantId, async (tx) => {
      const last = await tx
        .selectFrom('turns')
        .selectAll()
        .where('conversation_id', '=', conversationId)
        .where('role', '=', 'assistant')
        .orderBy('id', 'desc')
        .limit(1)
        .executeTakeFirst();
      if (!last || last.interrupted) return null;

      return tx
        .updateTable('turns')
        .set({ interrupted: true })
        .where('id', '=', last.id)
        .returningAll()
        .executeTakeFirst();
    });
    return row ? toTurn(row) : null;
  }

  /**
   * SSE のリプレイ（正本 §19 `GET /v1/conversations/{id}/stream`、§20 の sequence 契約）。
   * 会話が無い / 他テナントなら state() が 404 にしてから読む。
   */
  async eventsAfter(tenantId: string, conversationId: string, after: number) {
    await this.state(tenantId, conversationId);
    return withTenant(this.#db, tenantId, (tx) =>
      readEventsAfter(tx, 'conversation', conversationId, after),
    );
  }

  async append(input: AppendTurnInput): Promise<Turn> {
    const row = await withTenant(this.#db, input.tenantId, async (tx) => {
      const inserted = await tx
        .insertInto('turns')
        .values({
          id: input.id ?? uuidv7(),
          tenant_id: input.tenantId,
          conversation_id: input.conversationId,
          role: input.role,
          modality: input.modality,
          content: JSON.stringify({ text: input.text }),
          created_at: this.#now(),
        })
        .returningAll()
        .executeTakeFirstOrThrow();

      await tx
        .updateTable('conversations')
        .set({ updated_at: this.#now() })
        .where('id', '=', input.conversationId)
        .execute();
      return inserted;
    });
    return toTurn(row);
  }

  /** 直近の turn。要約に畳んだものはここには出ない。 */
  async recentTurns(
    tenantId: string,
    conversationId: string,
    limit = RECENT_TURN_WINDOW,
  ): Promise<Turn[]> {
    const rows = await withTenant(this.#db, tenantId, (tx) =>
      tx
        .selectFrom('turns')
        .selectAll()
        .where('conversation_id', '=', conversationId)
        .orderBy('id', 'desc')
        .limit(limit)
        .execute(),
    );
    return rows.reverse().map(toTurn);
  }

  async rememberReferent(
    tenantId: string,
    conversationId: string,
    referents: readonly Referent[],
  ): Promise<void> {
    await withTenant(this.#db, tenantId, (tx) =>
      tx
        .updateTable('conversation_states')
        .set({ referents: JSON.stringify(referents), updated_at: this.#now() })
        .where('conversation_id', '=', conversationId)
        .execute(),
    );
  }

  /**
   * 直近以外を畳む。
   *
   * **捨てるのではなく畳む。**畳んだ範囲を残すので、
   * 「どこからどこまでが要約されたか」が後から分かる。
   */
  async compact(
    tenantId: string,
    conversationId: string,
    summarize: (turns: readonly Turn[]) => Promise<string>,
    window = RECENT_TURN_WINDOW,
  ): Promise<ConversationSummary | null> {
    const older = await withTenant(this.#db, tenantId, async (tx) => {
      const all = await tx
        .selectFrom('turns')
        .selectAll()
        .where('conversation_id', '=', conversationId)
        .orderBy('id', 'asc')
        .execute();
      const summarized = await tx
        .selectFrom('conversation_summaries')
        .select(['covers_to'])
        .where('conversation_id', '=', conversationId)
        .orderBy('id', 'desc')
        .limit(1)
        .executeTakeFirst();

      // 既に畳んだところの続きから
      const start = summarized ? all.findIndex((t) => t.id === summarized.covers_to) + 1 : 0;
      const candidates = all.slice(start, Math.max(start, all.length - window));
      return candidates.slice(0, COMPACTION_BATCH);
    });

    // 畳むほど溜まっていない
    if (older.length < COMPACTION_BATCH) return null;

    const turns = older.map(toTurn);
    const summary = await summarize(turns);
    if (summary.trim().length === 0) return null;

    const row = await withTenant(this.#db, tenantId, (tx) =>
      tx
        .insertInto('conversation_summaries')
        .values({
          id: uuidv7(),
          tenant_id: tenantId,
          conversation_id: conversationId,
          covers_from: turns[0]!.id,
          covers_to: turns.at(-1)!.id,
          turn_count: turns.length,
          summary: summary.trim(),
          created_at: this.#now(),
        })
        .returningAll()
        .executeTakeFirstOrThrow(),
    );

    return {
      conversation_id: conversationId,
      covers_from: row.covers_from,
      covers_to: row.covers_to,
      turn_count: row.turn_count,
      summary: row.summary,
      created_at: row.created_at.toISOString(),
    } as ConversationSummary;
  }

  async summaries(tenantId: string, conversationId: string): Promise<ConversationSummary[]> {
    const rows = await withTenant(this.#db, tenantId, (tx) =>
      tx
        .selectFrom('conversation_summaries')
        .selectAll()
        .where('conversation_id', '=', conversationId)
        .orderBy('id', 'asc')
        .execute(),
    );
    return rows.map((row) => ({
      conversation_id: row.conversation_id,
      covers_from: row.covers_from,
      covers_to: row.covers_to,
      turn_count: row.turn_count,
      summary: row.summary,
      created_at: row.created_at.toISOString(),
    })) as ConversationSummary[];
  }
}

function toState(row: Record<string, unknown>): ConversationState {
  return {
    id: row['conversation_id'],
    tenant_id: row['tenant_id'],
    active_topic: row['active_topic'] ?? null,
    active_project: row['active_project'] ?? null,
    active_person: row['active_person'] ?? null,
    active_artifact: row['active_artifact'] ?? null,
    active_task: row['active_task'] ?? null,
    active_meeting: row['active_meeting'] ?? null,
    referents: row['referents'] ?? [],
    pending_approvals: row['pending_approvals'] ?? [],
    response_mode: row['response_mode'],
    updated_at:
      row['updated_at'] instanceof Date ? row['updated_at'].toISOString() : row['updated_at'],
  } as ConversationState;
}

function toTurn(row: Record<string, unknown>): Turn {
  const content = (row['content'] ?? {}) as { text?: string };
  return {
    id: row['id'],
    conversation_id: row['conversation_id'],
    role: row['role'],
    modality: row['modality'],
    text: content.text ?? '',
    interrupted: row['interrupted'] === true,
    created_at:
      row['created_at'] instanceof Date ? row['created_at'].toISOString() : row['created_at'],
  } as Turn;
}

/** Stable hash of the parsed request including defaults; object key order is immaterial. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  if (value !== null && typeof value === 'object')
    return (
      '{' +
      Object.entries(value)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => JSON.stringify(k) + ':' + canonicalJson(v))
        .join(',') +
      '}'
    );
  return JSON.stringify(value) ?? 'null';
}
