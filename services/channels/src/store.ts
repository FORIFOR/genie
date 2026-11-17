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

/** 共有スペースにしたグループ。 */
export interface ChannelGroup {
  readonly id: string;
  readonly tenantId: string;
  readonly householdId: string;
  readonly ownerUserId: string;
  /** 使い始めた人（LINE userId）。やめられるのはこの人だけ。 */
  readonly enabledBy: string;
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
  /** 会話の答え。終わったら答えの本文をそのまま送る（受付は送っていない）。 */
  readonly answerInline: boolean;
}

export type RedeemResult =
  | { readonly ok: true; readonly tenantId: string; readonly userId: string }
  | { readonly ok: false; readonly reason: 'invalid' };

/** 何度送っても届かないものは、ここで諦める（FAILED として残す）。 */
export const MAX_SEND_ATTEMPTS = 5;

/** 受けたものを処理し直す回数。超えたら dead（提供者には 200 を返し済みなので、記録だけ残す）。 */
export const MAX_INBOUND_ATTEMPTS = 5;
/** 取り出したまま進まない行を、落ちたプロセスのものとみなすまでの時間。 */
export const INBOUND_STALL_MS = 5 * 60 * 1000;

export type InboundKind = 'message' | 'action' | 'follow';

/** 受信箱から取り出した、処理待ちの 1 件（本文は封じたまま）。 */
export interface QueuedInbound {
  readonly provider: ChannelProvider;
  readonly eventId: string;
  readonly kind: InboundKind;
  readonly lane: string;
  readonly payload: string;
  readonly attempts: number;
}

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

  /**
   * 受けたものを、処理する前に保存する（封じた本文ごと）。初めての配信なら true。
   * **true を返してから提供者に 200 を返す。**落ちても、次の見回りで続きから処理できる。
   */
  async enqueueInbound(input: {
    provider: ChannelProvider;
    eventId: string;
    kind: InboundKind;
    lane: string;
    payload: string;
    /**
     * 「同じ発言か」の鍵（Slack の message と app_mention）。配信の保存と**同じトランザクション**で
     * 押さえる。別々にすると、押さえる前に取り出されて二度仕事になる。
     */
    sameKey?: string;
  }): Promise<boolean> {
    return withIdentity(this.db, async (tx) => {
      const eventId = input.eventId.slice(0, 256);
      const row = await tx
        .insertInto('channel_inbox')
        .values({
          provider: input.provider,
          event_id: eventId,
          status: 'pending',
          kind: input.kind,
          lane: input.lane.slice(0, 400),
          payload: input.payload,
        })
        .onConflict((oc) => oc.columns(['provider', 'event_id']).doNothing())
        .returning('event_id')
        .executeTakeFirst();
      if (!row) return false;
      if (input.sameKey) {
        const same = await tx
          .insertInto('channel_inbox')
          .values({ provider: input.provider, event_id: input.sameKey.slice(0, 256) })
          .onConflict((oc) => oc.columns(['provider', 'event_id']).doNothing())
          .returning('event_id')
          .executeTakeFirst();
        if (!same) {
          await tx
            .updateTable('channel_inbox')
            .set({ status: 'done', payload: null, last_error: 'same_message' })
            .where('provider', '=', input.provider)
            .where('event_id', '=', eventId)
            .execute();
          return false;
        }
      }
      return true;
    });
  }

  /**
   * 処理待ちを取り出す。**複数のプロセスが同時に呼んでも、1 件は 1 つにしか渡らない**（SKIP LOCKED）。
   * 失敗して待っているものは、回数に応じて間をあけてから（2 秒 × 2^回数、最大 2 分）。
   * 取り出したまま止まった行（processing）は、持ち主が落ちたとみなして取り直す。
   */
  async claimInbound(limit = 20): Promise<QueuedInbound[]> {
    return withIdentity(this.db, async (tx) => {
      const rows = await sql<{
        provider: string;
        event_id: string;
        kind: string;
        lane: string;
        payload: string;
        attempts: number;
      }>`
        update channel_inbox i
           set status = 'processing', claimed_at = now(), attempts = i.attempts + 1
         where (i.provider, i.event_id) in (
           select provider, event_id from channel_inbox
            where payload is not null
              and ((status = 'pending'
                    and (claimed_at is null
                         or claimed_at < now() - least(2000 * power(2, attempts), 120000) * interval '1 millisecond'))
                or (status = 'processing'
                    and claimed_at < now() - ${INBOUND_STALL_MS} * interval '1 millisecond'))
            order by received_at
            limit ${limit}
            for update skip locked)
        returning i.provider, i.event_id, i.kind, i.lane, i.payload, i.attempts
      `.execute(tx);
      return rows.rows.map((r) => ({
        provider: r.provider as ChannelProvider,
        eventId: r.event_id,
        kind: r.kind as InboundKind,
        lane: r.lane,
        payload: r.payload,
        attempts: r.attempts,
      }));
    });
  }

  /**
   * handleTurn を呼ぶ直前の印。**ここから先で落ちたものは、やり直さない**（仕事が二つになる）。
   * 次の見回りで「途中で止まった」と本人に伝える。
   */
  async markInboundTurning(provider: ChannelProvider, eventId: string): Promise<void> {
    await withIdentity(this.db, (tx) =>
      tx
        .updateTable('channel_inbox')
        .set({ status: 'turning', claimed_at: sql`now()` })
        .where('provider', '=', provider)
        .where('event_id', '=', eventId)
        .execute(),
    );
  }

  /** 終わった（done）か、諦めた（dead）。**本文はここで消す。** */
  async finishInbound(
    provider: ChannelProvider,
    eventId: string,
    status: 'done' | 'dead',
    error: string | null = null,
  ): Promise<void> {
    await withIdentity(this.db, (tx) =>
      tx
        .updateTable('channel_inbox')
        .set({ status, payload: null, last_error: error?.slice(0, 200) ?? null })
        .where('provider', '=', provider)
        .where('event_id', '=', eventId)
        .execute(),
    );
  }

  /** 失敗した。回数が残っていれば待ち行列に戻す（間をあけて取り直す）。 */
  async retryInbound(provider: ChannelProvider, eventId: string, error: string): Promise<void> {
    await withIdentity(this.db, (tx) =>
      tx
        .updateTable('channel_inbox')
        .set({ status: 'pending', claimed_at: sql`now()`, last_error: error.slice(0, 200) })
        .where('provider', '=', provider)
        .where('event_id', '=', eventId)
        .execute(),
    );
  }

  /** handleTurn の途中で止まったもの（turning のまま時間が過ぎた）。本人に伝えてから dead にする。 */
  async interruptedInbound(limit = 20): Promise<QueuedInbound[]> {
    return withIdentity(this.db, async (tx) => {
      const rows = await tx
        .selectFrom('channel_inbox')
        .select(['provider', 'event_id', 'kind', 'lane', 'payload', 'attempts'])
        .where('status', '=', 'turning')
        .where('payload', 'is not', null)
        .where('claimed_at', '<', sql<Date>`now() - ${INBOUND_STALL_MS} * interval '1 millisecond'`)
        .orderBy('received_at')
        .limit(limit)
        .execute();
      return rows.map((r) => ({
        provider: r.provider as ChannelProvider,
        eventId: r.event_id,
        kind: (r.kind ?? 'message') as InboundKind,
        lane: r.lane ?? '',
        payload: r.payload ?? '',
        attempts: r.attempts,
      }));
    });
  }

  /** 再送の窓（数分）を過ぎた受信箱の行を消す。処理中のもの（本文あり）は残す。 */
  async pruneInbox(olderThanMs = 24 * 60 * 60 * 1000): Promise<void> {
    await withIdentity(this.db, (tx) =>
      tx
        .deleteFrom('channel_inbox')
        .where('received_at', '<', new Date(Date.now() - olderThanMs))
        .where('status', 'in', ['done', 'dead'])
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

  /**
   * 有効な LINE の連携。subject（LINE の利用者 ID）を渡せばその人だけ、null なら全部。
   * 公式アカウントへの電話（管理画面で受けたもの）を、かけた人の Genie につなぐために引く。
   */
  async lineLinks(subject: string | null): Promise<ChannelLink[]> {
    return withIdentity(this.db, async (tx) => {
      let query = tx
        .selectFrom('channel_links')
        .selectAll()
        .where('provider', '=', 'line')
        .where('revoked_at', 'is', null);
      if (subject) query = query.where('subject', '=', subject);
      return (await query.limit(2).execute()).map(toLink);
    });
  }

  /** LINE のグループ → 共有スペース。受信時はテナントが分からないので astra_identity で引く。 */
  async findGroup(
    provider: ChannelProvider,
    workspaceId: string,
    groupId: string,
  ): Promise<ChannelGroup | null> {
    return withIdentity(this.db, async (tx) => {
      const row = await tx
        .selectFrom('channel_groups')
        .select(['id', 'tenant_id', 'household_id', 'owner_user_id', 'enabled_by'])
        .where('provider', '=', provider)
        .where('workspace_id', '=', workspaceId)
        .where('group_id', '=', groupId)
        .where('revoked_at', 'is', null)
        .executeTakeFirst();
      return row
        ? {
            id: row.id,
            tenantId: row.tenant_id,
            householdId: row.household_id,
            ownerUserId: row.owner_user_id,
            enabledBy: row.enabled_by,
          }
        : null;
    });
  }

  /**
   * 止められた（「@Genie このグループをやめる」）グループ。招き直しでは勝手に再開しないために引く。
   * 使っている行があるときは呼ばない（呼び手が findGroup を先に見る）。
   */
  async stoppedGroup(
    provider: ChannelProvider,
    workspaceId: string,
    groupId: string,
  ): Promise<ChannelGroup | null> {
    return withIdentity(this.db, async (tx) => {
      const row = await tx
        .selectFrom('channel_groups')
        .select(['id', 'tenant_id', 'household_id', 'owner_user_id', 'enabled_by'])
        .where('provider', '=', provider)
        .where('workspace_id', '=', workspaceId)
        .where('group_id', '=', groupId)
        .where('revoked_at', 'is not', null)
        .orderBy('revoked_at', 'desc')
        .executeTakeFirst();
      return row
        ? {
            id: row.id,
            tenantId: row.tenant_id,
            householdId: row.household_id,
            ownerUserId: row.owner_user_id,
            enabledBy: row.enabled_by,
          }
        : null;
    });
  }

  /**
   * この公式アカウントにつないでいる人が 1 人だけなら、その人（グループに招かれたときの持ち主）。
   * 0 人・2 人以上なら null（そのグループで連携済みの人が話したときに決める）。
   */
  async soleLink(provider: ChannelProvider, workspaceId: string): Promise<ChannelLink | null> {
    return withIdentity(this.db, async (tx) => {
      const rows = await tx
        .selectFrom('channel_links')
        .selectAll()
        .where('provider', '=', provider)
        .where('workspace_id', '=', workspaceId)
        .where('revoked_at', 'is', null)
        .limit(2)
        .execute();
      return rows.length === 1 ? toLink(rows[0]!) : null;
    });
  }

  /** グループを共有スペースにする（持ち主のテナントの中で書く）。 */
  async createGroup(input: {
    tenantId: string;
    householdId: string;
    ownerUserId: string;
    provider: ChannelProvider;
    workspaceId: string;
    groupId: string;
    enabledBy: string;
  }): Promise<void> {
    await withTenant(this.db, input.tenantId, (tx) =>
      tx
        .insertInto('channel_groups')
        .values({
          id: uuidv7(),
          tenant_id: input.tenantId,
          household_id: input.householdId,
          owner_user_id: input.ownerUserId,
          provider: input.provider as 'line',
          workspace_id: input.workspaceId,
          group_id: input.groupId,
          enabled_by: input.enabledBy,
        })
        .execute(),
    );
  }

  async revokeGroup(tenantId: string, id: string): Promise<void> {
    await withTenant(this.db, tenantId, (tx) =>
      tx
        .updateTable('channel_groups')
        .set({ revoked_at: new Date() })
        .where('id', '=', id)
        .execute(),
    );
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

  /** 会話 → チャットのスレッド（予約の結果をチャットへ返すため）。チャットの会話でなければ null。 */
  async threadForConversation(
    tenantId: string,
    conversationId: string,
  ): Promise<{ link: ChannelLink; destination: string; threadKey: string } | null> {
    return withTenant(this.db, tenantId, async (tx) => {
      const row = await tx
        .selectFrom('channel_threads as t')
        .innerJoin('channel_links as l', 'l.id', 't.link_id')
        .selectAll('l')
        .select(['t.destination', 't.thread_key'])
        .where('t.conversation_id', '=', conversationId)
        .where('l.revoked_at', 'is', null)
        .orderBy('t.last_message_at', 'desc')
        .executeTakeFirst();
      return row
        ? { link: toLink(row), destination: row.destination, threadKey: row.thread_key }
        : null;
    });
  }

  /**
   * その会話のトークで、Genie が最後に送った答え（受付・承認待ちではなく、答えや知らせの本文）。
   * 「さっきの結果をグループに送って」の「さっきの結果」に使う。
   */
  async lastSaid(tenantId: string, conversationId: string): Promise<string | null> {
    const thread = await this.threadForConversation(tenantId, conversationId);
    if (!thread) return null;
    return withTenant(this.db, tenantId, async (tx) => {
      const row = await tx
        .selectFrom('channel_outbox')
        .select('body')
        .where('link_id', '=', thread.link.id)
        .where('thread_key', '=', thread.threadKey)
        .where('status', '=', 'SENT')
        .where('kind', 'in', ['completed', 'notice'])
        .orderBy('created_at', 'desc')
        .executeTakeFirst();
      const body = row?.body as { text?: unknown; link?: unknown } | undefined;
      // 通話のリンクのような、開くだけの知らせは「結果」ではない
      return body && typeof body.text === 'string' && !body.link ? body.text : null;
    });
  }

  /** 本人が使い始めた LINE のグループ（共有スペース）。新しい順。 */
  async groupsForOwner(
    tenantId: string,
    ownerUserId: string,
  ): Promise<{ id: string; groupId: string; householdId: string; provider: ChannelProvider }[]> {
    return withTenant(this.db, tenantId, async (tx) => {
      const rows = await tx
        .selectFrom('channel_groups')
        .select(['id', 'group_id', 'household_id', 'provider'])
        .where('owner_user_id', '=', ownerUserId)
        .where('revoked_at', 'is', null)
        .orderBy('created_at', 'desc')
        .execute();
      return rows.map((r) => ({
        id: r.id,
        groupId: r.group_id,
        householdId: r.household_id,
        provider: r.provider as ChannelProvider,
      }));
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
    /** 会話の答えとして見回る（受付の行だけに付ける）。 */
    answerInline?: boolean;
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
          answer_inline: input.answerInline ?? false,
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
        answer_inline: boolean;
      }>`
        select o.task_id, o.link_id, l.provider, o.destination, o.thread_key, l.posting_policy,
               o.answer_inline,
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
        answerInline: r.answer_inline,
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
        // DB の時計で比べる（書くときも now() で入れている。ホストと DB の時計はずれうる）
        .where('o.next_attempt_at', '<=', sql<Date>`now()`)
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

  /**
   * 失敗を記録する。直らない失敗か、回数を使い切ったら FAILED（もう送らない）。
   * 送り直すときは間をあける: 提供者の Retry-After か、5 秒 × 2^回数（最大 10 分）の長い方。
   */
  async markFailed(
    tenantId: string,
    id: string,
    error: string,
    retryable: boolean,
    retryAfterMs: number | null = null,
  ): Promise<void> {
    const after = retryAfterMs ?? 0;
    await withTenant(this.db, tenantId, (tx) =>
      tx
        .updateTable('channel_outbox')
        .set({
          attempts: sql`attempts + 1`,
          last_error: error.slice(0, 200),
          status: retryable
            ? sql`case when attempts + 1 >= ${MAX_SEND_ATTEMPTS} then 'FAILED' else 'PENDING' end`
            : 'FAILED',
          next_attempt_at: sql`now() + greatest(${after}, least(5000 * power(2, attempts), 600000)) * interval '1 millisecond'`,
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
