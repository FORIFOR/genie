/**
 * チャネル連携の記録（channel_* テーブル）。
 *
 * 受信した時点ではテナントが分からない。だから**受信箱・連携の照合・コードの引き換え**だけは
 * astra_identity（必要な表に必要な操作だけ GRANT 済み）で引き、テナントが決まってからの
 * 読み書きは withTenant（RLS）で行う。
 */
import { uuidv7, type ChannelProvider } from '@genie/contracts';
import { withIdentity, withTenant, type DbHandle } from '@genie/db';
import { appendAuditEvent } from '@genie/telemetry';
import { sql } from 'kysely';
import { hashLinkCode, LINK_CODE_TTL_MS, newLinkCode } from './tokens.js';
import type { OutgoingMessage } from './send.js';
import type { PostingPolicy } from './render.js';

export interface ChannelLink {
  readonly id: string;
  readonly tenantId: string;
  readonly userId: string;
  readonly deviceId: string;
  readonly provider: ChannelProvider;
  readonly workspaceId: string;
  readonly subject: string;
  readonly postingPolicy: PostingPolicy;
}

export type OutboxKind =
  'accepted' | 'waiting_approval' | 'paused' | 'completed' | 'failed' | 'cancelled' | 'notice';

export interface OutboxRow {
  readonly id: string;
  readonly tenantId: string;
  readonly linkId: string;
  readonly provider: ChannelProvider;
  readonly destination: string;
  readonly threadKey: string;
  readonly kind: OutboxKind;
  readonly body: OutgoingMessage;
  readonly attempts: number;
}

export interface WatchedTask {
  readonly taskId: string;
  readonly linkId: string;
  readonly provider: ChannelProvider;
  readonly destination: string;
  readonly threadKey: string;
  readonly postingPolicy: PostingPolicy;
  /** チャットへ送ったところまでの task_events の sequence（受付は 0）。 */
  readonly lastSequence: number;
}

export type RedeemResult =
  | { readonly ok: true; readonly tenantId: string; readonly userId: string }
  | { readonly ok: false; readonly reason: 'invalid' };

/** 何度送っても届かないものは、ここで諦める（FAILED として残す）。 */
export const MAX_SEND_ATTEMPTS = 5;

const TERMINAL_KINDS = ['completed', 'failed', 'cancelled'] as const;

export class ChannelStore {
  constructor(private readonly db: DbHandle) {}

  /** 初めての配信なら true。**判定と記録は 1 文**（取り合いで両方 true にならない）。 */
  async claimInbox(provider: ChannelProvider, eventId: string): Promise<boolean> {
    return withIdentity(this.db, async (tx) => {
      const row = await tx
        .insertInto('channel_inbox')
        .values({ provider, event_id: eventId.slice(0, 256) })
        .onConflict((oc) => oc.columns(['provider', 'event_id']).doNothing())
        .returning('event_id')
        .executeTakeFirst();
      return row !== undefined;
    });
  }

  /** 再送の窓（数分）を過ぎた受信箱の行を消す。 */
  async pruneInbox(olderThanMs = 24 * 60 * 60 * 1000): Promise<void> {
    await withIdentity(this.db, (tx) =>
      tx
        .deleteFrom('channel_inbox')
        .where('received_at', '<', new Date(Date.now() - olderThanMs))
        .execute(),
    );
  }

  /** 有効な連携。無ければ null（連携の促しを返す）。 */
  async findLink(
    provider: ChannelProvider,
    workspaceId: string,
    subject: string,
  ): Promise<ChannelLink | null> {
    return withIdentity(this.db, async (tx) => {
      const row = await tx
        .selectFrom('channel_links')
        .selectAll()
        .where('provider', '=', provider)
        .where('workspace_id', '=', workspaceId)
        .where('subject', '=', subject)
        .where('revoked_at', 'is', null)
        .executeTakeFirst();
      if (!row) return null;
      await tx
        .updateTable('channel_links')
        .set({ last_seen_at: new Date() })
        .where('id', '=', row.id)
        .execute();
      return toLink(row);
    });
  }

  /** 本人が Genie の中で出すコード。平文は返すだけで、残すのはハッシュ。 */
  async issueLinkCode(
    tenantId: string,
    userId: string,
    provider: ChannelProvider,
  ): Promise<{ code: string; expiresAt: Date }> {
    const code = newLinkCode();
    const expiresAt = new Date(Date.now() + LINK_CODE_TTL_MS);
    await withTenant(this.db, tenantId, (tx) =>
      tx
        .insertInto('channel_link_codes')
        .values({
          code_hash: hashLinkCode(code),
          tenant_id: tenantId,
          user_id: userId,
          provider,
          expires_at: expiresAt,
        })
        .execute(),
    );
    return { code, expiresAt };
  }

  /** コードを使う。**期限内・未使用・同じ提供者**のものだけ。使ったら二度と通らない。 */
  async redeemLinkCode(provider: ChannelProvider, code: string): Promise<RedeemResult> {
    return withIdentity(this.db, async (tx) => {
      const row = await tx
        .updateTable('channel_link_codes')
        .set({ used_at: new Date() })
        .where('code_hash', '=', hashLinkCode(code))
        .where('provider', '=', provider)
        .where('used_at', 'is', null)
        .where('expires_at', '>', new Date())
        .returning(['tenant_id', 'user_id'])
        .executeTakeFirst();
      return row
        ? { ok: true, tenantId: row.tenant_id, userId: row.user_id }
        : { ok: false, reason: 'invalid' };
    });
  }

  /** 連携を作る。外の 1 人に有効な連携は 1 つだけ（一意索引が守る）。 */
  async createLink(input: {
    tenantId: string;
    userId: string;
    deviceId: string;
    provider: ChannelProvider;
    workspaceId: string;
    subject: string;
  }): Promise<ChannelLink | null> {
    return withTenant(this.db, input.tenantId, async (tx) => {
      const id = uuidv7();
      const row = await tx
        .insertInto('channel_links')
        .values({
          id,
          tenant_id: input.tenantId,
          user_id: input.userId,
          device_id: input.deviceId,
          provider: input.provider,
          workspace_id: input.workspaceId,
          subject: input.subject,
        })
        .onConflict((oc) =>
          oc
            .columns(['provider', 'workspace_id', 'subject'])
            .where('revoked_at', 'is', null)
            .doNothing(),
        )
        .returningAll()
        .executeTakeFirst();
      if (!row) return null;
      await appendAuditEvent(tx, input.tenantId, {
        actorType: 'user',
        actorId: input.userId,
        action: 'channel.linked',
        payload: { link_id: id, provider: input.provider },
      });
      return toLink(row);
    });
  }

  async listLinks(
    tenantId: string,
    userId: string,
  ): Promise<(ChannelLink & { createdAt: string; lastSeenAt: string | null })[]> {
    return withTenant(this.db, tenantId, async (tx) => {
      const rows = await tx
        .selectFrom('channel_links')
        .selectAll()
        .where('user_id', '=', userId)
        .where('revoked_at', 'is', null)
        .orderBy('created_at', 'desc')
        .execute();
      return rows.map((r) => ({
        ...toLink(r),
        createdAt: r.created_at.toISOString(),
        lastSeenAt: r.last_seen_at?.toISOString() ?? null,
      }));
    });
  }

  /** 連携を切る。本人のものだけ。切ったら受信も送信もしない（outbox の残りも捨てる）。 */
  async revokeLink(tenantId: string, userId: string, linkId: string): Promise<ChannelLink | null> {
    return withTenant(this.db, tenantId, async (tx) => {
      const row = await tx
        .updateTable('channel_links')
        .set({ revoked_at: new Date() })
        .where('id', '=', linkId)
        .where('user_id', '=', userId)
        .where('revoked_at', 'is', null)
        .returningAll()
        .executeTakeFirst();
      if (!row) return null;
      await tx
        .updateTable('channel_outbox')
        .set({ status: 'FAILED', last_error: 'link_revoked' })
        .where('link_id', '=', linkId)
        .where('status', '=', 'PENDING')
        .execute();
      await appendAuditEvent(tx, tenantId, {
        actorType: 'user',
        actorId: userId,
        action: 'channel.unlinked',
        payload: { link_id: linkId, provider: row.provider },
      });
      return toLink(row);
    });
  }

  async setPostingPolicy(
    tenantId: string,
    userId: string,
    linkId: string,
    policy: PostingPolicy,
  ): Promise<boolean> {
    return withTenant(this.db, tenantId, async (tx) => {
      const result = await tx
        .updateTable('channel_links')
        .set({ posting_policy: policy })
        .where('id', '=', linkId)
        .where('user_id', '=', userId)
        .where('revoked_at', 'is', null)
        .executeTakeFirst();
      return Number(result.numUpdatedRows) > 0;
    });
  }

  /** スレッド → 会話。無ければ `start` で会話を作って結ぶ（同時に来ても 1 つに収まる）。 */
  async conversationFor(
    link: ChannelLink,
    threadKey: string,
    destination: string,
    start: () => Promise<string>,
  ): Promise<string> {
    const existing = await withTenant(this.db, link.tenantId, async (tx) => {
      const row = await tx
        .selectFrom('channel_threads')
        .select('conversation_id')
        .where('link_id', '=', link.id)
        .where('thread_key', '=', threadKey)
        .executeTakeFirst();
      if (row) {
        await tx
          .updateTable('channel_threads')
          .set({ last_message_at: new Date() })
          .where('link_id', '=', link.id)
          .where('thread_key', '=', threadKey)
          .execute();
      }
      return row?.conversation_id ?? null;
    });
    if (existing) return existing;
    const conversationId = await start();
    return withTenant(this.db, link.tenantId, async (tx) => {
      await tx
        .insertInto('channel_threads')
        .values({
          tenant_id: link.tenantId,
          link_id: link.id,
          thread_key: threadKey,
          destination,
          conversation_id: conversationId,
        })
        .onConflict((oc) => oc.columns(['link_id', 'thread_key']).doNothing())
        .execute();
      const row = await tx
        .selectFrom('channel_threads')
        .select('conversation_id')
        .where('link_id', '=', link.id)
        .where('thread_key', '=', threadKey)
        .executeTakeFirstOrThrow();
      return row.conversation_id;
    });
  }

  /** 送るものを積む。task のイベント 1 つにつき 1 行（一意索引）。積めたら id を返す。 */
  async enqueue(input: {
    tenantId: string;
    linkId: string;
    taskId: string | null;
    eventSequence: number | null;
    kind: OutboxKind;
    destination: string;
    threadKey: string;
    body: OutgoingMessage;
  }): Promise<string | null> {
    return withTenant(this.db, input.tenantId, async (tx) => {
      const id = uuidv7();
      const row = await tx
        .insertInto('channel_outbox')
        .values({
          id,
          tenant_id: input.tenantId,
          link_id: input.linkId,
          task_id: input.taskId,
          event_sequence: input.eventSequence === null ? null : String(input.eventSequence),
          kind: input.kind,
          destination: input.destination,
          thread_key: input.threadKey,
          body: JSON.stringify(input.body),
        })
        .onConflict((oc) =>
          oc
            .columns(['link_id', 'task_id', 'event_sequence'])
            .where('task_id', 'is not', null)
            .where('event_sequence', 'is not', null)
            .doNothing(),
        )
        .returning('id')
        .executeTakeFirst();
      return row?.id ?? null;
    });
  }

  /** 連携が 1 つでもあるテナント。送信の見回りはテナントごとに RLS の中で行う。 */
  async tenantsWithLinks(): Promise<string[]> {
    return withIdentity(this.db, async (tx) => {
      const rows = await tx
        .selectFrom('channel_links')
        .select('tenant_id')
        .distinct()
        .where('revoked_at', 'is', null)
        .execute();
      return rows.map((r) => r.tenant_id);
    });
  }

  /** 受け付けて、まだ終わりを知らせていない task。 */
  async watchedTasks(tenantId: string): Promise<WatchedTask[]> {
    return withTenant(this.db, tenantId, async (tx) => {
      const rows = await sql<{
        task_id: string;
        link_id: string;
        provider: string;
        destination: string;
        thread_key: string;
        posting_policy: string;
        last_sequence: string;
      }>`
        select o.task_id, o.link_id, l.provider, o.destination, o.thread_key, l.posting_policy,
               (select coalesce(max(x.event_sequence), 0) from channel_outbox x
                 where x.link_id = o.link_id and x.task_id = o.task_id)::text as last_sequence
          from channel_outbox o
          join channel_links l on l.id = o.link_id
         where o.kind = 'accepted'
           and o.task_id is not null
           and l.revoked_at is null
           and not exists (
             select 1 from channel_outbox t
              where t.link_id = o.link_id and t.task_id = o.task_id
                and t.kind in (${sql.join(TERMINAL_KINDS.map((k) => sql`${k}`))}))
         order by o.created_at
         limit 200
      `.execute(tx);
      return rows.rows.map((r) => ({
        taskId: r.task_id,
        linkId: r.link_id,
        provider: r.provider as ChannelProvider,
        destination: r.destination,
        threadKey: r.thread_key,
        postingPolicy: r.posting_policy as PostingPolicy,
        lastSequence: Number(r.last_sequence),
      }));
    });
  }

  async pending(tenantId: string): Promise<OutboxRow[]> {
    return withTenant(this.db, tenantId, async (tx) => {
      const rows = await tx
        .selectFrom('channel_outbox as o')
        .innerJoin('channel_links as l', 'l.id', 'o.link_id')
        .select([
          'o.id',
          'o.tenant_id',
          'o.link_id',
          'l.provider',
          'o.destination',
          'o.thread_key',
          'o.kind',
          'o.body',
          'o.attempts',
        ])
        .where('o.status', '=', 'PENDING')
        .where('l.revoked_at', 'is', null)
        .orderBy('o.created_at')
        .limit(100)
        .execute();
      return rows.map((r) => ({
        id: r.id,
        tenantId: r.tenant_id,
        linkId: r.link_id,
        provider: r.provider as ChannelProvider,
        destination: r.destination,
        threadKey: r.thread_key,
        kind: r.kind as OutboxKind,
        body: (typeof r.body === 'string' ? JSON.parse(r.body) : r.body) as OutgoingMessage,
        attempts: r.attempts,
      }));
    });
  }

  async markSent(tenantId: string, id: string, providerMessageId: string | null): Promise<void> {
    await withTenant(this.db, tenantId, (tx) =>
      tx
        .updateTable('channel_outbox')
        .set({
          status: 'SENT',
          sent_at: new Date(),
          provider_message_id: providerMessageId,
          attempts: sql`attempts + 1`,
        })
        .where('id', '=', id)
        .execute(),
    );
  }

  /** 失敗を記録する。直らない失敗か、回数を使い切ったら FAILED（もう送らない）。 */
  async markFailed(tenantId: string, id: string, error: string, retryable: boolean): Promise<void> {
    await withTenant(this.db, tenantId, (tx) =>
      tx
        .updateTable('channel_outbox')
        .set({
          attempts: sql`attempts + 1`,
          last_error: error.slice(0, 200),
          status: retryable
            ? sql`case when attempts + 1 >= ${MAX_SEND_ATTEMPTS} then 'FAILED' else 'PENDING' end`
            : 'FAILED',
        })
        .where('id', '=', id)
        .execute(),
    );
  }

  /** チャットからの承認を監査に残す（どの連携から、どちらの答えか）。 */
  async auditApproval(
    link: ChannelLink,
    taskId: string,
    approvalId: string,
    decision: string,
  ): Promise<void> {
    await withTenant(this.db, link.tenantId, (tx) =>
      appendAuditEvent(tx, link.tenantId, {
        actorType: 'user',
        actorId: link.userId,
        action: 'channel.approval_relayed',
        taskId,
        payload: { link_id: link.id, provider: link.provider, approval_id: approvalId, decision },
      }),
    );
  }
}

function toLink(row: {
  id: string;
  tenant_id: string;
  user_id: string;
  device_id: string;
  provider: string;
  workspace_id: string;
  subject: string;
  posting_policy: string;
}): ChannelLink {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    userId: row.user_id,
    deviceId: row.device_id,
    provider: row.provider as ChannelProvider,
    workspaceId: row.workspace_id,
    subject: row.subject,
    postingPolicy: row.posting_policy === 'full_text' ? 'full_text' : 'summary_and_link',
  };
}
