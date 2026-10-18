import { createHash } from 'node:crypto';
import { sql } from 'kysely';
import { withTenant, type DbHandle } from '@genie/db';
import {
  InitialProfile,
  InitialProfileAnalysis,
  type InitialProfileOutcome,
  type InitialProfileSections,
  WorkArtifact,
  type WorkArtifactBatch,
  uuidv7,
  type PersonalizationProfile,
  type PersonalizationTrait,
} from '@genie/contracts';
import { personKey } from './graph.js';
import { wallClock } from './business-time.js';

// Provider titles may exceed the editable profile's 200-character limit.
const summaryText = (value: string): string => {
  let result = '';
  for (const character of value.trim()) {
    if (result.length + character.length > 200) break;
    result += character;
  }
  return result.trim();
};

const DAY = 86_400_000;
// These are exclusion hints, never evidence that an unmarked sender is a person.
const AUTOMATED_ADDRESS =
  /(?:^|[._+-])(?:no-?reply|do-?not-?reply|notifications?|newsletters?|mailer-daemon|postmaster|automated)(?:[._+-]|@|$)/i;
const BULK_TITLE =
  /(?:メルマガ|メールマガジン|配信停止|自動配信|自動通知|ニュースレター|newsletter|unsubscribe|\bweekly digest\b|\bdaily digest\b|\bspecial offer\b|\bverification code\b|認証コード|ワンタイムパスワード)/i;

function usableMail(a: WorkArtifact): boolean {
  return (
    isMail(a) &&
    !BULK_TITLE.test(a.title) &&
    !a.people.some((p) => p.role === 'from' && AUTOMATED_ADDRESS.test(p.email ?? ''))
  );
}

function isMail(a: WorkArtifact): boolean {
  return a.kind === 'email' && (a.source === 'gmail' || a.source === 'outlook_mail');
}

/** Source ownership and coverage are checked at the server boundary, not trusted to the model. */
function validAnalysis(
  artifacts: readonly WorkArtifact[],
  analysis: InitialProfileAnalysis,
): boolean {
  const parsed = InitialProfileAnalysis.safeParse(analysis);
  if (!parsed.success) return false;
  const mail = new Map(artifacts.filter(isMail).map((a) => [a.id, a]));
  const analyzed = new Set(analysis.analyzed_ids);
  const excluded = new Set(analysis.excluded_ids);
  if (
    analyzed.size !== analysis.analyzed_ids.length ||
    excluded.size !== analysis.excluded_ids.length ||
    analysis.analyzed_count !== analyzed.size ||
    analysis.selected_count < analyzed.size ||
    analysis.selected_count > mail.size ||
    [...analyzed].some((id) => !mail.has(id)) ||
    [...excluded].some((id) => !analyzed.has(id))
  )
    return false;
  const claims = [...analysis.focus, ...analysis.priorities, ...analysis.open_items];
  if (analysis.status === 'unavailable') {
    return analyzed.size === 0 && excluded.size === 0 && claims.length === 0;
  }
  if (analysis.status === 'complete' && analysis.selected_count === 0) {
    return analyzed.size === 0 && excluded.size === 0 && claims.length === 0;
  }
  if (
    analyzed.size === 0 ||
    (analysis.status === 'complete' && analyzed.size !== analysis.selected_count) ||
    (analysis.status === 'partial' && analyzed.size >= analysis.selected_count)
  )
    return false;
  return (
    claims.every(
      (claim) =>
        new Set(claim.source_ids).size === claim.source_ids.length &&
        claim.source_ids.every((id) => analyzed.has(id) && !excluded.has(id)),
    ) &&
    [analysis.focus, analysis.priorities, analysis.open_items].every((group) => {
      const fingerprints = group.map((claim) =>
        JSON.stringify([claim.text.trim().replace(/\s+/gu, ' '), [...claim.source_ids].sort()]),
      );
      return new Set(fingerprints).size === group.length;
    })
  );
}

function initialPeople(
  artifacts: readonly WorkArtifact[],
  now: Date,
  excluded: ReadonlySet<string>,
) {
  const mail = [...new Map(artifacts.filter(isMail).map((a) => [a.id, a])).values()].filter(
    (a) =>
      Date.parse(a.occurred_at) <= now.getTime() &&
      Date.parse(a.occurred_at) >= now.getTime() - 90 * DAY,
  );
  const self = new Set(
    mail
      .filter((a) => a.direction === 'outbound')
      .flatMap((a) => a.people.filter((p) => p.role === 'from').map(personKey)),
  );
  const people = new Map<
    string,
    { key: string; name: string; inbound: number; outbound: number; artifacts: WorkArtifact[] }
  >();
  for (const a of mail) {
    if (excluded.has(a.id) || !usableMail(a) || a.direction === 'self') continue;
    const seen = new Set<string>();
    for (const p of a.people) {
      if (p.role !== (a.direction === 'inbound' ? 'from' : 'to')) continue;
      const key = personKey(p);
      if (self.has(key) || seen.has(key) || AUTOMATED_ADDRESS.test(p.email ?? '')) continue;
      seen.add(key);
      const entry = people.get(key) ?? {
        key,
        name: p.name,
        inbound: 0,
        outbound: 0,
        artifacts: [],
      };
      entry[a.direction] += 1;
      entry.artifacts.push(a);
      people.set(key, entry);
    }
  }
  const reciprocal = (p: { inbound: number; outbound: number }) =>
    Number(p.inbound > 0 && p.outbound > 0);
  return [...people.values()]
    .filter((p) => reciprocal(p) || p.outbound >= 2)
    .sort(
      (a, b) =>
        reciprocal(b) - reciprocal(a) ||
        b.outbound - a.outbound ||
        b.inbound - a.inbound ||
        a.key.localeCompare(b.key),
    )
    .slice(0, 12);
}

function observedPatterns(artifacts: readonly WorkArtifact[], now: Date): PersonalizationTrait[] {
  const events = [...new Map(artifacts.map((a) => [a.id, a])).values()].filter((a) => {
    const start = Date.parse(a.occurred_at),
      end = Date.parse(a.ends_at ?? '');
    return (
      a.kind === 'calendar_event' &&
      start <= now.getTime() &&
      start >= now.getTime() - 90 * DAY &&
      end > start &&
      end <= now.getTime() &&
      end - start < DAY
    );
  });
  const dates = new Set(
    events.map((a) => wallClock(new Date(a.occurred_at)).toISOString().slice(0, 10)),
  );
  if (events.length < 5 || dates.size < 3) return [];
  const afternoon = events.filter((a) => wallClock(new Date(a.occurred_at)).getUTCHours() >= 12);
  const morning = events.filter((a) => wallClock(new Date(a.occurred_at)).getUTCHours() < 12);
  const dominant = afternoon.length >= morning.length ? afternoon : morning;
  if (dominant.length / events.length < 0.65) return [];
  const period = dominant === afternoon ? '午後' : '午前';
  return [
    {
      key: 'initial.observedCalendarPeriod',
      label: `過去90日の予定は${period}開始が多い（${dominant.length}/${events.length}件）`,
      value: period,
      status: 'observed',
      enabled: true,
      sources: dominant.slice(0, 3).map((a) => ({ ...a.provenance, excerpt: null })),
    },
  ];
}

export function initialSnapshot(
  artifacts: readonly WorkArtifact[],
  now: Date,
  analysis?: InitialProfileAnalysis,
): {
  sections: InitialProfileSections;
  profile: PersonalizationProfile;
} {
  if (analysis && !validAnalysis(artifacts, analysis))
    throw new Error('invalid_initial_profile_analysis');
  const accepted = analysis ? InitialProfileAnalysis.parse(analysis) : undefined;
  const people = initialPeople(artifacts, now, new Set(accepted?.excluded_ids ?? []));
  const patterns = observedPatterns(artifacts, now);
  const profile: PersonalizationProfile = {
    inference_enabled: true,
    updated_at: now.toISOString(),
    working_style: [],
    work_patterns: patterns,
    frequent_entities: people.map((p) => ({
      key: 'initial.person.' + createHash('sha256').update(p.key).digest('hex'),
      label: summaryText(p.name),
      value: p.inbound + p.outbound,
      status: 'observed',
      enabled: true,
      sources: p.artifacts.slice(0, 2).map((a) => ({ ...a.provenance, excerpt: null })),
    })),
  };
  return {
    profile,
    sections: {
      focus: accepted?.focus.map((claim) => claim.text) ?? [],
      people: people.map((p) => summaryText(p.name)).filter(Boolean),
      priorities: accepted?.priorities.map((claim) => claim.text) ?? [],
      work_pattern: patterns.map((item) => item.label),
      open_items: accepted?.open_items.length ?? 0,
    },
  };
}

export class InitialProfileService {
  constructor(
    private readonly db: DbHandle,
    private readonly now: () => Date,
  ) {}

  async get(tenant: string, user: string): Promise<InitialProfile | null> {
    return withTenant(this.db, tenant, async (tx) => {
      const r = await sql<{
        payload: unknown;
        artifact_snapshot: unknown[];
      }>`SELECT payload, artifact_snapshot FROM initial_profiles WHERE user_id=${user}`.execute(tx);
      return r.rows[0] ? InitialProfile.parse(r.rows[0].payload) : null;
    });
  }

  async begin(
    tenant: string,
    user: string,
    provider: 'google' | 'microsoft',
  ): Promise<InitialProfile> {
    const stamp = this.now().toISOString();
    const value: InitialProfile = {
      id: uuidv7(),
      provider,
      status: 'queued',
      started_at: stamp,
      updated_at: stamp,
      outcomes: [],
      sections: null,
      profile: null,
      analysis: null,
    };
    await withTenant(this.db, tenant, (tx) =>
      sql`INSERT INTO initial_profiles (tenant_id,user_id,payload)
      VALUES (${tenant},${user},${JSON.stringify(value)}::jsonb) ON CONFLICT DO NOTHING`.execute(
        tx,
      ),
    );
    return (await this.get(tenant, user))!;
  }

  async claim(
    tenant: string,
    user: string,
  ): Promise<{ lease: string; profile: InitialProfile } | null> {
    const now = this.now();
    const lease = uuidv7();
    return withTenant(this.db, tenant, async (tx) => {
      const r = await sql<{ payload: unknown }>`UPDATE initial_profiles
        SET artifact_snapshot='[]'::jsonb, lease_id=${lease}, lease_until=${new Date(now.getTime() + 5 * 60_000)},
          payload=payload || '{"status":"analysing","outcomes":[],"sections":null,"profile":null,"analysis":null}'::jsonb
        WHERE user_id=${user} AND (payload->>'status'='queued' OR
          (payload->>'status'='analysing' AND lease_until < ${now})) RETURNING payload`.execute(tx);
      return r.rows[0] ? { lease, profile: InitialProfile.parse(r.rows[0].payload) } : null;
    });
  }

  /** Initial reads never mutate normal work artifacts or their synchronization cursor. */
  async ingest(
    tenant: string,
    user: string,
    lease: string,
    batch: WorkArtifactBatch,
  ): Promise<boolean> {
    return withTenant(this.db, tenant, async (tx) => {
      const result = await sql<{
        payload: unknown;
        artifact_snapshot: unknown[];
      }>`SELECT payload, artifact_snapshot FROM initial_profiles
        WHERE user_id=${user} AND lease_id=${lease} AND payload->>'status'='analysing' FOR UPDATE`.execute(
        tx,
      );
      const row = result.rows[0];
      if (!row) return false;
      const profile = InitialProfile.parse(row.payload);
      const allowed =
        profile.provider === 'google'
          ? ['gmail', 'google_calendar']
          : ['outlook_mail', 'outlook_calendar'];
      if (!allowed.includes(batch.source) || batch.artifacts.some((a) => a.source !== batch.source))
        return false;
      const snapshot = new Map(
        row.artifact_snapshot.map((value) => {
          const a = WorkArtifact.parse(value);
          return [a.id, a] as const;
        }),
      );
      for (const value of batch.artifacts) {
        const a = WorkArtifact.parse(value);
        snapshot.set(a.id, {
          ...a,
          body_excerpt: null,
          semantic: null,
          provenance: { ...a.provenance, excerpt: null },
        });
      }
      if (snapshot.size > 5000) return false;
      await sql`UPDATE initial_profiles SET artifact_snapshot=${JSON.stringify([...snapshot.values()])}::jsonb,
        lease_until=${new Date(this.now().getTime() + 5 * 60_000)} WHERE user_id=${user}`.execute(
        tx,
      );
      return true;
    });
  }

  async progress(
    tenant: string,
    user: string,
    lease: string,
    outcome: InitialProfileOutcome,
    artifactIds: readonly string[] = [],
  ): Promise<boolean> {
    return withTenant(this.db, tenant, async (tx) => {
      const r = await sql<{
        payload: unknown;
        artifact_snapshot: unknown[];
      }>`SELECT payload, artifact_snapshot FROM initial_profiles
        WHERE user_id=${user} AND lease_id=${lease} AND payload->>'status'='analysing' FOR UPDATE`.execute(
        tx,
      );
      if (!r.rows[0]) return false;
      const p = InitialProfile.parse(r.rows[0].payload);
      const expected =
        p.provider === 'google'
          ? ['gmail', 'google_calendar']
          : ['outlook_mail', 'outlook_calendar'];
      if (!expected.includes(outcome.source)) return false;
      p.outcomes = [...p.outcomes.filter((o) => o.source !== outcome.source), outcome];
      p.updated_at = this.now().toISOString();
      if (outcome.status === 'synced' && artifactIds.length) {
        const allowed = new Set(
          p.outcomes.filter((o) => o.status === 'synced').map((o) => o.source),
        );
        const artifacts = r.rows[0].artifact_snapshot
          .map((value) => WorkArtifact.parse(value))
          .filter((a) => artifactIds.includes(a.id))
          .filter((a) => allowed.has(a.source as InitialProfileOutcome['source']));
        const snapshot = initialSnapshot(artifacts, this.now());
        p.sections = snapshot.sections;
        p.profile = snapshot.profile;
      }
      await sql`UPDATE initial_profiles SET payload=${JSON.stringify(p)}::jsonb,
        lease_until=${new Date(this.now().getTime() + 5 * 60_000)} WHERE user_id=${user}`.execute(
        tx,
      );
      return true;
    });
  }

  async finish(
    tenant: string,
    user: string,
    lease: string,
    artifactIds: readonly string[],
    analysis?: InitialProfileAnalysis,
  ): Promise<boolean> {
    return withTenant(this.db, tenant, async (tx) => {
      const r = await sql<{
        payload: unknown;
        artifact_snapshot: unknown[];
      }>`SELECT payload, artifact_snapshot FROM initial_profiles WHERE user_id=${user}
        AND lease_id=${lease} AND payload->>'status'='analysing' FOR UPDATE`.execute(tx);
      if (!r.rows[0]) return false;
      const p = InitialProfile.parse(r.rows[0].payload);
      const successful = p.outcomes.filter((o) => o.status === 'synced');
      const allowed = new Set(successful.map((o) => o.source));
      const selected = new Set(artifactIds);
      const artifacts = r.rows[0].artifact_snapshot
        .map((value) => WorkArtifact.parse(value))
        .filter((a) => selected.has(a.id))
        .filter((a) => allowed.has(a.source as InitialProfileOutcome['source']));
      if (analysis && !validAnalysis(artifacts, analysis)) return false;
      p.status =
        successful.length &&
        p.outcomes.length === 2 &&
        p.outcomes.every((o) => o.status !== 'reading')
          ? 'ready'
          : 'failed';
      if (p.status === 'ready') {
        const snapshot = initialSnapshot(artifacts, this.now(), analysis);
        p.sections = snapshot.sections;
        p.profile = snapshot.profile;
        p.analysis = analysis ? InitialProfileAnalysis.parse(analysis) : null;
      }
      p.updated_at = this.now().toISOString();
      await sql`UPDATE initial_profiles SET payload=${JSON.stringify(p)}::jsonb, lease_id=NULL, lease_until=NULL WHERE user_id=${user}`.execute(
        tx,
      );
      return true;
    });
  }

  async retry(tenant: string, user: string): Promise<void> {
    await withTenant(this.db, tenant, (tx) =>
      sql`UPDATE initial_profiles SET
      payload=payload || '{"status":"queued","outcomes":[],"sections":null,"profile":null,"analysis":null}'::jsonb,
      artifact_snapshot='[]'::jsonb, lease_id=NULL, lease_until=NULL
      WHERE user_id=${user} AND payload->>'status' IN ('ready','failed')`.execute(tx),
    );
  }

  async confirm(tenant: string, user: string, sections: InitialProfileSections): Promise<boolean> {
    return withTenant(this.db, tenant, async (tx) => {
      const r = await sql<{ payload: unknown }>`SELECT payload FROM initial_profiles
        WHERE user_id=${user} AND payload->>'status' IN ('ready','confirmed') FOR UPDATE`.execute(
        tx,
      );
      if (!r.rows[0]) return false;
      const p = InitialProfile.parse(r.rows[0].payload);
      p.sections = sections;
      p.status = 'confirmed';
      p.updated_at = this.now().toISOString();
      // Keep just the five reviewed groups as user-confirmed personalization.
      // Initial metadata is discarded after the reviewed profile is confirmed.
      p.profile = {
        inference_enabled: true,
        updated_at: p.updated_at,
        work_patterns: [],
        frequent_entities: [],
        working_style: Object.entries(sections).map(([key, value]) => ({
          key: `initial.${key}`,
          label: (
            {
              focus: '現在の仕事',
              people: 'よく関わる人',
              priorities: '直近の優先事項',
              work_pattern: '仕事の傾向',
              open_items: '未完了の項目',
            } as Record<string, string>
          )[key]!,
          value,
          status: 'confirmed' as const,
          enabled: true,
          sources: [],
        })),
      };
      await sql`UPDATE initial_profiles SET artifact_snapshot='[]'::jsonb, payload=${JSON.stringify(p)}::jsonb WHERE user_id=${user}`.execute(
        tx,
      );
      return true;
    });
  }
}
