/**
 * Work Context の同期（端末 → cloud）。Work Context 仕様、正本 §6・§21。
 *
 * 見るのは:
 *   - 繋いでいないサービスは触らない（網にも出ない）
 *   - 読む許可が無ければ読まない
 *   - 本文を取りに行かない（Gmail `format=full` / Graph `body` を要求しない）
 *   - 送るのは正規化した抜粋だけ。cursor が進む
 *   - 端末の LLM が付けた意味は乗る。読めない返事は乗せない。無くても止まらない
 *   - 1 つの source が落ちても他は進む
 */
import { describe, expect, it } from 'vitest';
import type {
  WorkArtifactBatch,
  WorkSource,
  WorkSyncAttempt,
  WorkSyncState,
} from '@genie/contracts';
import type { SecretStore } from '@genie/oauth';
import { ConnectorRuntime, type HostStep, type StepOutcome } from '../src/connector-steps.js';
import { WorkSyncLoop, semanticFrom, type WorkSyncDeps } from '../src/work-sync.js';

const NOW = new Date('2026-09-07T06:00:00.000Z');

function memoryStore(
  initial: Record<string, string> = {},
): SecretStore & { get: SecretStore['get'] } {
  const values = { ...initial };
  return {
    async get(key) {
      return values[key] ?? null;
    },
    async set(key, value) {
      values[key] = value;
    },
    async delete(key) {
      delete values[key];
    },
  };
}

const tokens = JSON.stringify({
  accessToken: 'tok',
  refreshToken: 'r',
  scopes: [],
  expiresAt: '2099-01-01T00:00:00.000Z',
});

const gmailMessage = (id: string, subject: string, labels: string[]) => ({
  id,
  threadId: `t-${id}`,
  snippet: 'ご確認をお願いします',
  internalDate: String(NOW.getTime() - 3_600_000),
  labelIds: labels,
  payload: {
    headers: [
      { name: 'From', value: 'Tanaka <tanaka@example.com>' },
      { name: 'To', value: 'me@example.com' },
      { name: 'Subject', value: subject },
    ],
  },
});

interface Harness {
  loop: WorkSyncLoop;
  urls: string[];
  batches: WorkArtifactBatch[];
  asked: HostStep[];
  attempts: { source: WorkSource; attempt: WorkSyncAttempt }[];
  sleeps: number[];
}

function harness(
  options: {
    connected?: string[];
    granted?: Record<string, string[]>;
    llm?: (step: HostStep) => StepOutcome;
    routes?: (url: string) => { status?: number; body: unknown };
    onSecretRead?: (key: string) => void;
    /** cloud に残っている続き。 */
    state?: WorkSyncState[];
    /** push を落とす（cloud が受け取れなかった）。 */
    pushFails?: boolean;
    backoffMs?: number;
    googleQuery?: string;
    microsoftQuery?: string;
    initial?: Pick<
      WorkSyncDeps,
      | 'sources'
      | 'lookbackDays'
      | 'calendarLookbackDays'
      | 'lookaheadDays'
      | 'metadataOnly'
      | 'onSourceStart'
      | 'onOutcome'
      | 'sweepNoise'
      | 'noiseSweepLimit'
    >;
  } = {},
): Harness {
  const urls: string[] = [];
  const batches: WorkArtifactBatch[] = [];
  const asked: HostStep[] = [];
  const attempts: { source: WorkSource; attempt: WorkSyncAttempt }[] = [];
  const sleeps: number[] = [];
  const fetch = (async (url: string) => {
    urls.push(url);
    const route = options.routes?.(url) ?? defaultRoutes(url);
    return new Response(JSON.stringify(route.body), { status: route.status ?? 200 });
  }) as unknown as typeof globalThis.fetch;

  const secrets = memoryStore(
    Object.fromEntries((options.connected ?? []).map((key) => [key, tokens])),
  );
  if (options.onSecretRead) {
    const original = secrets.get.bind(secrets);
    secrets.get = async (key) => {
      options.onSecretRead!(key);
      return original(key);
    };
  }
  const runtime = new ConnectorRuntime({
    secrets,
    credentialRefFor: (pluginId, connectorId) => `keychain:${pluginId}/${connectorId}`,
    grantedScopes: (pluginId) => options.granted?.[pluginId] ?? [],
    fetch,
    now: () => NOW,
  });
  const llm = options.llm
    ? {
        handles: (toolId: string) => toolId === 'llm.classify_email',
        run: async (step: HostStep) => {
          asked.push(step);
          return options.llm!(step);
        },
      }
    : undefined;
  const loop = new WorkSyncLoop({
    connectors: runtime,
    ...options.initial,
    ...(options.googleQuery ? { googleQuery: options.googleQuery } : {}),
    ...(options.microsoftQuery ? { microsoftQuery: options.microsoftQuery } : {}),
    ...(options.backoffMs === undefined ? {} : { backoffMs: options.backoffMs }),
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    ...(llm ? { llm } : {}),
    push: async (batch) => {
      if (options.pushFails) throw new Error('POST /v1/work/artifacts failed with 503');
      batches.push(batch);
    },
    ...(options.state ? { loadState: async () => options.state! } : {}),
    attempt: async (source, attempt) => {
      attempts.push({ source, attempt });
    },
    now: () => NOW,
  });
  return { loop, urls, batches, asked, attempts, sleeps };
}

function defaultRoutes(url: string): { status?: number; body: unknown } {
  if (url.includes('gmail.googleapis.com')) {
    if (url.includes('/messages?')) {
      const inbox = url.includes('labelIds=INBOX');
      return { body: { messages: [{ id: inbox ? 'in1' : 'out1' }] } };
    }
    if (url.includes('/messages/in1')) {
      return { body: gmailMessage('in1', '見積の確認をお願いします', ['INBOX', 'UNREAD']) };
    }
    if (url.includes('/messages/out1')) {
      return { body: gmailMessage('out1', 'Re: 日程の件', ['SENT']) };
    }
  }
  if (url.includes('googleapis.com/calendar')) {
    return {
      body: {
        items: [
          {
            id: 'ev1',
            summary: 'MOPITA 定例',
            start: { dateTime: '2026-09-08T01:00:00Z' },
            end: { dateTime: '2026-09-08T02:00:00Z' },
            status: 'confirmed',
          },
        ],
      },
    };
  }
  if (url.includes('graph.microsoft.com')) {
    if (url.includes('/mailFolders/inbox/')) {
      return {
        body: {
          value: [
            {
              id: 'AAMk1',
              conversationId: 'c1',
              from: { emailAddress: { name: '佐藤', address: 'sato@example.com' } },
              toRecipients: [{ emailAddress: { address: 'me@example.com' } }],
              subject: '承認をお願いします',
              bodyPreview: '稟議の承認を',
              receivedDateTime: '2026-09-07T01:00:00Z',
              isRead: false,
            },
          ],
        },
      };
    }
    if (url.includes('/mailFolders/sentitems/')) return { body: { value: [] } };
    if (url.includes('/calendarView')) return { body: { value: [] } };
    if (url.endsWith('/me/todo/lists')) {
      return { body: { value: [{ id: 'L1', displayName: 'MOPITA' }] } };
    }
    if (url.includes('/todo/lists/L1/tasks')) {
      return {
        body: {
          value: [
            {
              id: 'td1',
              title: '要件定義書レビュー',
              status: 'notStarted',
              importance: 'high',
              dueDateTime: { dateTime: '2026-09-09T00:00:00.0000000', timeZone: 'UTC' },
              lastModifiedDateTime: '2026-09-06T00:00:00Z',
            },
          ],
        },
      };
    }
  }
  return { status: 404, body: { error: { message: `no route for ${url}` } } };
}

const GOOGLE_GRANTS = {
  'com.astra.gmail': ['email.read'],
  'com.astra.google-calendar': ['calendar.read'],
};
const MICROSOFT_GRANTS = {
  'com.astra.outlook': ['email.read', 'calendar.read'],
  'com.astra.microsoft-todo': ['tasks.read'],
};

describe('syncing work context from the device', () => {
  it('excludes non-fixture Microsoft data before classification and publication', async () => {
    const h = harness({
      connected: ['com.astra.outlook/outlook'],
      granted: MICROSOFT_GRANTS,
      microsoftQuery: 'WC123456',
      routes: (url) =>
        url.includes('/calendarView')
          ? {
              body: {
                value: [
                  {
                    id: 'private',
                    subject: 'Private meeting',
                    start: { dateTime: '2026-09-07T05:00:00Z', timeZone: 'UTC' },
                    end: { dateTime: '2026-09-07T06:00:00Z', timeZone: 'UTC' },
                  },
                  {
                    id: 'fixture',
                    subject: 'WC123456 meeting',
                    start: { dateTime: '2026-09-07T05:00:00Z', timeZone: 'UTC' },
                    end: { dateTime: '2026-09-07T06:00:00Z', timeZone: 'UTC' },
                  },
                ],
              },
            }
          : defaultRoutes(url),
    });
    await h.loop.syncOnce();
    const mailUrls = h.urls.filter((url) => url.includes('/mailFolders/'));
    expect(mailUrls).toHaveLength(2);
    for (const url of mailUrls)
      expect(new URL(url).searchParams.get('$search')).toContain('WC123456');
    expect(h.batches.find((b) => b.source === 'outlook_mail')?.artifacts).toEqual([]);
    const events = h.batches.find((b) => b.source === 'outlook_calendar')?.artifacts;
    expect(events).toHaveLength(1);
    expect(events?.[0]?.title).toBe('WC123456 meeting');
    expect(JSON.stringify(h.asked)).not.toContain('Private meeting');
  });
  it('preserves incoming work when Gmail lists one self-delivered message in both folders', async () => {
    const h = harness({
      connected: ['com.astra.gmail/gmail'],
      granted: GOOGLE_GRANTS,
      routes: (url) =>
        url.includes('/messages?') ? { body: { messages: [{ id: 'in1' }] } } : defaultRoutes(url),
    });
    await h.loop.syncOnce();
    const artifacts = h.batches.find((b) => b.source === 'gmail')!.artifacts;
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]!.direction).toBe('inbound');
  });
  it('keeps promotions and bulk mail out of Work, so an ad never becomes an unreplied request', async () => {
    const h = harness({
      connected: ['com.astra.gmail/gmail'],
      granted: GOOGLE_GRANTS,
      routes: (url) => {
        if (url.includes('/messages?'))
          return url.includes('labelIds=INBOX')
            ? { body: { messages: [{ id: 'in1' }, { id: 'ad1' }] } }
            : { body: { messages: [] } };
        if (url.includes('/messages/ad1'))
          return {
            body: gmailMessage('ad1', '事前エントリー受付中◆6周年大感謝祭', [
              'INBOX',
              'IMPORTANT',
              'CATEGORY_PROMOTIONS',
            ]),
          };
        return defaultRoutes(url);
      },
    });
    await h.loop.syncOnce();
    const artifacts = h.batches.find((b) => b.source === 'gmail')!.artifacts;
    expect(artifacts.map((a) => a.id)).toEqual(['gmail:in1']);
  });
  /** 入口で除く前に取り込んだ広告を、起動ごとに 1 回だけ閉じた形で上書きする（要対応に残らない）。 */
  it('closes ads taken in before the filter, 7 days per sync back to 45 days, without moving the cursor', async () => {
    const asked: string[] = [];
    const h = harness({
      connected: ['com.astra.gmail/gmail'],
      granted: GOOGLE_GRANTS,
      initial: { sweepNoise: true },
      llm: (step) => {
        asked.push(step.id);
        return { ok: true, result: null };
      },
      routes: (url) => {
        if (url.includes('/messages?')) {
          const q = new URL(url).searchParams.get('q') ?? '';
          if (q.includes('category:promotions'))
            return { body: { messages: [{ id: 'old-ad' }, { id: 'in1' }] } };
          return url.includes('labelIds=INBOX')
            ? { body: { messages: [{ id: 'in1' }] } }
            : { body: { messages: [] } };
        }
        if (url.includes('/messages/old-ad'))
          return {
            body: gmailMessage('old-ad', 'TOBU POINT 期限のお知らせ', [
              'INBOX',
              'CATEGORY_PROMOTIONS',
            ]),
          };
        return defaultRoutes(url);
      },
    });
    await h.loop.syncOnce();
    const first = h.batches.filter((b) => b.source === 'gmail').flatMap((b) => b.artifacts);
    expect(first.map((a) => a.id)).toEqual(['gmail:in1', 'gmail:old-ad']);
    expect(first.find((a) => a.id === 'gmail:old-ad')).toMatchObject({
      responded: true,
      completed: true,
      semantic: null,
      due_at: null,
    });
    // 閉じたものは意味づけを頼まない
    expect(asked.some((id) => id.includes('old-ad'))).toBe(false);
    // cursor は普段の読み取りの分だけ（広告の時刻で進めない）
    const cursor = h.loop.cursors.get('gmail');
    expect(cursor).toBeDefined();
    // 次の同期は、その前の 7 日。受信箱のラベルで絞らない（アーカイブした広告も閉じる）。
    const sweeps = () =>
      h.urls
        .filter((url) => url.includes('/messages?') && url.includes('category%3Apromotions'))
        .map((url) => new URL(url));
    for (let i = 0; i < 10; i++) await h.loop.syncOnce();
    const windows = sweeps().map((url) => {
      const q = url.searchParams.get('q') ?? '';
      expect(url.searchParams.getAll('labelIds')).toEqual([]);
      return [Number(/after:(\d+)/.exec(q)![1]), Number(/before:(\d+)/.exec(q)![1])] as const;
    });
    // 遡りきったら止まる（45 日を 7 日ずつ: 7 回）
    expect(windows).toHaveLength(7);
    for (let i = 1; i < windows.length; i++) expect(windows[i]![1]).toBe(windows[i - 1]![0]);
    const span = (windows[0]![1] - windows.at(-1)![0]) / 86_400;
    expect(span).toBeGreaterThanOrEqual(45);
    expect(h.loop.cursors.get('gmail')).toBe(cursor);
  });

  /** 7 日で読める上限（400 通）に届いたら、読めた中でいちばん古いメールから次を続ける（7 日先へ飛ばない）。 */
  it('continues from the oldest ad it read when a slice fills the read limit', async () => {
    const h = harness({
      connected: ['com.astra.gmail/gmail'],
      granted: GOOGLE_GRANTS,
      initial: { sweepNoise: true, noiseSweepLimit: { pages: 2, pageSize: 5 } },
      routes: (url) => {
        if (url.includes('/messages?')) {
          const q = new URL(url).searchParams.get('q') ?? '';
          if (!q.includes('category:promotions')) return { body: { messages: [] } };
          const page = Number(new URL(url).searchParams.get('pageToken') ?? '0');
          return {
            body: {
              messages: Array.from({ length: 5 }, (_, i) => ({ id: `ad-${page}-${i}` })),
              ...(page < 1 ? { nextPageToken: String(page + 1) } : {}),
            },
          };
        }
        const ad = /\/messages\/(ad-(\d)-(\d+))/.exec(url);
        if (ad) {
          // 新しい順。いちばん古いのは最後のページの最後（2 日前）
          const order = Number(ad[2]) * 5 + Number(ad[3]);
          return {
            body: {
              ...gmailMessage(ad[1]!, `広告 ${order}`, ['INBOX', 'CATEGORY_PROMOTIONS']),
              internalDate: String(NOW.getTime() - (order + 1) * 432_000),
            },
          };
        }
        return defaultRoutes(url);
      },
    });
    await h.loop.syncOnce();
    await h.loop.syncOnce();
    const windows = h.urls
      .filter((url) => url.includes('/messages?') && url.includes('category%3Apromotions'))
      .filter((url) => !url.includes('pageToken'))
      .map((url) => new URL(url).searchParams.get('q') ?? '');
    expect(windows).toHaveLength(2);
    const oldest = Math.floor((NOW.getTime() - 10 * 432_000) / 1000);
    expect(windows[1]).toContain(`before:${String(oldest)}`);
  }, 20_000);

  it('restricts both Google sources before fetching mail details or classifying', async () => {
    const h = harness({
      connected: ['com.astra.gmail/gmail', 'com.astra.google-calendar/google-calendar'],
      granted: GOOGLE_GRANTS,
      googleQuery: 'WC123456',
    });
    await h.loop.syncOnce();
    const searches = h.urls.filter((url) => url.includes('/messages?') || url.includes('/events?'));
    expect(searches).toHaveLength(3);
    for (const url of searches) {
      expect(new URL(url).searchParams.get('q')).toContain('WC123456');
    }
    expect(
      new URL(searches.find((url) => url.includes('/messages?'))!).searchParams.get('q'),
    ).toContain('after:');
  });
  it('touches nothing when nothing is connected', async () => {
    const h = harness();
    const report = await h.loop.syncOnce();
    expect(report.outcomes.map((o) => o.status)).toEqual([
      'not_connected',
      'not_connected',
      'not_connected',
      'not_connected',
      'not_connected',
    ]);
    expect(h.urls).toEqual([]);
    expect(h.batches).toEqual([]);
  });

  it('syncs with the read-only connections only, even when actions are connected too', async () => {
    const reads: string[] = [];
    const h = harness({
      connected: [
        'com.astra.gmail/gmail',
        'com.astra.gmail/gmail-actions',
        'com.astra.google-calendar/google-calendar',
        'com.astra.google-calendar/google-calendar-actions',
      ],
      granted: GOOGLE_GRANTS,
      onSecretRead: (key) => reads.push(key),
    });
    const report = await h.loop.syncOnce();
    expect(report.outcomes.slice(0, 2).map((o) => o.status)).toEqual(['synced', 'synced']);
    // 送る・作る接続のトークンは一度も読まない
    expect(reads.filter((k) => k.includes('-actions'))).toEqual([]);
    // 触るのは読む接続の鍵だけ（繋いでいない source の「有無」の確認も読む接続の鍵で）
    for (const key of reads)
      expect(key).toMatch(/\/(gmail|google-calendar|outlook|microsoft-todo)(\.host-renewal)?$/);
  });

  it('does not read a connected service whose read permission was withheld', async () => {
    const h = harness({
      connected: ['com.astra.gmail/gmail'],
      granted: { 'com.astra.gmail': ['email.draft'] },
    });
    const report = await h.loop.syncOnce();
    expect(report.outcomes[0]).toMatchObject({ source: 'gmail', status: 'not_granted' });
    expect(h.urls).toEqual([]);
  });

  it('normalizes Google mail and calendar into excerpts and advances the cursor', async () => {
    const h = harness({
      connected: ['com.astra.gmail/gmail', 'com.astra.google-calendar/google-calendar'],
      granted: GOOGLE_GRANTS,
    });
    const report = await h.loop.syncOnce();

    expect(report.outcomes.slice(0, 2)).toEqual([
      { source: 'gmail', status: 'synced', artifacts: 2, classified: 0 },
      { source: 'google_calendar', status: 'synced', artifacts: 1, classified: 0 },
    ]);
    // **本文は取りに行かない。**一覧は metadata、予定は一覧だけ。
    expect(h.urls.some((u) => u.includes('format=full'))).toBe(false);
    expect(h.urls.filter((u) => u.includes('/messages?')).length).toBe(2);

    const gmail = h.batches.find((b) => b.source === 'gmail')!;
    expect(gmail.artifacts.map((a) => [a.id, a.direction])).toEqual([
      ['gmail:in1', 'inbound'],
      ['gmail:out1', 'outbound'],
    ]);
    expect(gmail.artifacts.every((a) => a.semantic === null)).toBe(true);
    expect(gmail.artifacts[0]!.provenance.external_id).toBe('in1');
    // 続きは、見た中で一番新しい時刻
    expect(gmail.cursor).toBe(new Date(NOW.getTime() - 3_600_000).toISOString());
    expect(h.loop.cursors.get('gmail')).toBe(gmail.cursor);

    // 2 回目は cursor から先だけを頼む
    h.urls.length = 0;
    await h.loop.syncOnce();
    const listing = h.urls.find((u) => u.includes('/messages?'))!;
    const after = Number(new URL(listing).searchParams.get('q')!.replace('after:', ''));
    expect(after).toBe(Math.floor((NOW.getTime() - 3_600_000) / 1000) - 1);
  });

  it('normalizes Microsoft mail, calendar and To Do the same way', async () => {
    const h = harness({
      connected: ['com.astra.outlook/outlook', 'com.astra.microsoft-todo/microsoft-todo'],
      granted: MICROSOFT_GRANTS,
    });
    const report = await h.loop.syncOnce();
    expect(report.outcomes.slice(2)).toEqual([
      { source: 'outlook_mail', status: 'synced', artifacts: 1, classified: 0 },
      { source: 'outlook_calendar', status: 'synced', artifacts: 0, classified: 0 },
      { source: 'microsoft_todo', status: 'synced', artifacts: 1, classified: 0 },
    ]);
    // 一覧で body を要求しない
    for (const url of h.urls.filter((u) => u.includes('/messages?'))) {
      expect(new URL(url).searchParams.get('$select')!.split(',')).not.toContain('body');
    }
    const todo = h.batches.find((b) => b.source === 'microsoft_todo')!;
    expect(todo.artifacts[0]).toMatchObject({
      id: 'microsoft_todo:td1',
      kind: 'task',
      project_hint: 'MOPITA',
      due_at: '2026-09-09T00:00:00.000Z',
    });
    // 0 件でも同期した事実は送る
    expect(h.batches.find((b) => b.source === 'outlook_calendar')!.artifacts).toEqual([]);
  });

  it('attaches what the device LLM extracted, and asks once per mail', async () => {
    const h = harness({
      connected: ['com.astra.gmail/gmail'],
      granted: GOOGLE_GRANTS,
      llm: (step) => ({
        ok: true,
        result: {
          category: step.args['direction'] === 'inbound' ? 'request_to_me' : 'info',
          request: '見積を確認する',
          owner: 'me',
          waiting_on: null,
          due: null,
          project: 'MOPITA',
          confidence: 0.8,
        },
      }),
    });
    const report = await h.loop.syncOnce();
    expect(report.outcomes[0]).toMatchObject({ status: 'synced', artifacts: 2, classified: 2 });
    expect(h.asked).toHaveLength(2);
    // 渡すのは件名と抜粋だけ
    expect(Object.keys(h.asked[0]!.args).sort()).toEqual([
      'direction',
      'excerpt',
      'from',
      'occurred_at',
      'subject',
      'to',
    ]);
    const inbound = h.batches[0]!.artifacts[0]!;
    expect(inbound.semantic).toMatchObject({
      category: 'request_to_me',
      project: 'MOPITA',
      extracted_by: 'llm',
      confidence: 0.8,
    });

    // 同じメールを聞き直さない
    await h.loop.syncOnce();
    expect(h.asked).toHaveLength(2);
  });

  it('sends nothing semantic when the reply is unreadable or the model is gone', async () => {
    const h = harness({
      connected: ['com.astra.gmail/gmail'],
      granted: GOOGLE_GRANTS,
      llm: () => ({ ok: false, error: { code: 'llm.no_model', message: '無い' } }),
    });
    const report = await h.loop.syncOnce();
    expect(report.outcomes[0]).toMatchObject({ status: 'synced', artifacts: 2, classified: 0 });
    expect(h.batches[0]!.artifacts.every((a) => a.semantic === null)).toBe(true);

    expect(semanticFrom({ category: 'nonsense' })).toBeNull();
    expect(semanticFrom('text')).toBeNull();
    expect(semanticFrom({ category: 'question', due: 'いつか' })).toBeNull();
    expect(
      semanticFrom({ category: 'request_to_me', project: 'ACME', due: '2026-09-11' }),
    ).toMatchObject({
      category: 'request_to_me',
      project: 'ACME',
      due: null,
    });
    expect(semanticFrom({ category: 'question' })).toMatchObject({
      category: 'question',
      extracted_by: 'llm',
      confidence: 0.5,
    });
  });

  it('keeps going when one source fails', async () => {
    const h = harness({
      connected: ['com.astra.gmail/gmail', 'com.astra.google-calendar/google-calendar'],
      granted: GOOGLE_GRANTS,
      routes: (url) =>
        url.includes('gmail.googleapis.com')
          ? { status: 500, body: { error: { message: 'boom' } } }
          : defaultRoutes(url),
    });
    const report = await h.loop.syncOnce();
    expect(report.outcomes[0]).toMatchObject({ source: 'gmail', status: 'failed' });
    expect(report.outcomes[1]).toMatchObject({ source: 'google_calendar', status: 'synced' });
    expect(h.batches.map((b) => b.source)).toEqual(['google_calendar']);
    // 落ちた source の cursor は進めない。失敗は理由つきで cloud に残す
    expect(h.loop.cursors.has('gmail')).toBe(false);
    expect(h.attempts).toEqual([
      { source: 'gmail', attempt: { ok: false, error: expect.stringContaining('boom') } },
    ]);
  });

  // 暫定: 既存のprovider障害注入を使う。実identityで同じmatrixが動いたらLive試験へ移す。
  it('waits before retrying a rate-limited read and commits the cursor only after success', async () => {
    let requestCount = 0;
    const h = harness({
      connected: ['com.astra.gmail/gmail'],
      granted: GOOGLE_GRANTS,
      backoffMs: 20,
      routes: (url) => {
        const fail = requestCount < 2;
        requestCount += 1;
        return fail
          ? { status: 429, body: { error: { message: 'rate limited' } } }
          : defaultRoutes(url);
      },
    });
    expect(h.loop.cursors.has('gmail')).toBe(false);
    const report = await h.loop.syncOnce();
    expect(report.outcomes[0]).toMatchObject({ source: 'gmail', status: 'synced' });
    expect(h.sleeps).toEqual([20]);
    expect(
      h.urls.filter((url) => url.includes('gmail.googleapis.com')).length,
    ).toBeGreaterThanOrEqual(4);
    expect(h.loop.cursors.has('gmail')).toBe(true);
    expect(h.attempts).toHaveLength(0);
  });

  for (const [status, attempts] of [
    [401, 1],
    [429, 2],
  ] as const) {
    it(`bounds ${status} retries and preserves other connectors`, async () => {
      const h = harness({
        connected: ['com.astra.gmail/gmail', 'com.astra.google-calendar/google-calendar'],
        granted: GOOGLE_GRANTS,
        backoffMs: 20,
        routes: (url) =>
          url.includes('gmail.googleapis.com')
            ? { status, body: { error: { message: `status ${status}` } } }
            : defaultRoutes(url),
      });
      const report = await h.loop.syncOnce();
      expect(report.outcomes[0]).toMatchObject({ source: 'gmail', status: 'failed' });
      expect(report.outcomes[1]).toMatchObject({ source: 'google_calendar', status: 'synced' });
      expect(h.urls.filter((url) => url.includes('gmail.googleapis.com'))).toHaveLength(
        attempts * 2,
      );
      expect(h.loop.cursors.has('gmail')).toBe(false);
      expect(h.batches.map((batch) => batch.source)).toEqual(['google_calendar']);
    });
  }

  it('resumes from the cursor the cloud kept, instead of re-reading 14 days', async () => {
    const kept = new Date(NOW.getTime() - 2 * 3_600_000).toISOString();
    const h = harness({
      connected: ['com.astra.gmail/gmail'],
      granted: GOOGLE_GRANTS,
      state: [
        {
          source: 'gmail',
          cursor: kept,
          watermark: kept,
          last_synced_at: kept,
          last_attempt_at: kept,
          last_error: null,
          artifact_count: 10,
          schema_version: 1,
        },
      ],
    });
    await h.loop.syncOnce();
    const listing = h.urls.find((u) => u.includes('/messages?'))!;
    const after = Number(new URL(listing).searchParams.get('q')!.replace('after:', ''));
    expect(after).toBe(Math.floor(Date.parse(kept) / 1000) - 1);
  });

  it('sends the cursor and the watermark with the artifacts, and does not advance when the cloud refuses', async () => {
    const h = harness({ connected: ['com.astra.gmail/gmail'], granted: GOOGLE_GRANTS });
    await h.loop.syncOnce();
    const batch = h.batches.find((b) => b.source === 'gmail')!;
    expect(batch.cursor).not.toBeNull();
    expect(batch.watermark).toBe(new Date(NOW.getTime() - 3_600_000).toISOString());

    const refused = harness({
      connected: ['com.astra.gmail/gmail'],
      granted: GOOGLE_GRANTS,
      pushFails: true,
    });
    const report = await refused.loop.syncOnce();
    expect(report.outcomes[0]).toMatchObject({ source: 'gmail', status: 'failed' });
    // cloud が受け取っていないものを「読んだ」ことにしない
    expect(refused.loop.cursors.has('gmail')).toBe(false);
    expect(refused.attempts[0]!.attempt.ok).toBe(false);
  });
});

describe('one-time profile source limits', () => {
  it('reads bounded history, strips excerpts and reports actual completed counts', async () => {
    const progress: string[] = [];
    const h = harness({
      connected: ['com.astra.gmail/gmail', 'com.astra.google-calendar/google-calendar'],
      granted: {
        'com.astra.gmail': ['email.read'],
        'com.astra.google-calendar': ['calendar.read'],
      },
      initial: {
        sources: ['gmail', 'google_calendar'],
        lookbackDays: 45,
        calendarLookbackDays: 90,
        lookaheadDays: 45,
        metadataOnly: true,
        onSourceStart: async (source) => {
          progress.push(`start:${source}`);
        },
        onOutcome: async (outcome) => {
          progress.push(`${outcome.source}:${outcome.status}:${outcome.artifacts}`);
        },
      },
    });
    await h.loop.syncOnce();
    expect(progress).toEqual([
      'start:gmail',
      'gmail:synced:2',
      'start:google_calendar',
      'google_calendar:synced:1',
    ]);
    expect(
      h.batches
        .flatMap((b) => b.artifacts)
        .every((a) => a.body_excerpt === null && a.provenance.excerpt === null),
    ).toBe(true);
    expect(h.urls.some((url) => url.includes('graph.microsoft.com'))).toBe(false);
    const calendar = new URL(h.urls.find((url) => url.includes('googleapis.com/calendar'))!);
    expect(calendar.searchParams.get('timeMin')).toBe(
      new Date(NOW.getTime() - 90 * 86400000).toISOString(),
    );
    expect(calendar.searchParams.get('timeMax')).toBe(
      new Date(NOW.getTime() + 45 * 86400000).toISOString(),
    );
    expect(
      h.urls
        .filter((url) => url.includes('/messages?'))
        .every((url) => new URL(url).searchParams.get('maxResults') === '50'),
    ).toBe(true);
  });
});
