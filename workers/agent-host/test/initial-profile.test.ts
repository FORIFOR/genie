import { describe, expect, it, vi } from 'vitest';
import { uuidv7, type InitialProfileAnalysis } from '@genie/contracts';
import { ConnectorError, CONNECTOR_FAILURES } from '@genie/service-connectors';
import type { ConnectorRuntime } from '../src/connector-steps.js';
import { runInitialProfile } from '../src/initial-profile.js';

describe('initial profile job', () => {
  it('does not read providers when no initial job is pending', async () => {
    const cloud = vi.fn().mockResolvedValue({ job: null });
    const refreshGrants = vi.fn();
    await runInitialProfile({ cloud, refreshGrants, connectors: {} as ConnectorRuntime });
    expect(cloud).toHaveBeenCalledTimes(1);
    expect(refreshGrants).not.toHaveBeenCalled();
  });
  it('reports unconnected sources honestly and never requests another provider', async () => {
    const called: string[] = [];
    const lease = uuidv7();
    const cloud = vi.fn(async (path: string, _method: string, _body?: unknown) => {
      if (path.endsWith('/claim'))
        return {
          job: {
            lease,
            profile: {
              id: uuidv7(),
              provider: 'microsoft',
              status: 'analysing',
              started_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
              outcomes: [],
              sections: null,
              profile: null,
            },
          },
        };
      return null;
    });
    await runInitialProfile({
      cloud,
      refreshGrants: async () => {},
      connectors: {
        connected: async (key: string) => {
          called.push(key);
          return false;
        },
      } as unknown as ConnectorRuntime,
    });
    expect(called).toEqual(['outlook', 'outlook']);
    const outcomes = cloud.mock.calls
      .filter(([path]) => path.endsWith('/progress'))
      .map(([, , body]) => body);
    expect(outcomes).toHaveLength(4);
    expect(outcomes).toContainEqual({
      lease,
      outcome: { source: 'outlook_mail', status: 'not_connected', artifacts: 0 },
      artifact_ids: [],
    });
    expect(cloud).toHaveBeenLastCalledWith('/v1/work/initial-profile/finish', 'POST', {
      lease,
      artifact_ids: [],
      analysis: {
        version: 2,
        status: 'unavailable',
        selected_count: 0,
        analyzed_count: 0,
        analyzed_ids: [],
        excluded_ids: [],
        focus: [],
        priorities: [],
        open_items: [],
      },
    });
  });
});

function profileHarness(
  options: {
    failedBody?: boolean;
    automated?: boolean;
    metadataPending?: Promise<void>;
    summaryCount?: number;
    subject?: string;
  } = {},
) {
  const now = new Date();
  const summaries = (
    options.summaryCount === undefined
      ? ['one', 'two']
      : Array.from({ length: options.summaryCount }, (_, i) => `mail-${i}`)
  ).map((id) => ({
    id,
    threadId: id,
    from: 'A <a@example.invalid>',
    to: ['me@example.invalid'],
    subject: options.subject ?? '作業の確認',
    snippet: 'PRIVATE_SNIPPET',
    receivedAt: now.toISOString(),
    unread: false,
    hasAttachments: false,
    listUnsubscribe: options.automated ?? false,
  }));
  const get = vi.fn(async (id: string) => {
    if (options.failedBody && id === 'two') throw new Error('PRIVATE_PROVIDER_FAILURE');
    return { id, body: 'PRIVATE_BODY_SENTINEL', bodyIsHtml: false };
  });
  const connectors = {
    connected: async (key: string) => key === 'gmail',
    granted: () => ['email.read'],
    gmail: () => ({
      list: async (args: { query?: string; labelIds?: string[] }) => {
        await options.metadataPending;
        if (args.query?.includes('{is:important')) return [];
        if (args.labelIds)
          return summaries.slice(400).map((item) => ({
            ...item,
            from: 'Me <me@example.invalid>',
            to: ['a@example.invalid'],
          }));
        return summaries.slice(0, 400);
      },
      get,
    }),
  } as unknown as ConnectorRuntime;
  const calls: { path: string; body?: unknown }[] = [];
  const cloud = async (path: string, _method: string, body?: unknown) => {
    calls.push({ path, body });
    if (path.endsWith('/claim'))
      return {
        job: {
          lease: uuidv7(),
          profile: {
            id: uuidv7(),
            provider: 'google',
            status: 'analysing',
            started_at: now.toISOString(),
            updated_at: now.toISOString(),
            outcomes: [],
            sections: null,
            profile: null,
          },
        },
      };
    return {};
  };
  const finish = () =>
    calls.find((call) => call.path.endsWith('/finish'))!.body as {
      analysis: InitialProfileAnalysis;
    };
  return { connectors, cloud, calls, get, finish };
}
const analyzed = (ids: string[]): InitialProfileAnalysis => ({
  version: 2,
  status: 'complete',
  selected_count: ids.length,
  analyzed_count: ids.length,
  analyzed_ids: ids,
  excluded_ids: [],
  focus: ids.length ? [{ text: '共同資料の見直し', source_ids: [ids[0]!] }] : [],
  priorities: [],
  open_items: [],
});
describe('initial body analysis boundary', () => {
  it('safely publishes wide metadata searches and analyzes exactly one hundred bodies', async () => {
    const h = profileHarness({ summaryCount: 600, subject: 'あ'.repeat(500) });
    await runInitialProfile({
      ...h,
      refreshGrants: async () => {},
      analyze: async (messages) => {
        expect(messages).toHaveLength(100);
        return analyzed(messages.map((message) => message.artifact.id));
      },
    });
    const batches = h.calls.filter((call) => call.path.endsWith('/artifacts'));
    expect(batches.length).toBeGreaterThan(1);
    const ids = batches.flatMap((call) => {
      const batch = call.body as { batch: { artifacts: { id: string }[] } };
      expect(batch.batch.artifacts.length).toBeLessThanOrEqual(500);
      expect(Buffer.byteLength(JSON.stringify(call.body), 'utf8')).toBeLessThan(1024 * 1024);
      return batch.batch.artifacts.map((artifact) => artifact.id);
    });
    expect(new Set(ids).size).toBe(600);
    expect(ids.length).toBe(600);
    expect(h.get).toHaveBeenCalledTimes(100);
    expect(h.finish().analysis).toMatchObject({
      selected_count: 100,
      analyzed_count: 100,
      status: 'complete',
    });
    expect(
      h.calls.filter((call) => call.path.endsWith('/progress')).map((call) => call.body),
    ).toContainEqual({
      lease: expect.any(String),
      outcome: { source: 'gmail', status: 'synced', artifacts: 600 },
      artifact_ids: ids,
    });
    expect(JSON.stringify(h.calls)).not.toMatch(/PRIVATE_BODY|PRIVATE_SNIPPET/);
  });
  it('does not read bodies without an analyzer and never publishes snippets', async () => {
    const h = profileHarness();
    await runInitialProfile({ ...h, refreshGrants: async () => {} });
    expect(h.get).not.toHaveBeenCalled();
    expect(h.finish().analysis).toMatchObject({
      status: 'unavailable',
      selected_count: 2,
      analyzed_count: 0,
    });
    expect(JSON.stringify(h.calls)).not.toMatch(/PRIVATE_BODY|PRIVATE_SNIPPET/);
  });
  it('sends only metadata and grounded findings, marking a failed body read partial', async () => {
    const h = profileHarness({ failedBody: true });
    await runInitialProfile({
      ...h,
      refreshGrants: async () => {},
      analyze: async (messages) => {
        expect(messages).toHaveLength(1);
        expect(messages[0]!.body).toBe('PRIVATE_BODY_SENTINEL');
        return analyzed(messages.map((message) => message.artifact.id));
      },
    });
    expect(h.finish().analysis).toMatchObject({
      status: 'partial',
      selected_count: 2,
      analyzed_count: 1,
      analyzed_ids: ['gmail:one'],
    });
    expect(JSON.stringify(h.calls)).not.toMatch(
      /PRIVATE_BODY|PRIVATE_SNIPPET|PRIVATE_PROVIDER_FAILURE/,
    );
    const batch = h.calls.find((call) => call.path.endsWith('/artifacts'))!.body as {
      batch: { artifacts: { body_excerpt: unknown; provenance: { excerpt: unknown } }[] };
    };
    expect(
      batch.batch.artifacts.every((a) => a.body_excerpt === null && a.provenance.excerpt === null),
    ).toBe(true);
  });
  it('rejects results referring to bodies the worker did not read', async () => {
    const h = profileHarness();
    await runInitialProfile({
      ...h,
      refreshGrants: async () => {},
      analyze: async () => analyzed(['gmail:forged']),
    });
    expect(h.finish().analysis).toMatchObject({
      status: 'unavailable',
      selected_count: 2,
      analyzed_count: 0,
      focus: [],
    });
    expect(JSON.stringify(h.calls)).not.toContain('gmail:forged');
  });
  it('treats zero eligible messages as complete without a model or body call', async () => {
    const h = profileHarness({ automated: true });
    const analyze = vi.fn(async () => analyzed([]));
    await runInitialProfile({ ...h, refreshGrants: async () => {}, analyze });
    expect(analyze).not.toHaveBeenCalled();
    expect(h.get).not.toHaveBeenCalled();
    expect(h.finish().analysis).toMatchObject({
      status: 'complete',
      selected_count: 0,
      analyzed_count: 0,
    });
  });
  it('keeps the lease alive while local inference is pending, then ends reading', async () => {
    vi.useFakeTimers();
    try {
      const h = profileHarness();
      let done!: (result: InitialProfileAnalysis) => void;
      const waiting = new Promise<InitialProfileAnalysis>((resolve) => {
        done = resolve;
      });
      const run = runInitialProfile({
        ...h,
        refreshGrants: async () => {},
        analyze: async () => waiting,
      });
      await vi.advanceTimersByTimeAsync(60_001);
      const progress = h.calls.filter((call) => call.path.endsWith('/progress'));
      expect(progress.length).toBeGreaterThanOrEqual(5);
      done(analyzed(['gmail:one', 'gmail:two']));
      await run;
      expect(h.finish().analysis.status).toBe('complete');
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
  it('keeps the lease alive during metadata waits and stops heartbeats before the final outcome', async () => {
    vi.useFakeTimers();
    try {
      let done!: () => void;
      const metadataPending = new Promise<void>((resolve) => {
        done = resolve;
      });
      const h = profileHarness({ metadataPending });
      const run = runInitialProfile({ ...h, refreshGrants: async () => {} });
      await vi.advanceTimersByTimeAsync(60_001);
      expect(h.calls.filter((call) => call.path.endsWith('/progress'))).toHaveLength(3);
      expect(h.calls.some((call) => call.path.endsWith('/artifacts'))).toBe(false);
      done();
      await run;
      const lastMailProgress = h.calls
        .filter(
          (call) =>
            call.path.endsWith('/progress') &&
            (call.body as { outcome: { source: string } }).outcome.source === 'gmail',
        )
        .at(-1);
      expect(lastMailProgress?.body).toMatchObject({
        outcome: { source: 'gmail', status: 'synced' },
      });
      expect(vi.getTimerCount()).toBe(0);
      expect(JSON.stringify(h.calls)).not.toMatch(/PRIVATE_BODY|PRIVATE_SNIPPET/);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('initial profile diagnostic privacy', () => {
  const privateDetail = 'SYNTHETIC_PRIVATE_BODY Bearer SYNTHETIC_PRIVATE_SECRET';
  function failingMail(error: unknown) {
    const h = profileHarness();
    const connectors = {
      ...h.connectors,
      gmail: () => ({
        ...h.connectors.gmail(),
        list: async () => {
          throw error;
        },
      }),
    } as unknown as ConnectorRuntime;
    return { ...h, connectors };
  }

  it.each(CONNECTOR_FAILURES)(
    'logs only the allowlisted %s code for a provider failure',
    async (code) => {
      const toJSON = vi.fn(() => ({ response: privateDetail }));
      const error = Object.assign(new ConnectorError(code, privateDetail), {
        response: { body: privateDetail, authorization: privateDetail },
        cause: new Error(privateDetail),
        toJSON,
      });
      const h = failingMail(error);
      const onDiagnostic = vi.fn();
      await runInitialProfile({ ...h, refreshGrants: async () => {}, onDiagnostic });
      expect(onDiagnostic.mock.calls).toEqual([['mail_read', code]]);
      expect(toJSON).not.toHaveBeenCalled();
      expect(h.get).not.toHaveBeenCalled();
      expect(h.finish().analysis).toMatchObject({ status: 'unavailable', analyzed_count: 0 });
      expect(JSON.stringify([onDiagnostic.mock.calls, h.calls])).not.toContain(
        'SYNTHETIC_PRIVATE_',
      );
    },
  );

  it.each([
    [
      'arbitrary ConnectorError reason',
      (): unknown =>
        Object.assign(new ConnectorError('provider_error', privateDetail), {
          reason: 'SYNTHETIC_PRIVATE_REASON',
        }),
    ],
    [
      'spoofed error name and known reason',
      (): unknown =>
        Object.assign(new Error(privateDetail), { name: 'ConnectorError', reason: 'rate_limited' }),
    ],
    [
      'plain provider object',
      (): unknown => ({
        message: privateDetail,
        reason: 'SYNTHETIC_PRIVATE_REASON',
        response: privateDetail,
      }),
    ],
    ['raw string', (): unknown => privateDetail],
  ] as const)('does not trust %s as a diagnostic code', async (_name, makeError) => {
    const h = failingMail(makeError());
    const onDiagnostic = vi.fn();
    await runInitialProfile({ ...h, refreshGrants: async () => {}, onDiagnostic });
    expect(onDiagnostic.mock.calls).toEqual([['mail_read', 'unknown']]);
    expect(JSON.stringify([onDiagnostic.mock.calls, h.calls])).not.toContain('SYNTHETIC_PRIVATE_');
  });

  it('reports metadata publishing failures without the rejected payload or server response', async () => {
    const h = profileHarness();
    const onDiagnostic = vi.fn();
    await runInitialProfile({
      ...h,
      refreshGrants: async () => {},
      onDiagnostic,
      cloud: async (path, method, body) => {
        if (path.endsWith('/artifacts'))
          throw Object.assign(new Error(privateDetail), {
            reason: privateDetail,
            response: privateDetail,
          });
        return h.cloud(path, method, body);
      },
    });
    expect(onDiagnostic.mock.calls).toEqual([['metadata_publish', 'metadata_publish_failed']]);
    expect(h.get).not.toHaveBeenCalled();
    expect(h.finish().analysis).toMatchObject({
      status: 'unavailable',
      selected_count: 0,
      analyzed_count: 0,
    });
    expect(JSON.stringify([onDiagnostic.mock.calls, h.calls])).not.toContain('SYNTHETIC_PRIVATE_');
  });

  it.each(['throws', 'invalid findings'] as const)(
    'redacts analysis failure when the analyzer %s',
    async (mode) => {
      const h = profileHarness();
      const onDiagnostic = vi.fn();
      await runInitialProfile({
        ...h,
        refreshGrants: async () => {},
        onDiagnostic,
        analyze: async () => {
          if (mode === 'throws') throw new Error(privateDetail);
          return {
            ...analyzed(['gmail:one', 'gmail:two']),
            focus: [{ text: privateDetail, source_ids: ['SYNTHETIC_PRIVATE_FORGED_ID'] }],
          };
        },
      });
      expect(onDiagnostic.mock.calls).toEqual([['analysis', 'invalid_analysis']]);
      expect(h.finish().analysis).toMatchObject({
        status: 'unavailable',
        selected_count: 2,
        analyzed_count: 0,
        focus: [],
      });
      expect(JSON.stringify([onDiagnostic.mock.calls, h.calls])).not.toMatch(
        /SYNTHETIC_PRIVATE_|PRIVATE_BODY|PRIVATE_SNIPPET/,
      );
    },
  );

  it('keeps an individual body failure private while preserving valid partial analysis', async () => {
    const h = profileHarness({ failedBody: true });
    const onDiagnostic = vi.fn();
    await runInitialProfile({
      ...h,
      refreshGrants: async () => {},
      onDiagnostic,
      analyze: async (messages) => analyzed(messages.map((message) => message.artifact.id)),
    });
    expect(onDiagnostic).not.toHaveBeenCalled();
    expect(h.finish().analysis).toMatchObject({
      status: 'partial',
      selected_count: 2,
      analyzed_count: 1,
    });
    expect(JSON.stringify(h.calls)).not.toMatch(
      /PRIVATE_BODY|PRIVATE_SNIPPET|PRIVATE_PROVIDER_FAILURE/,
    );
  });
});
