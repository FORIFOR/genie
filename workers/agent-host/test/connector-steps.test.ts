/**
 * 端末で connector を走らせる部分。正本 §2.4・§21。
 *
 * ここが**トークンが存在する唯一の場所**なので、見るのは:
 *   - 鍵が外へ出ないこと
 *   - 承認の無い送信・削除が実行されないこと
 *   - 失敗が理由つきで返ること
 */
import { describe, expect, it, vi } from 'vitest';
import { connectorProviderConfig, type SecretStore } from '@genie/oauth';
import { ConnectorRuntime, credentialFingerprint } from '../src/connector-steps.js';
import type { HostStep } from '../src/connector-steps.js';

const ACCESS = 'ya29.test-access-token';

function memoryStore(initial: Record<string, string> = {}): SecretStore & {
  values: Record<string, string>;
} {
  const values = { ...initial };
  return {
    values,
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

const tokenSet = (over: Record<string, unknown> = {}): string =>
  JSON.stringify({
    accessToken: ACCESS,
    refreshToken: 'refresh-1',
    scopes: [],
    expiresAt: '2099-01-01T00:00:00.000Z',
    ...over,
  });

/** 読む接続と送る接続の両方が繋がっている端末。 */
const connected = (over: Record<string, unknown> = {}): Record<string, string> => ({
  'com.astra.gmail/gmail': tokenSet(over),
  'com.astra.gmail/gmail-actions': tokenSet(over),
  'com.astra.google-calendar/google-calendar': tokenSet(),
  'com.astra.google-calendar/google-calendar-actions': tokenSet(),
});

interface Sent {
  url: string;
  authorization: string | undefined;
  body: unknown;
}

function runtime(
  secrets: SecretStore,
  scopes: readonly string[] = ['email.read', 'email.draft', 'email.modify', 'email.send'],
): { runtime: ConnectorRuntime; sent: Sent[] } {
  const sent: Sent[] = [];
  const fetch = (async (url: string, init: RequestInit) => {
    const headers = init.headers as Record<string, string>;
    sent.push({
      url,
      authorization: headers?.['authorization'],
      body: init.body ? JSON.parse(init.body as string) : undefined,
    });
    return new Response(JSON.stringify({ id: 'm1', threadId: 't1' }), { status: 200 });
  }) as unknown as typeof globalThis.fetch;

  return {
    sent,
    runtime: new ConnectorRuntime({
      secrets,
      credentialRefFor: (pluginId, connectorId) => `keychain:${pluginId}/${connectorId}`,
      grantedScopes: (pluginId) =>
        pluginId === 'com.astra.gmail' ? scopes : ['calendar.read', 'calendar.write'],
      fetch,
      now: () => new Date('2026-08-27T00:00:00.000Z'),
    }),
  };
}

const step = (over: Partial<HostStep> = {}): HostStep => ({
  id: 'req-1',
  toolId: 'mail.send',
  args: { to: ['a@example.com'], subject: 's', body: 'b' },
  approval: null,
  ...over,
});

const approved = (operationId: string): HostStep['approval'] => ({
  approvalId: 'ap-1',
  operationId,
  decision: 'APPROVED',
  decidedBy: 'user-1',
  decidedAt: '2026-08-26T23:59:00.000Z',
  expiresAt: '2026-08-27T00:05:00.000Z',
});

describe('running a connector step on the device', () => {
  it('only takes the steps this device can run', () => {
    const { runtime: r } = runtime(memoryStore(connected()));
    expect(r.handles('mail.send')).toBe(true);
    expect(r.handles('calendar.create_event')).toBe(true);
    expect(r.handles('outlook.mail.search')).toBe(true);
    expect(r.handles('todo.list_tasks')).toBe(true);
    expect(r.handles('crm.write')).toBe(false);
  });

  it('says which connections have tokens on this device, without revealing them', async () => {
    const { runtime: r } = runtime(memoryStore(connected()));
    expect(await r.connected('gmail')).toBe(true);
    expect(await r.connected('gmail-actions')).toBe(true);
    expect(await r.connected('outlook')).toBe(false);
    expect(await r.connected('microsoft-todo')).toBe(false);
  });

  it('reads with the read-only connection and never touches the actions token', async () => {
    // 読む接続だけが繋がっている端末（Work Context を使い始めた直後の形）
    const store = memoryStore({ 'com.astra.gmail/gmail': tokenSet() });
    const reads: string[] = [];
    const original = store.get.bind(store);
    store.get = async (key) => {
      reads.push(key);
      return original(key);
    };
    const { runtime: r, sent } = runtime(store);
    const outcome = await r.run(step({ toolId: 'mail.search', args: {} }));
    expect(outcome.ok).toBe(true);
    expect(sent[0]!.authorization).toBe(`Bearer ${ACCESS}`);
    // 読むのは読む接続と、その更新分の別項目だけ
    expect(reads).toEqual(['com.astra.gmail/gmail', 'com.astra.gmail/gmail.host-renewal']);
  });

  it('routes an Outlook reply to the actions connection, and asks for it with its purpose when absent', async () => {
    const store = memoryStore({ 'com.astra.outlook/outlook': tokenSet() });
    const sent: Sent[] = [];
    const fetch = (async (url: string, init: RequestInit) => {
      const headers = init.headers as Record<string, string>;
      sent.push({
        url,
        authorization: headers?.['authorization'],
        body: init.body ? JSON.parse(init.body as string) : undefined,
      });
      return new Response('', { status: 202 });
    }) as unknown as typeof globalThis.fetch;
    const r = new ConnectorRuntime({
      secrets: store,
      credentialRefFor: (pluginId, connectorId) => `keychain:${pluginId}/${connectorId}`,
      grantedScopes: (pluginId) =>
        pluginId === 'com.astra.outlook' ? ['email.read', 'calendar.read', 'email.send'] : [],
      fetch,
      now: () => new Date('2026-08-27T00:00:00.000Z'),
    });
    expect(r.handles('outlook.mail.reply')).toBe(true);
    const missing = await r.run(
      step({
        toolId: 'outlook.mail.reply',
        args: { message_id: 'AAMk1', comment: 'ok' },
        approval: approved('outlook.mail.reply'),
      }),
    );
    expect(missing.ok).toBe(false);
    expect(missing.error!.code).toBe('connector.not_connected');
    expect(missing.error!.message).toContain('Outlook（返信を送る）');
    expect(sent).toEqual([]);
    await store.set('com.astra.outlook/outlook-actions', tokenSet({ accessToken: 'ms-actions' }));
    const ok = await r.run(
      step({
        toolId: 'outlook.mail.reply',
        args: { message_id: 'AAMk1', comment: 'ok' },
        approval: approved('outlook.mail.reply'),
      }),
    );
    expect(ok.ok).toBe(true);
    expect(sent[0]!.url).toBe('https://graph.microsoft.com/v1.0/me/messages/AAMk1/reply');
    expect(sent[0]!.authorization).toBe('Bearer ms-actions');
    // 承認が無ければ、接続があっても送らない
    const unapproved = await r.run(
      step({
        toolId: 'outlook.mail.reply',
        args: { message_id: 'AAMk1', comment: 'ok' },
        approval: null,
      }),
    );
    expect(unapproved.error!.code).toBe('connector.approval_required');
    expect(sent).toHaveLength(1);
  });

  it('asks for the actions connection, with its purpose, before sending — and sends nothing', async () => {
    const store = memoryStore({ 'com.astra.gmail/gmail': tokenSet() });
    const { runtime: r, sent } = runtime(store);
    const outcome = await r.run(step({ approval: approved('gmail.send') }));
    expect(outcome.ok).toBe(false);
    expect(outcome.error!.code).toBe('connector.not_connected');
    // 何のために、どの接続が要るかを言う（purpose-first）。読む接続があっても送らない。
    expect(outcome.error!.message).toContain('Gmail（下書き・送信・整理）');
    expect(outcome.error!.message).toContain('承認したメールを送り');
    expect(sent).toEqual([]);
  });

  it('reads Outlook only with email.read, and never sends anywhere but Graph', async () => {
    const store = memoryStore({
      'com.astra.outlook/outlook': JSON.stringify({
        accessToken: 'ms-access',
        refreshToken: 'r',
        scopes: [],
        expiresAt: '2099-01-01T00:00:00.000Z',
      }),
    });
    const sent: Sent[] = [];
    const fetch = (async (url: string, init: RequestInit) => {
      const headers = init.headers as Record<string, string>;
      sent.push({ url, authorization: headers?.['authorization'], body: undefined });
      return new Response(JSON.stringify({ value: [] }), { status: 200 });
    }) as unknown as typeof globalThis.fetch;
    const granted: Record<string, string[]> = { 'com.astra.outlook': ['calendar.read'] };
    const r = new ConnectorRuntime({
      secrets: store,
      credentialRefFor: (pluginId, connectorId) => `keychain:${pluginId}/${connectorId}`,
      grantedScopes: (pluginId) => granted[pluginId] ?? [],
      fetch,
      now: () => new Date('2026-08-27T00:00:00.000Z'),
    });

    const refused = await r.run(step({ toolId: 'outlook.mail.search', args: {} }));
    expect(refused.ok).toBe(false);
    expect(refused.error!.code).toBe('connector.insufficient_scope');
    expect(sent).toEqual([]);

    granted['com.astra.outlook'] = ['email.read', 'calendar.read'];
    const ok = await r.run(step({ toolId: 'outlook.mail.search', args: { max_results: 5 } }));
    expect(ok.ok).toBe(true);
    expect(sent[0]!.url).toContain('https://graph.microsoft.com/v1.0/me/mailFolders/inbox/');
    expect(sent[0]!.authorization).toBe('Bearer ms-access');
  });

  it('will not send without the approval that the cloud granted', async () => {
    const { runtime: r, sent } = runtime(memoryStore(connected()));
    const outcome = await r.run(step());

    expect(outcome.ok).toBe(false);
    expect(outcome.error!.code).toBe('connector.approval_required');
    // 確かめる前に一度も外へ出していない
    expect(sent).toEqual([]);
  });

  it('sends once the approval travelled with the step', async () => {
    const { runtime: r, sent } = runtime(memoryStore(connected()));
    const outcome = await r.run(step({ approval: approved('gmail.send') }));

    expect(outcome.ok).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.url).toContain('/messages/send');
  });

  it('will not trash without approval either', async () => {
    const { runtime: r, sent } = runtime(memoryStore(connected()));
    const outcome = await r.run(
      step({ toolId: 'mail.trash', args: { message_id: 'm1' }, approval: null }),
    );
    expect(outcome.error!.code).toBe('connector.approval_required');
    expect(sent).toEqual([]);
  });

  it('drafts without asking anyone, because a draft is not sent', async () => {
    const { runtime: r, sent } = runtime(memoryStore(connected()));
    const outcome = await r.run(step({ toolId: 'mail.draft.create' }));
    expect(outcome.ok).toBe(true);
    expect(sent[0]!.url).toContain('/drafts');
  });

  it('reads the token at call time and sends it only to the provider', async () => {
    const store = memoryStore(connected());
    const { runtime: r, sent } = runtime(store);
    await r.run(step({ approval: approved('gmail.send') }));

    expect(sent[0]!.authorization).toBe(`Bearer ${ACCESS}`);
    // 端末の外へ出るのは提供者への 1 本だけ
    expect(sent).toHaveLength(1);
    expect(sent[0]!.url.startsWith('https://gmail.googleapis.com/')).toBe(true);
  });

  it('says it is not connected rather than failing at the provider', async () => {
    const { runtime: r, sent } = runtime(memoryStore());
    const outcome = await r.run(step({ approval: approved('gmail.send') }));

    expect(outcome.error!.code).toBe('connector.not_connected');
    expect(outcome.error!.message).toContain('接続');
    expect(sent).toEqual([]);
  });

  it('asks to be connected again when the token expired and cannot be renewed', async () => {
    const store = memoryStore({
      'com.astra.gmail/gmail': JSON.stringify({
        accessToken: ACCESS,
        refreshToken: null,
        scopes: [],
        expiresAt: '2026-08-26T00:00:00.000Z',
      }),
    });
    const { runtime: r } = runtime(store);
    // 読む接続の期限切れは、読む tool で分かる（送る tool は別の接続を見る）
    const outcome = await r.run(step({ toolId: 'mail.search', args: {} }));
    expect(outcome.error!.code).toBe('connector.token_expired');
  });

  it('refuses a step whose scope was never granted, before touching the network', async () => {
    const { runtime: r, sent } = runtime(memoryStore(connected()), ['email.read']);
    const outcome = await r.run(step({ approval: approved('gmail.send') }));

    expect(outcome.error!.code).toBe('connector.insufficient_scope');
    expect(sent).toEqual([]);
  });

  it('does not quietly succeed on a step it does not know', async () => {
    const { runtime: r } = runtime(memoryStore(connected()));
    const outcome = await r.run(step({ toolId: 'mail.archive' }));
    expect(outcome.ok).toBe(false);
    expect(outcome.error!.code).toBe('connector.not_found');
  });

  it('reads an all-day calendar event as a date, not a time', async () => {
    const store = memoryStore(connected());
    const sent: Sent[] = [];
    const fetch = (async (url: string, init: RequestInit) => {
      sent.push({
        url,
        authorization: undefined,
        body: init.body ? JSON.parse(init.body as string) : undefined,
      });
      return new Response(JSON.stringify({ id: 'e1', status: 'confirmed' }), { status: 200 });
    }) as unknown as typeof globalThis.fetch;

    const r = new ConnectorRuntime({
      secrets: store,
      credentialRefFor: (p, c) => `keychain:${p}/${c}`,
      grantedScopes: () => ['calendar.read', 'calendar.write'],
      fetch,
      now: () => new Date('2026-08-27T00:00:00.000Z'),
    });

    await r.run(
      step({
        toolId: 'calendar.create_event',
        args: { title: '休暇', start: '2026-09-01', end: '2026-09-02' },
        approval: approved('calendar.create'),
      }),
    );

    expect(sent[0]!.body).toMatchObject({ start: { date: '2026-09-01' } });
  });

  // 仕様 v1.0 §11: 承認された「午後にずらして」を、この端末の Google カレンダーで変える
  it('moves a calendar event with approval through the actions connection, returning before and after', async () => {
    const store = memoryStore(connected());
    const sent: Sent[] = [];
    const fetch = (async (url: string, init: RequestInit) => {
      sent.push({
        url,
        authorization: undefined,
        body: init.body ? JSON.parse(init.body as string) : undefined,
      });
      const at = (init.method ?? 'GET') === 'GET' ? '10' : '14';
      return new Response(
        JSON.stringify({
          id: 'ev-1',
          summary: '定例ミーティング',
          status: 'confirmed',
          start: { dateTime: `2026-10-28T${at}:00:00+09:00` },
          end: { dateTime: `2026-10-28T${String(Number(at) + 1)}:00:00+09:00` },
        }),
        { status: 200 },
      );
    }) as unknown as typeof globalThis.fetch;
    const r = new ConnectorRuntime({
      secrets: store,
      credentialRefFor: (p, c) => `keychain:${p}/${c}`,
      grantedScopes: () => ['calendar.read', 'calendar.write'],
      fetch,
      now: () => new Date('2026-08-27T00:00:00.000Z'),
    });
    expect(r.handles('calendar.move_event')).toBe(true);
    const args = {
      event_id: 'ev-1',
      start: '2026-10-28T14:00:00+09:00',
      end: '2026-10-28T15:00:00+09:00',
      time_zone: 'Asia/Tokyo',
    };
    // 承認が無い・別の操作の承認では変えない
    expect((await r.run(step({ toolId: 'calendar.move_event', args }))).ok).toBe(false);
    expect(
      (
        await r.run(
          step({ toolId: 'calendar.move_event', args, approval: approved('calendar.create') }),
        )
      ).ok,
    ).toBe(false);
    expect(sent).toHaveLength(0);

    const outcome = await r.run(
      step({ toolId: 'calendar.move_event', args, approval: approved('calendar.move') }),
    );
    expect(outcome.ok).toBe(true);
    expect(outcome.result).toMatchObject({
      before: { start: { dateTime: '2026-10-28T10:00:00+09:00' } },
      after: { start: { dateTime: '2026-10-28T14:00:00+09:00' } },
    });
    expect(sent[1]!.body).toMatchObject({
      start: { dateTime: '2026-10-28T14:00:00+09:00', timeZone: 'Asia/Tokyo' },
    });
  });

  it('never writes the token into what it returns', async () => {
    const { runtime: r } = runtime(memoryStore(connected()));
    const outcome = await r.run(step({ approval: approved('gmail.send') }));
    expect(JSON.stringify(outcome)).not.toContain(ACCESS);
  });
});

describe('native Google credentials after host refresh', () => {
  const key = 'com.astra.gmail/gmail';
  const grantedScope = 'https://www.googleapis.com/auth/gmail.readonly';
  const nativeCredential = {
    clientId: 'google-read-client',
    accessToken: 'old-access',
    refreshToken: 'existing-refresh',
    expiresAt: '2020-01-01T00:00:00.000Z',
    grantedScopes: [grantedScope, 'openid'],
    tokenType: 'Bearer',
    accountLabel: 'tester@example.invalid',
  };

  function refreshing(over: Record<string, unknown> = {}, rejected = false) {
    const reported: [string, string, string][] = [];
    const secrets = memoryStore({ [key]: JSON.stringify({ ...nativeCredential, ...over }) });
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes('/token')) {
        expect(new URLSearchParams(String(init?.body)).get('client_id')).toBe('google-read-client');
        return new Response(
          JSON.stringify(
            rejected
              ? { error: 'invalid_grant' }
              : { access_token: 'renewed-access', expires_in: 3600, scope: grantedScope },
          ),
          { status: rejected ? 400 : 200 },
        );
      }
      return new Response(JSON.stringify({ messages: [] }));
    });
    const runtime = new ConnectorRuntime({
      secrets,
      credentialRefFor: (p, c) => `keychain:${p}/${c}`,
      grantedScopes: () => ['email.read'],
      refreshConfig: (provider, connectorId, scopes) => {
        if (provider !== 'google') return null;
        const config = connectorProviderConfig(provider, connectorId, scopes, {
          ASTRA_OAUTH_GOOGLE_READ_CLIENT_ID: 'google-read-client',
        });
        return config ? { ...config, redirectUri: 'http://127.0.0.1:1234' } : null;
      },
      fetch: fetch as unknown as typeof globalThis.fetch,
      now: () => new Date('2026-08-27T00:00:00.000Z'),
      reportRenewalRejected: async (...args) => {
        reported.push(args);
      },
    });
    return { runtime, secrets, fetch, reported };
  }

  it.each(['google-read-client', undefined, 'stale-client'])(
    'stores the successful refresh client and native account metadata (previous client: %s)',
    async (clientId) => {
      const { runtime, secrets, fetch } = refreshing({ clientId });
      expect(await runtime.run(step({ toolId: 'mail.search', args: {} }))).toMatchObject({
        ok: true,
      });
      // アプリが作った項目は書き換えない（`security` で書くとアプリが読めなくなる）。更新分は別項目へ
      const native = { ...nativeCredential, clientId };
      expect(JSON.parse(secrets.values[key]!)).toEqual(JSON.parse(JSON.stringify(native)));
      expect(JSON.parse(secrets.values[`${key}.host-renewal`]!)).toEqual({
        ...nativeCredential,
        accessToken: 'renewed-access',
        grantedScopes: [grantedScope],
        expiresAt: '2026-08-27T01:00:00.000Z',
        idToken: null,
        origin: credentialFingerprint(nativeCredential),
      });
      expect(fetch).toHaveBeenCalledTimes(2);
      // 次は更新分を使い、提供者へ更新しに行かない
      expect((await runtime.run(step({ toolId: 'mail.search', args: {} }))).ok).toBe(true);
      expect(fetch.mock.calls.filter(([url]) => String(url).includes('/token'))).toHaveLength(1);
    },
  );

  it('refreshes once when several calls need a new token at the same time', async () => {
    const { runtime, secrets, fetch } = refreshing({ clientId: 'google-read-client' });
    const save = vi.spyOn(secrets, 'set');
    const results = await Promise.all(
      [1, 2, 3].map(() => runtime.run(step({ toolId: 'mail.search', args: {} }))),
    );
    expect(results.every((r) => r.ok)).toBe(true);
    const tokenCalls = fetch.mock.calls.filter(([url]) => String(url).includes('/token'));
    expect(tokenCalls).toHaveLength(1);
    expect(save).toHaveBeenCalledTimes(1);
    expect(JSON.parse(secrets.values[`${key}.host-renewal`]!).accessToken).toBe('renewed-access');
  });

  it('prefers the app connection again once it was reconnected', async () => {
    const { runtime, secrets, fetch } = refreshing({ clientId: 'google-read-client' });
    await runtime.run(step({ toolId: 'mail.search', args: {} }));
    // 利用者がつなぎ直した（アプリが新しい更新用トークンで項目を書き直した）
    secrets.values[key] = JSON.stringify({
      ...nativeCredential,
      accessToken: 'reconnected-access',
      refreshToken: 'reconnected-refresh',
      expiresAt: '2026-08-27T02:00:00.000Z',
    });
    fetch.mockClear();
    expect((await runtime.run(step({ toolId: 'mail.search', args: {} }))).ok).toBe(true);
    const call = fetch.mock.calls.find(([url]) => String(url).includes('gmail'))!;
    expect((call[1] as RequestInit).headers).toMatchObject({
      authorization: 'Bearer reconnected-access',
    });
  });

  it('asks to be connected again when the provider revoked the refresh token', async () => {
    // Google の「テスト中」のアプリは 7 日で更新用トークンを失効させる（invalid_grant）
    const { runtime, secrets, fetch, reported } = refreshing(
      { clientId: 'google-read-client' },
      true,
    );
    const before = secrets.values[key];
    const outcome = await runtime.run(step({ toolId: 'mail.search', args: {} }));
    expect(outcome.error!.code).toBe('connector.token_expired');
    // アプリの項目はそのまま。断られた時刻は別項目に残し、Mac の Apps へは指紋だけを知らせる
    expect(secrets.values[key]).toBe(before);
    expect(JSON.parse(secrets.values[`${key}.host-renewal`]!)).toMatchObject({
      renewalRejectedAt: '2026-08-27T00:00:00.000Z',
      origin: credentialFingerprint(nativeCredential),
    });
    expect(reported).toEqual([
      ['com.astra.gmail', 'gmail', credentialFingerprint(nativeCredential)],
    ]);
    // 断られた更新用トークンで、提供者を呼び直さない
    const again = await runtime.run(step({ toolId: 'mail.search', args: {} }));
    expect(again.error!.code).toBe('connector.token_expired');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('does not assign a client to legacy credentials before a successful refresh', async () => {
    const { runtime, secrets, fetch } = refreshing({ clientId: undefined }, true);
    const before = secrets.values[key];
    expect((await runtime.run(step({ toolId: 'mail.search', args: {} }))).ok).toBe(false);
    expect(secrets.values[key]).toBe(before);
    expect(JSON.parse(secrets.values[`${key}.host-renewal`]!).clientId).toBeUndefined();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('does not rewrite unexpired credentials from configuration alone', async () => {
    const { runtime, secrets, fetch } = refreshing({
      clientId: undefined,
      expiresAt: '2099-01-01T00:00:00.000Z',
    });
    const before = secrets.values[key];
    expect((await runtime.run(step({ toolId: 'mail.search', args: {} }))).ok).toBe(true);
    expect(secrets.values[key]).toBe(before);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe('Microsoft client and scope isolation at execution', () => {
  const env = {
    ASTRA_OAUTH_MICROSOFT_READ_CLIENT_ID: 'read-client',
    ASTRA_OAUTH_MICROSOFT_WRITE_CLIENT_ID: 'send-client',
  };
  function isolated(over: Record<string, unknown> = {}, returnedScope = 'Mail.Read') {
    const secrets = memoryStore({
      'com.astra.outlook/outlook': tokenSet({
        clientId: 'read-client',
        grantedScopes: ['Mail.Read'],
        expiresAt: '2020-01-01T00:00:00.000Z',
        ...over,
      }),
      'com.astra.outlook/outlook-actions': tokenSet({
        clientId: 'send-client',
        grantedScopes: ['Mail.Send'],
        expiresAt: '2020-01-01T00:00:00.000Z',
      }),
    });
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes('/token'))
        return new Response(
          JSON.stringify({ access_token: 'renewed', expires_in: 3600, scope: returnedScope }),
        );
      return init?.method === 'POST'
        ? new Response(null, { status: 202 })
        : new Response(JSON.stringify({ value: [] }));
    });
    const runtime = new ConnectorRuntime({
      secrets,
      credentialRefFor: (p, c) => `keychain:${p}/${c}`,
      grantedScopes: () => ['email.read', 'email.send'],
      refreshConfig: (p, c, scopes) => {
        if (p !== 'microsoft') return null;
        const config = connectorProviderConfig(p, c, scopes, env);
        return config ? { ...config, redirectUri: 'http://127.0.0.1:1234' } : null;
      },
      fetch: fetch as unknown as typeof globalThis.fetch,
      now: () => new Date('2026-08-27T00:00:00.000Z'),
    });
    return { runtime, fetch, secrets };
  }
  it.each([
    ['outlook.mail.search', {}, null, 'Mail.Read', 'read-client'],
    [
      'outlook.mail.reply',
      { message_id: 'AAMk1', comment: 'ok' },
      approved('outlook.mail.reply'),
      'Mail.Send',
      'send-client',
    ],
  ] as const)(
    'refreshes %s using only its dedicated client and scopes',
    async (toolId, args, approval, scope, clientId) => {
      const { runtime, fetch } = isolated({}, scope);
      expect((await runtime.run(step({ toolId, args, approval }))).ok).toBe(true);
      const body = new URLSearchParams(String(fetch.mock.calls[0]?.[1]?.body));
      expect(body.get('client_id')).toBe(clientId);
      expect(body.get('scope')).toBe(scope);
      expect(fetch).toHaveBeenCalledTimes(2);
    },
  );
  it.each([undefined, 'send-client', 'legacy-client'])(
    'refuses a cached token from client %s before any request',
    async (clientId) => {
      const { runtime, fetch } = isolated({ clientId, expiresAt: '2099-01-01T00:00:00.000Z' });
      expect(await runtime.run(step({ toolId: 'outlook.mail.search', args: {} }))).toMatchObject({
        ok: false,
        error: { code: 'connector.not_connected' },
      });
      expect(fetch).not.toHaveBeenCalled();
    },
  );
  it('does not store or use a refresh response broadened with send permission', async () => {
    const { runtime, fetch, secrets } = isolated({}, 'Mail.Read Mail.Send');
    const before = { ...secrets.values };
    expect(await runtime.run(step({ toolId: 'outlook.mail.search', args: {} }))).toMatchObject({
      ok: false,
      error: { code: 'connector.provider_error' },
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(secrets.values).toEqual(before);
  });
});
