import { InitialProfile, InitialProfileAnalysis, InitialProfileOutcome } from '@genie/contracts';
import {
  ConnectorError,
  CONNECTOR_FAILURES,
  type ConnectorFailure,
} from '@genie/service-connectors';
import type { ConnectorRuntime } from './connector-steps.js';
import { WorkSyncLoop } from './work-sync.js';
import { readInitialProfileMail, type InitialProfileMailInput } from './initial-profile-mail.js';

const unavailable = (selected = 0): InitialProfileAnalysis => ({
  version: 2,
  status: 'unavailable',
  selected_count: selected,
  analyzed_count: 0,
  analyzed_ids: [],
  excluded_ids: [],
  focus: [],
  priorities: [],
  open_items: [],
});

/** A leased, bounded first read. No timer-driven re-analysis after confirmation. */
export async function runInitialProfile(deps: {
  cloud: (path: string, method: string, body?: unknown) => Promise<unknown>;
  connectors: ConnectorRuntime;
  refreshGrants: () => Promise<void>;
  analyze?: (messages: InitialProfileMailInput[]) => Promise<InitialProfileAnalysis>;
  onDiagnostic?: (
    phase: 'mail_read' | 'metadata_publish' | 'analysis',
    code: ConnectorFailure | 'invalid_analysis' | 'metadata_publish_failed' | 'unknown',
  ) => void;
}): Promise<void> {
  const result = (await deps.cloud('/v1/work/initial-profile/claim', 'POST')) as {
    job: { lease: string; profile: unknown } | null;
  };
  if (!result.job) return;
  const { lease } = result.job;
  const profile = InitialProfile.parse(result.job.profile);
  await deps.refreshGrants();
  const ids = new Set<string>();
  const google = profile.provider === 'google';
  const mailSource = google ? 'gmail' : 'outlook_mail';
  const mailKey = google ? 'gmail' : 'outlook';
  let analysis = unavailable();
  let mailCount = 0;
  const diagnostic: { phase: 'mail_read' | 'metadata_publish' | 'analysis' } = {
    phase: 'mail_read',
  };
  const progress = async (status: InitialProfileOutcome['status']): Promise<void> => {
    await deps.cloud('/v1/work/initial-profile/progress', 'POST', {
      lease,
      outcome: { source: mailSource, status, artifacts: mailCount },
      artifact_ids: [...ids],
    });
  };
  await progress('reading');
  if (!(await deps.connectors.connected(mailKey))) await progress('not_connected');
  else if (!deps.connectors.granted(mailKey).includes('email.read')) await progress('not_granted');
  else {
    // Metadata pools, retry waits and local inference can all take time. Keep
    // the lease alive throughout; heartbeats contain counts and IDs only.
    let heartbeat = Promise.resolve();
    const timer = setInterval(() => {
      heartbeat = heartbeat.then(() => progress('reading')).catch(() => undefined);
    }, 30_000);
    timer.unref?.();
    const finishMail = async (status: 'synced' | 'failed') => {
      clearInterval(timer);
      await heartbeat;
      await progress(status);
    };
    try {
      const read = await readInitialProfileMail({
        provider: profile.provider,
        connectors: deps.connectors,
        readBodies: Boolean(deps.analyze),
        onProgress: () => progress('reading'),
        onMetadata: async (artifacts) => {
          diagnostic.phase = 'metadata_publish';
          // Both the artifact count and encoded bytes must fit the gateway limits.
          // Keep headroom below its 1 MiB body limit for the request envelope.
          let chunk: typeof artifacts = [];
          let chunkBytes = 0;
          const byteLimit = 900 * 1024;
          const flush = async () => {
            if (!chunk.length) return;
            await deps.cloud('/v1/work/initial-profile/artifacts', 'POST', {
              lease,
              batch: { source: mailSource, cursor: null, watermark: null, artifacts: chunk },
            });
            for (const artifact of chunk) ids.add(artifact.id);
            mailCount += chunk.length;
            await progress('reading');
            chunk = [];
            chunkBytes = 0;
          };
          for (const artifact of artifacts) {
            const bytes = Buffer.byteLength(JSON.stringify(artifact), 'utf8') + 1;
            if (bytes > byteLimit) throw new Error('initial_profile_metadata_too_large');
            if (chunk.length >= 500 || chunkBytes + bytes > byteLimit) await flush();
            chunk.push(artifact);
            chunkBytes += bytes;
          }
          await flush();
          diagnostic.phase = 'mail_read';
        },
      });
      analysis = unavailable(read.selected_count);
      if (deps.analyze && read.selected_count === 0) analysis = { ...analysis, status: 'complete' };
      if (deps.analyze && read.messages.length) {
        diagnostic.phase = 'analysis';
        try {
          const result = InitialProfileAnalysis.parse(await deps.analyze(read.messages));
          const readIds = new Set(read.messages.map((message) => message.artifact.id));
          const analyzed = new Set(result.analyzed_ids);
          const excluded = new Set(result.excluded_ids);
          const claims = [...result.focus, ...result.priorities, ...result.open_items];
          if (
            analyzed.size !== result.analyzed_count ||
            analyzed.size !== result.analyzed_ids.length ||
            [...analyzed].some((id) => !readIds.has(id)) ||
            [...excluded].some((id) => !analyzed.has(id)) ||
            claims.some((claim) =>
              claim.source_ids.some((id) => !analyzed.has(id) || excluded.has(id)),
            ) ||
            (result.status === 'unavailable' &&
              (result.analyzed_count !== 0 || claims.length !== 0))
          )
            throw new Error('invalid_analysis');
          analysis = {
            ...result,
            selected_count: read.selected_count,
            status:
              result.status === 'complete' && result.analyzed_count < read.selected_count
                ? 'partial'
                : result.status,
          };
        } catch {
          deps.onDiagnostic?.('analysis', 'invalid_analysis');
          analysis = unavailable(read.selected_count);
        } finally {
          read.messages.length = 0;
        }
      }
      await finishMail('synced');
    } catch (error) {
      // Do not persist or log a provider response/body as an error message.
      const code =
        error instanceof ConnectorError && CONNECTOR_FAILURES.includes(error.reason)
          ? error.reason
          : diagnostic.phase === 'metadata_publish'
            ? 'metadata_publish_failed'
            : 'unknown';
      deps.onDiagnostic?.(diagnostic.phase, code);
      await finishMail('failed');
    } finally {
      clearInterval(timer);
    }
  }
  const loop = new WorkSyncLoop({
    connectors: deps.connectors,
    sources: google ? ['google_calendar'] : ['outlook_calendar'],
    calendarLookbackDays: 90,
    lookaheadDays: 45,
    metadataOnly: true,
    maxClassifications: 0,
    push: async (batch) => {
      await deps.cloud('/v1/work/initial-profile/artifacts', 'POST', { lease, batch });
      for (const artifact of batch.artifacts) ids.add(artifact.id);
    },
    onSourceStart: async (source) => {
      await deps.cloud('/v1/work/initial-profile/progress', 'POST', {
        lease,
        outcome: { source, status: 'reading', artifacts: 0 },
        artifact_ids: [...ids],
      });
    },
    onOutcome: async (outcome) => {
      await deps.cloud('/v1/work/initial-profile/progress', 'POST', {
        lease,
        outcome: InitialProfileOutcome.parse(outcome),
        artifact_ids: [...ids],
      });
    },
  });
  await loop.syncOnce();
  await deps.cloud('/v1/work/initial-profile/finish', 'POST', {
    lease,
    artifact_ids: [...ids],
    analysis,
  });
}
