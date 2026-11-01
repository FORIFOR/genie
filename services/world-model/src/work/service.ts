/**
 * Work Context の保存と組み立て。正本 §6・§10、Phase 6。
 *
 * 端末の worker が正規化した artifact を push し、ここは
 *   - 同じものを二度取り込まない（source + external id）
 *   - 人と案件を world_entities に寄せる（mention_count = よく出てくる人・案件）
 *   - 本人の訂正と Personalization の意思を保存する
 *   - 組み立て（推論）は純粋関数（graph.ts / personalization.ts）に任せる
 */
import {
  uuidv7,
  WORK_SYNC_SCHEMA_VERSION,
  WorkArtifact,
  type PersonalizationProfile,
  type PersonalizationUpdate,
  type WorkArtifactBatch,
  type WorkContext,
  type WorkCorrection,
  type WorkSource,
  type WorkSyncAttempt,
  type WorkSyncState,
  type MeetingBrief,
  type ReplyCandidate,
  type ReplyPack,
  type ReplyResolution,
} from '@genie/contracts';
import { withTenant, type DbHandle } from '@genie/db';
import { sql } from 'kysely';
import { buildWorkContext, clusterProjects } from './graph.js';
import { buildMeetingBrief } from './meeting-brief.js';
import { buildReplyPack, resolveReplyTarget } from './reply.js';
import {
  applyUpdate,
  deriveProfile,
  EMPTY_PERSONALIZATION,
  type StoredPersonalization,
} from './personalization.js';
import { InitialProfileService } from './initial-profile.js';
import type { WorldModelService } from '../service.js';

export interface WorkContextDeps {
  readonly db: DbHandle;
  /** 人と案件を寄せる先。無ければ寄せない（artifact の保存だけ）。 */
  readonly world?: WorldModelService;
  readonly now?: () => Date;
  /** 何日分を見るか。 */
  readonly horizonDays?: number;
}

/**
 * jsonb に入る JSON にする。途中で切られた絵文字（片割れのサロゲート）と NUL は
 * JSON.stringify が \uXXXX のまま書き出し、Postgres が拒む。1 通のために同期全体を
 * 止めないよう、その文字だけ落として保存する。
 */
function jsonbText(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    typeof v === 'string' ? v.replace(/\p{Cs}/gu, '').replaceAll('\u0000', '') : v,
  );
}

export class WorkContextService {
  readonly initialProfile: InitialProfileService;
  readonly #db: DbHandle;
  readonly #world: WorldModelService | undefined;
  readonly #now: () => Date;
  readonly #horizonDays: number;

  constructor(deps: WorkContextDeps) {
    this.#db = deps.db;
    this.#world = deps.world;
    this.#now = deps.now ?? (() => new Date());
    this.initialProfile = new InitialProfileService(deps.db, this.#now);
    this.#horizonDays = deps.horizonDays ?? 60;
  }

  /** 端末から 1 回分を取り込む。戻り値は取り込んだ件数（重複は数えない）。 */
  async ingest(
    tenantId: string,
    userId: string,
    batch: WorkArtifactBatch,
  ): Promise<{ accepted: number }> {
    const at = this.#now();
    let accepted = 0;
    await withTenant(this.#db, tenantId, async (tx) => {
      for (const raw of batch.artifacts) {
        const art = WorkArtifact.parse(raw);
        const body = jsonbText(art);
        const res = await tx
          .insertInto('work_artifacts')
          .values({
            id: art.id,
            tenant_id: tenantId,
            user_id: userId,
            source: art.source,
            kind: art.kind,
            occurred_at: new Date(art.occurred_at),
            due_at: art.due_at ? new Date(art.due_at) : null,
            thread_id: art.thread_id,
            body,
            observed_at: at,
          })
          .onConflict((oc) =>
            oc.columns(['tenant_id', 'user_id', 'id']).doUpdateSet({
              occurred_at: new Date(art.occurred_at),
              due_at: art.due_at ? new Date(art.due_at) : null,
              thread_id: art.thread_id,
              body,
              observed_at: at,
            }),
          )
          .executeTakeFirst();
        if (res.numInsertedOrUpdatedRows && res.numInsertedOrUpdatedRows > 0n) accepted += 1;
      }
      /*
       * cursor は artifact の upsert と**同じ transaction**で進む（先に書かない）。
       * batch.cursor が null なら「まだ途中」— 前の cursor を動かさない。
       * watermark は見えた occurred_at の最大で、後ろへは戻さない。
       */
      const watermark = batch.watermark ? new Date(batch.watermark) : null;
      await tx
        .insertInto('work_sync_state')
        .values({
          tenant_id: tenantId,
          user_id: userId,
          source: batch.source,
          cursor: batch.cursor,
          watermark,
          last_synced_at: at,
          last_attempt_at: at,
          last_error: null,
          artifact_count: batch.artifacts.length,
          schema_version: WORK_SYNC_SCHEMA_VERSION,
        })
        .onConflict((oc) =>
          oc.columns(['tenant_id', 'user_id', 'source']).doUpdateSet((eb) => ({
            cursor: batch.cursor ?? eb.ref('work_sync_state.cursor'),
            watermark: watermark
              ? sql<Date | null>`greatest(coalesce(${eb.ref('work_sync_state.watermark')}, ${watermark}), ${watermark})`
              : eb.ref('work_sync_state.watermark'),
            last_synced_at: at,
            last_attempt_at: at,
            last_error: null,
            artifact_count: eb('work_sync_state.artifact_count', '+', batch.artifacts.length),
            schema_version: WORK_SYNC_SCHEMA_VERSION,
          })),
        )
        .execute();
    });
    // 人と案件を寄せる（失敗しても取り込みは成立させる）。
    if (this.#world) {
      for (const art of batch.artifacts) {
        for (const p of art.people)
          await this.#world
            .observe(tenantId, 'person', p.name, { email: p.email })
            .catch(() => undefined);
        const project = art.semantic?.project ?? art.project_hint;
        if (project) await this.#world.observe(tenantId, 'project', project).catch(() => undefined);
      }
    }
    return { accepted };
  }

  async artifacts(tenantId: string, userId: string): Promise<WorkArtifact[]> {
    const since = new Date(this.#now().getTime() - this.#horizonDays * 86_400_000);
    const rows = await withTenant(this.#db, tenantId, (tx) =>
      tx
        .selectFrom('work_artifacts')
        .select(['body'])
        .where('user_id', '=', userId)
        .where('occurred_at', '>=', since)
        .orderBy('occurred_at', 'desc')
        .limit(2_000)
        .execute(),
    );
    return rows.map((r) =>
      WorkArtifact.parse(typeof r.body === 'string' ? JSON.parse(r.body) : r.body),
    );
  }

  async syncState(tenantId: string, userId: string): Promise<WorkSyncState[]> {
    const rows = await withTenant(this.#db, tenantId, (tx) =>
      tx
        .selectFrom('work_sync_state')
        .selectAll()
        .where('user_id', '=', userId)
        .orderBy('source')
        .execute(),
    );
    return rows.map((r) => ({
      source: r.source as WorkSource,
      // 正規化の版が上がっていたら、続きは無い（読み直す）。古い cursor で欠けを作らない。
      cursor: r.schema_version === WORK_SYNC_SCHEMA_VERSION ? r.cursor : null,
      watermark: r.watermark ? toIso(r.watermark) : null,
      last_synced_at: r.last_synced_at ? toIso(r.last_synced_at) : null,
      last_attempt_at: r.last_attempt_at ? toIso(r.last_attempt_at) : null,
      last_error: r.last_error,
      artifact_count: r.artifact_count,
      schema_version: r.schema_version,
    }));
  }

  /**
   * 同期の試みを残す（失敗）。**cursor は動かさない。**
   * 成功は `ingest` が記録するので、ここに来るのは読めなかった・送れなかったとき。
   */
  async recordAttempt(
    tenantId: string,
    userId: string,
    source: WorkSource,
    attempt: WorkSyncAttempt,
  ): Promise<void> {
    const at = this.#now();
    await withTenant(this.#db, tenantId, (tx) =>
      tx
        .insertInto('work_sync_state')
        .values({
          tenant_id: tenantId,
          user_id: userId,
          source,
          cursor: null,
          watermark: null,
          last_synced_at: attempt.ok ? at : null,
          last_attempt_at: at,
          last_error: attempt.ok ? null : (attempt.error ?? '理由が伝わらなかった失敗'),
          artifact_count: 0,
          schema_version: WORK_SYNC_SCHEMA_VERSION,
        })
        .onConflict((oc) =>
          oc.columns(['tenant_id', 'user_id', 'source']).doUpdateSet({
            last_attempt_at: at,
            last_error: attempt.ok ? null : (attempt.error ?? '理由が伝わらなかった失敗'),
          }),
        )
        .execute(),
    );
  }

  async corrections(tenantId: string, userId: string): Promise<WorkCorrection[]> {
    const rows = await withTenant(this.#db, tenantId, (tx) =>
      tx
        .selectFrom('work_corrections')
        .select(['item_id', 'action', 'note'])
        .where('user_id', '=', userId)
        .orderBy('created_at', 'desc')
        .limit(500)
        .execute(),
    );
    return rows.map((r) => ({
      item_id: r.item_id,
      action: r.action as WorkCorrection['action'],
      note: r.note,
    }));
  }

  /** 訂正は 1 操作。消さない（監査）。 */
  async correct(tenantId: string, userId: string, correction: WorkCorrection): Promise<void> {
    await withTenant(this.#db, tenantId, (tx) =>
      tx
        .insertInto('work_corrections')
        .values({
          id: uuidv7(),
          tenant_id: tenantId,
          user_id: userId,
          item_id: correction.item_id,
          action: correction.action,
          note: correction.note,
          created_at: this.#now(),
        })
        .execute(),
    );
  }

  async stored(tenantId: string, userId: string): Promise<StoredPersonalization> {
    const row = await withTenant(this.#db, tenantId, (tx) =>
      tx.selectFrom('work_profiles').selectAll().where('user_id', '=', userId).executeTakeFirst(),
    );
    if (!row) return EMPTY_PERSONALIZATION;
    const overrides = typeof row.overrides === 'string' ? JSON.parse(row.overrides) : row.overrides;
    return {
      inference_enabled: row.inference_enabled,
      overrides: overrides as StoredPersonalization['overrides'],
      updated_at: toIso(row.updated_at),
    };
  }

  async updateProfile(
    tenantId: string,
    userId: string,
    update: PersonalizationUpdate,
  ): Promise<PersonalizationProfile> {
    const next = applyUpdate(await this.stored(tenantId, userId), update, this.#now());
    await withTenant(this.#db, tenantId, (tx) =>
      tx
        .insertInto('work_profiles')
        .values({
          tenant_id: tenantId,
          user_id: userId,
          inference_enabled: next.inference_enabled,
          overrides: JSON.stringify(next.overrides),
          updated_at: new Date(next.updated_at),
        })
        .onConflict((oc) =>
          oc.columns(['tenant_id', 'user_id']).doUpdateSet({
            inference_enabled: next.inference_enabled,
            overrides: JSON.stringify(next.overrides),
            updated_at: new Date(next.updated_at),
          }),
        )
        .execute(),
    );
    return this.personalization(tenantId, userId);
  }

  /** Home に出す全体。追加の artifact（Genie の task / 会議）は呼び出し側が足せる。 */
  async context(
    tenantId: string,
    userId: string,
    extra: readonly WorkArtifact[] = [],
  ): Promise<WorkContext> {
    const [artifacts, corrections, stored] = await Promise.all([
      this.artifacts(tenantId, userId),
      this.corrections(tenantId, userId),
      this.stored(tenantId, userId),
    ]);
    return buildWorkContext({
      artifacts: [...artifacts, ...extra],
      corrections,
      now: this.#now(),
      inferenceEnabled: stored.inference_enabled,
    });
  }

  /** 「これ返して」の相手を決める。候補の順。曖昧なら選ばない。 */
  async resolveReply(
    tenantId: string,
    userId: string,
    input: { utterance: string; candidates: readonly ReplyCandidate[] },
    extra: readonly WorkArtifact[] = [],
  ): Promise<ReplyResolution> {
    const artifacts = [...(await this.artifacts(tenantId, userId)), ...extra];
    return resolveReplyTarget({
      utterance: input.utterance,
      candidates: input.candidates,
      artifacts,
    });
  }

  /** 返信案に添える最小の文脈。 */
  async replyPack(
    tenantId: string,
    userId: string,
    target: ReplyResolution & { status: 'resolved' },
    extra: readonly WorkArtifact[] = [],
  ): Promise<ReplyPack> {
    const artifacts = [...(await this.artifacts(tenantId, userId)), ...extra];
    const stored = await this.stored(tenantId, userId);
    const context = buildWorkContext({
      artifacts,
      corrections: await this.corrections(tenantId, userId),
      now: this.#now(),
      inferenceEnabled: stored.inference_enabled,
    });
    const profile = await this.personalization(tenantId, userId);
    return buildReplyPack({ target: target.target, artifacts, context, profile });
  }

  /** 次の会議の brief。無ければ null。 */
  async meetingBrief(
    tenantId: string,
    userId: string,
    extra: readonly WorkArtifact[] = [],
    eventId: string | null = null,
  ): Promise<MeetingBrief | null> {
    const artifacts = [...(await this.artifacts(tenantId, userId)), ...extra];
    const stored = await this.stored(tenantId, userId);
    const context = buildWorkContext({
      artifacts,
      corrections: await this.corrections(tenantId, userId),
      now: this.#now(),
      inferenceEnabled: stored.inference_enabled,
    });
    return buildMeetingBrief({ artifacts, context, now: this.#now(), eventId });
  }

  async personalization(tenantId: string, userId: string): Promise<PersonalizationProfile> {
    const [artifacts, stored] = await Promise.all([
      this.artifacts(tenantId, userId),
      this.stored(tenantId, userId),
    ]);
    const initial = await this.initialProfile.get(tenantId, userId);
    if (initial) {
      const frozen = initial.status === 'confirmed' ? initial.profile : null;
      if (!frozen)
        return {
          working_style: [],
          work_patterns: [],
          frequent_entities: [],
          inference_enabled: stored.inference_enabled,
          updated_at: initial.updated_at,
        };
      const apply = (t: PersonalizationProfile['working_style'][number]) => ({
        ...t,
        ...stored.overrides[t.key],
      });
      return {
        ...frozen,
        inference_enabled: stored.inference_enabled,
        working_style: frozen.working_style.map(apply),
        work_patterns: frozen.work_patterns.map(apply),
        frequent_entities: frozen.frequent_entities.map(apply),
      };
    }
    return deriveProfile(artifacts, stored, this.#now());
  }

  /** ある item の出所になった artifact（「出所を見る」）。 */
  async evidence(
    tenantId: string,
    userId: string,
    itemId: string,
    extra: readonly WorkArtifact[] = [],
  ): Promise<WorkArtifact[]> {
    const artifacts = [...(await this.artifacts(tenantId, userId)), ...extra];
    if (itemId.startsWith('project:')) {
      const key = itemId.slice('project:'.length);
      return clusterProjects(artifacts).find((c) => c.key === key)?.artifacts ?? [];
    }
    const id = itemId.replace(/^(owed|waiting):/, '');
    const one = artifacts.find((a) => a.id === id);
    if (!one) return [];
    return one.thread_id ? artifacts.filter((a) => a.thread_id === one.thread_id) : [one];
  }
}

function toIso(v: unknown): string {
  return v instanceof Date ? v.toISOString() : String(v);
}
