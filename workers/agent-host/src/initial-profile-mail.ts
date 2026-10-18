import {
  INITIAL_PROFILE_MAIL_LIMIT as INITIAL_BODY_LIMIT,
  PersonRef,
  WorkArtifact,
} from '@genie/contracts';
import { fromGmail, fromOutlookMail, type OutlookMailSummary } from '@genie/service-connectors';
import type { ConnectorRuntime } from './connector-steps.js';
import { GMAIL_AUTOMATED_CATEGORY_QUERY, isAutomatedMail as automated } from './mail-selection.js';

/** Raw body text exists only in this local analyzer input, never in an artifact or progress payload. */
export interface InitialProfileMailInput {
  readonly artifact: WorkArtifact;
  readonly body: string;
}
export const INITIAL_MAIL_LIMIT = 1000;
export { INITIAL_BODY_LIMIT };
export const INITIAL_BODY_CHARS = 2000;
const DAY = 86_400_000;

interface Candidate {
  artifact: WorkArtifact;
  important: boolean;
  reply: boolean;
  noise: boolean;
}
export interface InitialProfileMailRead {
  readonly artifacts: WorkArtifact[];
  readonly messages: InitialProfileMailInput[];
  readonly metadata_count: number;
  readonly excluded_count: number;
  readonly selected_count: number;
  readonly failed_reads: number;
}

function minimized(artifact: WorkArtifact, own: ReadonlySet<string>): WorkArtifact | null {
  const people = artifact.people.flatMap((person) => {
    if (typeof person.email === 'string' && own.has(person.email.toLowerCase())) return [];
    const parsed = PersonRef.safeParse(person);
    return parsed.success ? [parsed.data] : [];
  });
  const parsed = WorkArtifact.safeParse({
    ...artifact,
    // Keep real addresses intact. Invalid entries are omitted before applying
    // the shared contract limit, with the sender first and stable order otherwise.
    people: [
      ...people.filter((person) => person.role === 'from'),
      ...people.filter((person) => person.role !== 'from'),
    ].slice(0, 50),
    body_excerpt: null,
    semantic: null,
    provenance: { ...artifact.provenance, excerpt: null },
  });
  return parsed.success ? parsed.data : null;
}

/** Remove markup, quoted history and common signatures before the bounded local read. No HTML is executed. */
export function initialProfileBody(value: string, html: boolean): string {
  let text = value.slice(0, 32_000).replace(/\r\n?/g, '\n');
  if (html) {
    text = text
      .replace(/<!--[\s\S]*?(?:-->|$)/g, '')
      .replace(/<(script|style|head)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi, '')
      .replace(
        /<(?:blockquote|div\b[^>]*\bclass\s*=\s*["'][^"']*(?:gmail_quote|yahoo_quoted)[^"']*["'])[^>]*>[\s\S]*/gi,
        '',
      )
      .replace(/<\/?(?:br|p|div|li|tr|h[1-6])\b[^>]*>/gi, '\n')
      .replace(/<[^<>]*>/g, '')
      .replace(/&(#x[\da-f]+|#\d+|nbsp|amp|lt|gt|quot|apos);/gi, (_match, entity: string) => {
        const key = entity.toLowerCase();
        const named: Record<string, string> = {
          nbsp: ' ',
          amp: '&',
          lt: '<',
          gt: '>',
          quot: '"',
          apos: "'",
        };
        if (key in named) return named[key]!;
        const code = key.startsWith('#x')
          ? Number.parseInt(key.slice(2), 16)
          : Number(key.slice(1));
        return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff)
          ? String.fromCodePoint(code)
          : '';
      });
  }
  const lines: string[] = [];
  for (const line of text.split('\n')) {
    if (
      /^\s*(?:On .{0,200}wrote:|.{0,120}(?:書きました|のメール):|[-_]{2,}\s*(?:Original Message|元のメッセージ)|--\s*$|Sent from my\b|iPhoneから送信|配信停止|unsubscribe\b)/i.test(
        line,
      )
    )
      break;
    if (/^\s*>/.test(line)) continue;
    lines.push(line.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trimEnd());
  }
  return lines
    .join('\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, INITIAL_BODY_CHARS);
}

/** Initial-only sampling. Ordinary background sync retains its metadata-only read contract. */
export async function readInitialProfileMail(deps: {
  provider: 'google' | 'microsoft';
  connectors: ConnectorRuntime;
  readBodies: boolean;
  now?: Date;
  onProgress?: () => Promise<void>;
  onMetadata?: (artifacts: WorkArtifact[]) => Promise<void>;
}): Promise<InitialProfileMailRead> {
  const now = deps.now ?? new Date();
  const since = new Date(now.getTime() - 90 * DAY);
  const context = { observedAt: now.toISOString() };
  const candidates: Candidate[] = [];
  let read: (id: string) => Promise<{ id: string; body: string; bodyIsHtml: boolean }>;
  if (deps.provider === 'google') {
    const gmail = deps.connectors.gmail();
    // Apply the existing local category exclusions before Gmail fills the bounded
    // candidate pages. Keep automated() as a second check on returned metadata.
    const query = `after:${Math.floor(since.getTime() / 1000)} -in:trash -in:spam -in:drafts ${GMAIL_AUTOMATED_CATEGORY_QUERY}`;
    // Each listing hydrates metadata. Keep buckets sequential so their request
    // pools cannot multiply Gmail's per-user concurrency or Keychain reads.
    const incoming = await gmail.list({
      query: `${query} -in:sent`,
      maxResults: 100,
      maxPages: 4,
      retryRateLimits: true,
    });
    await deps.onProgress?.();
    const sent = await gmail.list({
      query,
      labelIds: ['SENT'],
      maxResults: 100,
      maxPages: 4,
      retryRateLimits: true,
    });
    await deps.onProgress?.();
    const important = await gmail.list({
      query: `${query} {is:important is:starred}`,
      maxResults: 100,
      maxPages: 2,
      retryRateLimits: true,
    });
    await deps.onProgress?.();
    const sentIds = new Set(sent.map((mail) => mail.id));
    for (const mail of [...incoming, ...sent, ...important]) {
      const artifact = fromGmail(
        mail,
        sentIds.has(mail.id) || mail.labels?.includes('SENT') ? 'outbound' : 'inbound',
        context,
      );
      if (artifact)
        candidates.push({
          artifact,
          important: Boolean(
            mail.labels?.some((label) => ['IMPORTANT', 'STARRED'].includes(label)),
          ),
          reply: Boolean(mail.inReplyTo),
          noise: automated(mail, mail.from, mail.labels),
        });
    }
    read = (id) => gmail.get(id, undefined, { retryRateLimits: true });
  } else {
    const outlook = deps.connectors.outlookMail();
    const [inbox, sent] = await Promise.all([
      outlook.list({
        folder: 'inbox',
        selectionMetadata: true,
        since: since.toISOString(),
        maxResults: 100,
      }),
      outlook.list({
        folder: 'sentitems',
        selectionMetadata: true,
        since: since.toISOString(),
        maxResults: 100,
      }),
    ]);
    const sentIds = new Set(sent.map((mail) => mail.id));
    for (const mail of [...inbox, ...sent]) {
      const known: OutlookMailSummary = {
        ...mail,
        folder: sentIds.has(mail.id) ? 'sentitems' : mail.folder,
      };
      const artifact = fromOutlookMail(known, context);
      if (artifact)
        candidates.push({
          artifact,
          important: mail.importance === 'high',
          reply: Boolean(mail.inReplyTo),
          noise: mail.isDraft === true || automated(mail, mail.from?.address ?? ''),
        });
    }
    read = (id) => outlook.get(id);
  }
  const unique = new Map<string, Candidate>();
  for (const candidate of candidates) {
    const time = Date.parse(candidate.artifact.occurred_at);
    if (time < since.getTime() || time > now.getTime()) continue;
    if (unique.size >= INITIAL_MAIL_LIMIT && !unique.has(candidate.artifact.id)) continue;
    unique.set(candidate.artifact.id, candidate);
  }
  const own = new Set(
    [...unique.values()]
      .filter((c) => c.artifact.direction === 'outbound')
      .flatMap((c) =>
        c.artifact.people
          .filter((p) => p.role === 'from')
          .map((p) => (typeof p.email === 'string' ? p.email.toLowerCase() : null))
          .filter((email): email is string => Boolean(email)),
      ),
  );
  const clean = [...unique.values()].flatMap((candidate) => {
    if (candidate.noise) return [];
    const artifact = minimized(candidate.artifact, own);
    return artifact ? [{ ...candidate, artifact }] : [];
  });
  const threads = new Map<string, { inbound: boolean; outbound: boolean; latestSent: number }>();
  for (const { artifact } of clean) {
    if (!artifact.thread_id) continue;
    const thread = threads.get(artifact.thread_id) ?? {
      inbound: false,
      outbound: false,
      latestSent: 0,
    };
    if (artifact.direction === 'inbound') thread.inbound = true;
    if (artifact.direction === 'outbound') {
      thread.outbound = true;
      thread.latestSent = Math.max(thread.latestSent, Date.parse(artifact.occurred_at));
    }
    threads.set(artifact.thread_id, thread);
  }
  for (const { artifact } of clean) {
    const thread = artifact.thread_id ? threads.get(artifact.thread_id) : undefined;
    if (
      artifact.direction === 'inbound' &&
      thread &&
      thread.latestSent > Date.parse(artifact.occurred_at)
    )
      artifact.responded = true;
  }
  const score = (candidate: Candidate) => {
    const thread = candidate.artifact.thread_id
      ? threads.get(candidate.artifact.thread_id)
      : undefined;
    return (
      (thread?.inbound && thread.outbound ? 100 : 0) +
      (candidate.artifact.direction === 'outbound' ? 40 : 0) +
      (candidate.important ? 60 : 0) +
      (candidate.reply ? 15 : 0)
    );
  };
  const groups = new Map<string, Candidate[]>();
  for (const candidate of clean) {
    const key = candidate.artifact.thread_id ?? candidate.artifact.id;
    const group = groups.get(key) ?? [];
    group.push(candidate);
    groups.set(key, group);
  }
  const newestFirst = (a: Candidate, b: Candidate) =>
    Date.parse(b.artifact.occurred_at) - Date.parse(a.artifact.occurred_at) ||
    a.artifact.id.localeCompare(b.artifact.id);
  const ranked = [...groups.values()]
    .map((group) => {
      group.sort(newestFirst);
      // Never fill the budget with one long conversation or outgoing messages alone.
      // Preserve the newest received request and sent reply together when observed.
      const pair = [
        group.find((c) => c.artifact.direction === 'inbound'),
        group.find((c) => c.artifact.direction === 'outbound'),
      ]
        .filter((c): c is Candidate => c !== undefined)
        .sort(newestFirst);
      return { pair, score: Math.max(...group.map(score)), latest: group[0]! };
    })
    .sort((a, b) => b.score - a.score || newestFirst(a.latest, b.latest));
  const selected: Candidate[] = [];
  for (const group of ranked) {
    if (selected.length + group.pair.length <= INITIAL_BODY_LIMIT) selected.push(...group.pair);
  }
  const messages: InitialProfileMailInput[] = [];
  let failedReads = 0;
  const artifacts = clean.map((candidate) => candidate.artifact);
  await deps.onMetadata?.(artifacts);
  if (deps.readBodies) {
    // Serial bounded reads keep the job lease alive and avoid provider bursts.
    for (const { artifact } of selected) {
      try {
        const mail = await read(artifact.provenance.external_id);
        if (mail.id !== artifact.provenance.external_id) throw new Error('message_mismatch');
        const body = initialProfileBody(mail.body, mail.bodyIsHtml);
        if (!body) throw new Error('body_unavailable');
        messages.push({ artifact, body });
      } catch {
        failedReads += 1;
      } // Provider errors can contain private account data.
      await deps.onProgress?.();
    }
  }
  return {
    artifacts,
    messages,
    metadata_count: unique.size,
    excluded_count: unique.size - clean.length,
    selected_count: selected.length,
    failed_reads: failedReads,
  };
}
