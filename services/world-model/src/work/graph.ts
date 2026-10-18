/**
 * Work Graph。正規化した artifact（メール・予定・タスク・会議）から、
 * 案件（project）・人・待ち（waiting on）・返すもの（owed）・期限を**決定的に**組み立てる。
 *
 * 判断はここでする（connector はしない）。ただし LLM はここに居ない — 意味（category / request / waiting_on）は
 * artifact.semantic に入って来るもので、無ければ規則で補う。すべての出力に出所（Provenance）が付く。
 */
import {
  MAX_WORK_PRIORITIES,
  normalizeName,
  type OwedItem,
  type Provenance,
  type WaitingItem,
  type WeekLoad,
  type WorkArtifact,
  type WorkContext,
  type WorkCorrection,
  type WorkPriority,
  type WorkSource,
} from '@genie/contracts';
import { pressure, type PressureInput } from './pressure.js';
import { wallClock, instant } from './business-time.js';
import { ruleSemantic } from './semantic.js';

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

// ------------------------------------------------------------ people

/** 人を寄せる鍵。メールがあればメール（大小無視）、無ければ正規化した名前（D-45）。 */
export function personKey(p: { name: string; email?: string | null }): string {
  if (p.email && p.email.trim().length > 0) return p.email.trim().toLowerCase();
  return normalizeName(p.name);
}

// ---------------------------------------------------------- clustering

const NOISE = /^(re|fwd?|fw|返信|転送)\s*[:：]\s*/i;
const STOP = new Set([
  'の',
  'について',
  'に関して',
  'ご',
  'お',
  'the',
  'a',
  'an',
  'of',
  'for',
  'to',
  'and',
  '件',
  'ご連絡',
  'お願い',
  'について',
]);

/** 題を寄せるための語。「Re:」「【】」を落とし、記号で割る。 */
export function titleTokens(title: string): string[] {
  let t = title.normalize('NFKC');
  for (let i = 0; i < 3; i += 1) t = t.replace(NOISE, '');
  t = t.replace(/[【】\[\]()（）「」『』]/g, ' ');
  return t
    .toLowerCase()
    .split(/[\s、。,.:：;/／|｜\-–—_]+/)
    .map((w) => w.trim())
    .filter((w) => w.length >= 2 && !STOP.has(w));
}

export function cleanTitle(title: string): string {
  let t = title.normalize('NFKC').trim();
  for (let i = 0; i < 3; i += 1) t = t.replace(NOISE, '');
  return t.replace(/^[【\[]([^】\]]+)[】\]]\s*/, '$1 ').trim() || title;
}

function jaccard(a: readonly string[], b: readonly string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const sa = new Set(a),
    sb = new Set(b);
  let inter = 0;
  for (const x of sa) if (sb.has(x)) inter += 1;
  return inter / (sa.size + sb.size - inter);
}

export interface ProjectCluster {
  readonly key: string;
  readonly name: string;
  readonly artifacts: WorkArtifact[];
}

/**
 * 案件に寄せる。優先順:
 *   1. semantic.project / project_hint（明示の案件名）
 *   2. 同じ thread
 *   3. 題の語の重なり（Jaccard >= 0.5）
 * 決定的: 入力を occurred_at → id で並べてから処理する。
 */
export function clusterProjects(artifacts: readonly WorkArtifact[]): ProjectCluster[] {
  const sorted = [...artifacts].sort(
    (a, b) => a.occurred_at.localeCompare(b.occurred_at) || a.id.localeCompare(b.id),
  );
  const clusters: {
    key: string;
    names: Map<string, number>;
    tokens: string[];
    artifacts: WorkArtifact[];
    explicit: boolean;
  }[] = [];
  const byThread = new Map<string, number>();

  for (const art of sorted) {
    const explicit = art.semantic?.project ?? art.project_hint ?? null;
    const tokens = titleTokens(art.title);
    let idx = -1;
    if (explicit) {
      const key = 'p:' + normalizeName(explicit);
      idx = clusters.findIndex((c) => c.key === key);
      if (idx < 0) {
        clusters.push({ key, names: new Map(), tokens: [], artifacts: [], explicit: true });
        idx = clusters.length - 1;
      }
    } else if (art.thread_id && byThread.has(art.thread_id)) {
      idx = byThread.get(art.thread_id)!;
    } else {
      // 題の重なりで既存に寄せる（明示の案件は名前でしか寄せない）。
      let best = -1,
        bestScore = 0;
      clusters.forEach((c, i) => {
        if (c.explicit) return;
        const s = jaccard(tokens, c.tokens);
        if (s >= 0.5 && s > bestScore) {
          best = i;
          bestScore = s;
        }
      });
      idx = best;
      if (idx < 0) {
        clusters.push({
          key: 't:' + (tokens.join('-') || art.id),
          names: new Map(),
          tokens: [...tokens],
          artifacts: [],
          explicit: false,
        });
        idx = clusters.length - 1;
      }
    }
    const c = clusters[idx]!;
    c.artifacts.push(art);
    if (art.thread_id) byThread.set(art.thread_id, idx);
    for (const tk of tokens) if (!c.tokens.includes(tk)) c.tokens.push(tk);
    const name = explicit ?? cleanTitle(art.title);
    if (name) c.names.set(name, (c.names.get(name) ?? 0) + 1);
  }
  return clusters.map((c) => {
    // 名前は最も多く使われたもの。同数なら短い方（Re: を剥いだ題より案件名が短い）。
    const name =
      [...c.names.entries()].sort(
        (a, b) => b[1] - a[1] || a[0].length - b[0].length || a[0].localeCompare(b[0]),
      )[0]?.[0] ?? '無題';
    return { key: c.key, name, artifacts: c.artifacts };
  });
}

// ------------------------------------------------------------ inference

const ASK_CATEGORIES = new Set(['request_to_me', 'question', 'approval_pending']);

function provenanceOf(art: WorkArtifact): Provenance {
  return art.provenance;
}

function hoursSince(iso: string, now: Date): number {
  return Math.max(0, (now.getTime() - Date.parse(iso)) / HOUR_MS);
}

/** 自分宛の依頼で、まだ返していないもの（同じ thread に自分の返信が後から無い）。 */
export function owedItems(
  artifacts: readonly WorkArtifact[],
  clusterOf: (a: WorkArtifact) => string | null,
  now: Date,
): OwedItem[] {
  return dedupe(
    rawOwed(artifacts, clusterOf),
    (o) => (artifacts.find((a) => 'owed:' + a.id === o.id)?.thread_id ?? o.id) + '|' + o.to,
  ).sort((a, b) => (a.due_at ?? '9').localeCompare(b.due_at ?? '9') || a.id.localeCompare(b.id));
}

/** まとめる前の 1 件ずつ（再送の数え上げ・未返信時間に使う）。時刻順。 */
export function rawOwed(
  artifacts: readonly WorkArtifact[],
  clusterOf: (a: WorkArtifact) => string | null,
): OwedItem[] {
  const out: OwedItem[] = [];
  for (const art of byTime(artifacts)) {
    if (art.direction !== 'inbound' || !art.semantic || !ASK_CATEGORIES.has(art.semantic.category))
      continue;
    if (art.responded === true) continue;
    const answeredLater = art.thread_id
      ? artifacts.some(
          (o) =>
            o.thread_id === art.thread_id &&
            o.direction === 'outbound' &&
            o.occurred_at > art.occurred_at,
        )
      : false;
    if (answeredLater) continue;
    const from = art.people.find((p) => p.role === 'from')?.name ?? art.people[0]?.name ?? '相手';
    out.push({
      id: 'owed:' + art.id,
      to: from,
      what: art.semantic.request ?? cleanTitle(art.title),
      due_at: art.semantic.due ?? art.due_at,
      project: clusterOf(art),
      sources: [provenanceOf(art)],
      confirmed: false,
    });
  }
  return out;
}

/** occurred_at → id の順（入力の順に依らない）。 */
function byTime(artifacts: readonly WorkArtifact[]): WorkArtifact[] {
  return [...artifacts].sort(
    (a, b) => a.occurred_at.localeCompare(b.occurred_at) || a.id.localeCompare(b.id),
  );
}

/** 同じ鍵のものを 1 件に。後ろ（新しい）を残し、出所を足し、期限は早い方。 */
function dedupe<T extends { id: string; sources: Provenance[]; due_at?: string | null }>(
  items: T[],
  keyOf: (t: T) => string,
): T[] {
  const byKey = new Map<string, T>();
  for (const it of items) {
    const k = keyOf(it);
    const prev = byKey.get(k);
    if (!prev) {
      byKey.set(k, it);
      continue;
    }
    const due = [prev.due_at, it.due_at].filter((d): d is string => !!d).sort()[0] ?? null;
    byKey.set(k, {
      ...it,
      sources: [...prev.sources, ...it.sources].slice(0, 6),
      ...('due_at' in it ? { due_at: due } : {}),
    });
  }
  return [...byKey.values()];
}

/** 自分が誰かを待っているもの（自分の依頼に返事が無い / semantic.waiting_on）。 */
export function waitingItems(
  artifacts: readonly WorkArtifact[],
  clusterOf: (a: WorkArtifact) => string | null,
  now: Date,
): WaitingItem[] {
  const out: WaitingItem[] = [];
  for (const art of byTime(artifacts)) {
    const s = art.semantic;
    const myRequest = art.direction === 'outbound' && s?.category === 'request_to_other';
    const waitingOn = s?.waiting_on ?? null;
    if (!myRequest && !waitingOn) continue;
    if (art.completed === true) continue;
    const repliedLater = art.thread_id
      ? artifacts.some(
          (o) =>
            o.thread_id === art.thread_id &&
            o.direction === 'inbound' &&
            o.occurred_at > art.occurred_at,
        )
      : false;
    if (repliedLater) continue;
    const who =
      waitingOn ?? art.people.find((p) => p.role === 'to')?.name ?? art.people[0]?.name ?? '相手';
    out.push({
      id: 'waiting:' + art.id,
      who,
      what: s?.request ?? cleanTitle(art.title),
      since_days: Math.round((hoursSince(art.occurred_at, now) / 24) * 10) / 10,
      project: clusterOf(art),
      sources: [provenanceOf(art)],
    });
  }
  return dedupe(
    out,
    (w) =>
      (artifacts.find((a) => 'waiting:' + a.id === w.id)?.thread_id ?? w.id) +
      '|' +
      normalizeName(w.who),
  ).sort((a, b) => b.since_days - a.since_days || a.id.localeCompare(b.id));
}

function isToday(iso: string, now: Date): boolean {
  const d = wallClock(new Date(iso)),
    n = wallClock(now);
  return (
    d.getUTCFullYear() === n.getUTCFullYear() &&
    d.getUTCMonth() === n.getUTCMonth() &&
    d.getUTCDate() === n.getUTCDate()
  );
}

function daysUntil(iso: string | null, now: Date): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? (t - now.getTime()) / DAY_MS : null;
}

export function weekLoad(
  artifacts: readonly WorkArtifact[],
  owed: readonly OwedItem[],
  waiting: readonly WaitingItem[],
  now: Date,
): WeekLoad {
  const start = wallClock(now);
  start.setUTCHours(0, 0, 0, 0);
  const day = start.getUTCDay();
  start.setUTCDate(start.getUTCDate() - ((day + 6) % 7)); // 月曜始まり
  const startAt = Date.parse(instant(start)!);
  const endAt = Date.parse(instant(new Date(start.getTime() + 7 * DAY_MS))!);
  let hours = 0,
    deadlines = 0;
  for (const a of artifacts) {
    if ((a.kind === 'calendar_event' || a.kind === 'meeting') && a.ends_at) {
      const s = Date.parse(a.occurred_at),
        e = Date.parse(a.ends_at);
      if (s >= startAt && s < endAt && e > s) hours += (e - s) / HOUR_MS;
    }
    const due = a.semantic?.due ?? a.due_at;
    if (due && a.completed !== true) {
      const t = Date.parse(due);
      if (t >= now.getTime() - DAY_MS && t < endAt) deadlines += 1;
    }
  }
  return {
    meeting_hours: Math.round(hours * 10) / 10,
    deadlines,
    unanswered: owed.length,
    waiting: waiting.length,
  };
}

export interface BuildInput {
  readonly artifacts: readonly WorkArtifact[];
  readonly corrections: readonly WorkCorrection[];
  readonly now: Date;
  readonly inferenceEnabled: boolean;
}

/** Home に出す全体を組み立てる。**出所の無いものは 1 件も出ない。** */
export function buildWorkContext(input: BuildInput): WorkContext {
  const { now } = input;
  const sources: Partial<Record<WorkSource, number>> = {};
  for (const a of input.artifacts) sources[a.source] = (sources[a.source] ?? 0) + 1;
  const base = {
    generated_at: now.toISOString(),
    inference_enabled: input.inferenceEnabled,
    sources: sources as Record<WorkSource, number>,
  };
  if (!input.inferenceEnabled) {
    return {
      ...base,
      priorities: [],
      waiting_on: [],
      owed: [],
      week: weekLoad(input.artifacts, [], [], now),
    };
  }
  // `confirm` は消さない（本人が自分の TODO と確認した）。後から done / dismiss したら消える。
  const dismissed = new Set(
    input.corrections
      .filter((c) => c.action !== 'wrong_project' && c.action !== 'confirm')
      .map((c) => c.item_id),
  );
  const confirmed = new Set(
    input.corrections.filter((c) => c.action === 'confirm').map((c) => c.item_id),
  );
  /*
   * 意味が付いていないメールは規則で補う（代役）。**端末の LLM が付けたものは上書きしない。**
   * 補わないと、分類の無いメールは「返すもの」にも「待っていること」にも決して現れず、
   * 端末に言語モデルが無い人には Work Context が空のままになる。
   */
  const active = byTime(input.artifacts)
    .filter((a) => !dismissed.has(a.id) && a.completed !== true)
    .map((a) =>
      a.semantic === null && (a.kind === 'email' || a.kind === 'message')
        ? { ...a, semantic: ruleSemantic(a, now) }
        : a,
    );
  const clusters = clusterProjects(active);
  const clusterByArtifact = new Map<string, ProjectCluster>();
  for (const c of clusters) for (const a of c.artifacts) clusterByArtifact.set(a.id, c);
  const clusterOf = (a: WorkArtifact): string | null => clusterByArtifact.get(a.id)?.name ?? null;

  const owed = owedItems(active, clusterOf, now).filter((o) => !dismissed.has(o.id));
  const owedAll = rawOwed(active, clusterOf);
  const waiting = waitingItems(active, clusterOf, now).filter((w) => !dismissed.has(w.id));

  const priorities: WorkPriority[] = [];
  for (const c of clusters) {
    if (dismissed.has('project:' + c.key)) continue;
    const dues = c.artifacts
      .map((a) => daysUntil(a.semantic?.due ?? a.due_at, now))
      .filter((d): d is number => d !== null && d > -1);
    const daysUntilDue = dues.length ? Math.min(...dues) : null;
    const clusterOwed = owed.filter((o) => o.project === c.name);
    // 未返信時間と再送は、まとめる前の 1 件ずつで数える。
    const owedArts = c.artifacts.filter((a) =>
      owedAll.some((o) => o.id === 'owed:' + a.id && o.project === c.name),
    );
    const unansweredHours = owedArts.length
      ? Math.max(...owedArts.map((a) => hoursSince(a.occurred_at, now)))
      : null;
    const senders = new Map<string, number>();
    for (const a of owedArts) {
      const k = personKey(a.people.find((p) => p.role === 'from') ?? { name: '?' });
      senders.set(k, (senders.get(k) ?? 0) + 1);
    }
    const resent = [...senders.values()].some((n) => n >= 2);
    const meetings = c.artifacts
      .filter(
        (a) => (a.kind === 'calendar_event' || a.kind === 'meeting') && isToday(a.occurred_at, now),
      )
      .sort((a, b) => a.occurred_at.localeCompare(b.occurred_at));
    let minGap: number | null = null;
    for (let i = 1; i < meetings.length; i += 1) {
      const prevEnd = meetings[i - 1]!.ends_at ?? meetings[i - 1]!.occurred_at;
      const gap = (Date.parse(meetings[i]!.occurred_at) - Date.parse(prevEnd)) / 60_000;
      minGap = minGap === null ? gap : Math.min(minGap, gap);
    }
    const hasPrepTask = c.artifacts.some(
      (a) =>
        a.kind === 'task' &&
        a.completed !== true &&
        daysUntil(a.due_at, now) !== null &&
        daysUntil(a.due_at, now)! <= 1,
    );
    const clusterWaiting = waiting.filter((w) => w.project === c.name);
    const blockedBy = clusterWaiting[0]?.who ?? null;
    const last = c.artifacts
      .map((a) => a.occurred_at)
      .sort()
      .at(-1)!;
    const repetitions = c.artifacts.filter((a) => hoursSince(a.occurred_at, now) <= 7 * 24).length;
    const pin: PressureInput = {
      id: c.key,
      daysUntilDue,
      unansweredHours,
      resent,
      meetingsToday: meetings.length,
      minGapMinutes: minGap,
      hasPrepTask,
      blockedBy,
      lastActivityHours: hoursSince(last, now),
      repetitions,
      explicitPriority: 0,
    };
    const p = pressure(pin);
    const lines: string[] = [];
    if (daysUntilDue !== null) lines.push(p.factors.find((f) => f.name === 'deadline')!.reason);
    if (blockedBy) lines.push(`${blockedBy} からの返信待ち`);
    if (clusterOwed.length) lines.push(`${clusterOwed[0]!.to} に未返信`);
    if (meetings.length)
      lines.push(
        `今日 ${wallClock(new Date(meetings[0]!.occurred_at)).toISOString().slice(11, 16)} 会議`,
      );
    const counts: Record<string, number> = {};
    for (const a of c.artifacts) counts[a.source] = (counts[a.source] ?? 0) + 1;
    const dueIso =
      c.artifacts
        .map((a) => a.semantic?.due ?? a.due_at)
        .filter((d): d is string => !!d)
        .sort()[0] ?? null;
    priorities.push({
      id: 'project:' + c.key,
      project: c.name,
      title: c.name,
      score: p.score,
      due_at: dueIso,
      waiting_on: blockedBy,
      lines: lines.slice(0, 4),
      counts,
      factors: [...p.factors],
      sources: [...c.artifacts]
        .sort((a, b) => b.occurred_at.localeCompare(a.occurred_at))
        .slice(0, 6)
        .map(provenanceOf),
      confirmed: false,
    });
  }
  priorities.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  return {
    ...base,
    priorities: priorities
      .slice(0, MAX_WORK_PRIORITIES * 4)
      .map((p) => ({ ...p, confirmed: confirmed.has(p.id) })),
    waiting_on: waiting,
    owed: owed.map((o) => ({ ...o, confirmed: confirmed.has(o.id) })),
    week: weekLoad(active, owed, waiting, now),
  };
}
