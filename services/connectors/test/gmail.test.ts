import { describe, expect, it, vi } from 'vitest';
import { GmailConnector } from '../src/gmail.js';
import { ApprovalRequired, type ApprovalProof } from '../src/approval.js';
import { ConnectorError } from '../src/http.js';
import { fromBase64Url, toBase64Url } from '../src/mime.js';

const ALL = ['email.read', 'email.draft', 'email.modify', 'email.send'];
const NOW = (): Date => new Date('2026-08-27T00:00:00.000Z');

const proof = (operationId: string): ApprovalProof => ({
  approvalId: 'ap-1',
  operationId,
  decision: 'APPROVED',
  decidedBy: 'user-1',
  decidedAt: '2026-08-26T23:59:00.000Z',
  expiresAt: '2026-08-27T00:05:00.000Z',
});

interface Call {
  url: string;
  method: string;
  body: unknown;
  authorization: string | undefined;
}

function fakeFetch(routes: (url: string) => { status?: number; body: unknown }): {
  fetch: typeof globalThis.fetch;
  calls: Call[];
} {
  const calls: Call[] = [];
  const fetch = (async (url: string, init: RequestInit) => {
    const headers = init.headers as Record<string, string>;
    calls.push({
      url,
      method: init.method ?? 'GET',
      body: init.body ? JSON.parse(init.body as string) : undefined,
      authorization: headers?.['authorization'],
    });
    const route = routes(url);
    return new Response(JSON.stringify(route.body), { status: route.status ?? 200 });
  }) as unknown as typeof globalThis.fetch;
  return { fetch, calls };
}

const encode = (s: string): string => toBase64Url(new TextEncoder().encode(s));

describe('GmailConnector', () => {
  it('resolves Gmail IDs to RFC reply headers and sends the original thread ID', async () => {
    const { fetch, calls } = fakeFetch((url) => ({
      body: url.endsWith('/send')
        ? { id: 'sent', threadId: 'thread-1' }
        : {
            id: 'original',
            threadId: 'thread-1',
            payload: { headers: [{ name: 'Message-ID', value: '<original@example.invalid>' }] },
          },
    }));
    const gmail = new GmailConnector({
      token: async () => 'test',
      fetch,
      grantedScopes: ALL,
      now: NOW,
    });
    const message = { to: ['me@example.invalid'], subject: 'Re: 日本語', body: '返信' };
    await expect(gmail.reply('original', message, undefined, 'thread-1')).rejects.toBeInstanceOf(
      ApprovalRequired,
    );
    expect(calls).toHaveLength(0);
    await gmail.reply('original', message, proof('gmail.send'), 'thread-1');
    const body = calls[1]!.body as { raw: string; threadId: string };
    const raw = new TextDecoder().decode(fromBase64Url(body.raw));
    expect(body.threadId).toBe('thread-1');
    expect(raw).toContain('In-Reply-To: <original@example.invalid>');
    expect(raw).toContain('References: <original@example.invalid>');
    await expect(
      gmail.reply('original', message, proof('gmail.send'), 'another-thread'),
    ).rejects.toBeInstanceOf(ConnectorError);
    expect(calls.filter((c) => c.url.endsWith('/send'))).toHaveLength(1);
  });
  it('asks for the token at call time and never stores it', async () => {
    const token = vi.fn().mockResolvedValue('tok-1');
    const { fetch, calls } = fakeFetch(() => ({ body: { messages: [] } }));
    const gmail = new GmailConnector({ token, fetch, grantedScopes: ALL, now: NOW });

    await gmail.list();
    await gmail.list();

    // 呼ぶたびに取りに行く。手元に貯めていたら 1 回で済んでしまう。
    expect(token).toHaveBeenCalledTimes(2);
    expect(calls[0]!.authorization).toBe('Bearer tok-1');
    expect(JSON.stringify(gmail)).not.toContain('tok-1');
  });

  it('fetches only metadata for a listing, not the bodies', async () => {
    const { fetch, calls } = fakeFetch((url) =>
      url.includes('/messages?')
        ? { body: { messages: [{ id: 'm1' }] } }
        : {
            body: {
              id: 'm1',
              threadId: 't1',
              snippet: 'hello',
              internalDate: '1756252800000',
              labelIds: ['UNREAD', 'IMPORTANT'],
              payload: {
                headers: [
                  { name: 'From', value: 'a@example.com' },
                  { name: 'Subject', value: '会議のお知らせ' },
                  { name: 'To', value: 'me@example.com, other@example.com' },
                  { name: 'List-Unsubscribe', value: '<mailto:unsubscribe@example.invalid>' },
                  { name: 'Auto-Submitted', value: 'auto-generated' },
                  { name: 'Precedence', value: 'bulk' },
                  { name: 'In-Reply-To', value: '<prior@example.invalid>' },
                ],
              },
            },
          },
    );
    const gmail = new GmailConnector({
      token: async () => 't',
      fetch,
      grantedScopes: ALL,
      now: NOW,
    });

    const [message] = await gmail.list({ query: 'is:unread' });

    expect(calls[1]!.url).toContain('format=metadata');
    expect(calls[1]!.url).not.toContain('format=full');
    expect(message).toMatchObject({
      id: 'm1',
      subject: '会議のお知らせ',
      unread: true,
      to: ['me@example.com', 'other@example.com'],
      receivedAt: '2025-08-27T00:00:00.000Z',
      labels: ['UNREAD', 'IMPORTANT'],
      listUnsubscribe: true,
      autoSubmitted: 'auto-generated',
      precedence: 'bulk',
      inReplyTo: '<prior@example.invalid>',
    });
    expect(calls[1]!.url).toContain('metadataHeaders=List-Unsubscribe');
    expect(calls[1]!.url).toContain('metadataHeaders=In-Reply-To');
  });

  it('bounds metadata reads even if the provider returns more IDs than requested', async () => {
    const { fetch, calls } = fakeFetch((url) => ({
      body: url.includes('/messages?')
        ? { messages: Array.from({ length: 5 }, (_, i) => ({ id: `m${i}` })) }
        : { id: 'm0', payload: { headers: [] } },
    }));
    const gmail = new GmailConnector({ token: async () => 't', fetch, grantedScopes: ALL });
    expect(await gmail.list({ maxResults: 2 })).toHaveLength(2);
    expect(calls).toHaveLength(3);
  });

  it('paginates only when requested, deduplicates IDs, and stops repeated provider cursors', async () => {
    const { fetch, calls } = fakeFetch((raw) => {
      const url = new URL(raw);
      if (!url.pathname.endsWith('/messages'))
        return { body: { id: url.pathname.split('/').at(-1) } };
      if (!url.searchParams.has('pageToken'))
        return { body: { messages: [{ id: 'm1' }, { id: 'm1' }, {}], nextPageToken: 'second' } };
      expect(url.searchParams.get('pageToken')).toBe('second');
      return { body: { messages: [{ id: 'm1' }, { id: 'm2' }], nextPageToken: 'second' } };
    });
    const gmail = new GmailConnector({ token: async () => 't', fetch, grantedScopes: ALL });
    expect((await gmail.list()).map((mail) => mail.id)).toEqual(['m1']);
    expect(calls.filter((call) => call.url.includes('/messages?'))).toHaveLength(1);
    calls.length = 0;
    expect((await gmail.list({ maxPages: 4 })).map((mail) => mail.id)).toEqual(['m1', 'm2']);
    expect(calls.filter((call) => call.url.includes('/messages?'))).toHaveLength(2);
    expect(calls.filter((call) => call.url.includes('format=metadata'))).toHaveLength(2);
  });

  it('caps pagination and per-page results even when the provider advertises more data', async () => {
    let page = 0;
    const { fetch, calls } = fakeFetch((raw) => {
      const url = new URL(raw);
      if (!url.pathname.endsWith('/messages'))
        return { body: { id: url.pathname.split('/').at(-1) } };
      expect(url.searchParams.get('maxResults')).toBe('100');
      const index = page++;
      return {
        body: {
          messages: Array.from({ length: 110 }, (_, i) => ({ id: `${index}-${i}` })),
          nextPageToken: String(page),
        },
      };
    });
    const gmail = new GmailConnector({ token: async () => 't', fetch, grantedScopes: ALL });
    expect(await gmail.list({ maxResults: 1000, maxPages: 1000 })).toHaveLength(400);
    expect(page).toBe(4);
    expect(calls.filter((call) => call.url.includes('format=metadata'))).toHaveLength(400);
  });

  it('keeps large metadata listings below the provider concurrent-request limit', async () => {
    let active = 0;
    let peak = 0;
    const ids = Array.from({ length: 24 }, (_, i) => `m${i}`);
    const fetch = (async (input: string) => {
      if (input.includes('/messages?'))
        return Response.json({ messages: ids.map((id) => ({ id })) });
      active += 1;
      peak = Math.max(peak, active);
      const overLimit = active > 4;
      await new Promise((resolve) => setTimeout(resolve, 1));
      active -= 1;
      return overLimit
        ? Response.json({ error: { message: 'concurrent limit' } }, { status: 429 })
        : Response.json({ id: new URL(input).pathname.split('/').at(-1) });
    }) as typeof globalThis.fetch;
    const gmail = new GmailConnector({ token: async () => 't', fetch, grantedScopes: ALL });
    expect((await gmail.list({ maxResults: 24 })).map((mail) => mail.id)).toEqual(ids);
    expect(peak).toBe(4);
    expect(active).toBe(0);
  });

  it('shares initial request pacing across metadata, later buckets, bodies and retries', async () => {
    vi.useFakeTimers();
    try {
      const starts: { path: string; at: number }[] = [];
      let bodyAttempts = 0;
      const { fetch } = fakeFetch((raw) => {
        const url = new URL(raw);
        starts.push({ path: `${url.pathname}${url.search}`, at: Date.now() });
        if (url.pathname.endsWith('/messages')) return { body: { messages: [{ id: 'one' }] } };
        if (url.searchParams.get('format') === 'full' && bodyAttempts++ === 0)
          return { status: 403, body: { error: { errors: [{ reason: 'rateLimitExceeded' }] } } };
        return { body: { id: 'one' } };
      });
      const gmail = new GmailConnector({ token: async () => 't', fetch, grantedScopes: ALL });
      const pending = (async () => {
        await gmail.list({ query: 'incoming', retryRateLimits: true });
        await gmail.list({ query: 'sent', retryRateLimits: true });
        await gmail.get('one', undefined, { retryRateLimits: true });
      })();
      await vi.runAllTimersAsync();
      await pending;
      expect(starts.map((start) => start.at - starts[0]!.at)).toEqual([
        0, 250, 500, 750, 1000, 2000,
      ]);
      expect(starts[1]!.path).toContain('format=metadata');
      expect(starts[2]!.path).toContain('q=sent');
      expect(starts[4]!.path).toContain('format=full');
      expect(bodyAttempts).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not release queued initial reads together after the clock advances', async () => {
    vi.useFakeTimers();
    try {
      const starts: number[] = [];
      const { fetch } = fakeFetch(() => {
        starts.push(Date.now());
        return { body: { id: 'one' } };
      });
      const gmail = new GmailConnector({ token: async () => 't', fetch, grantedScopes: ALL });
      const pending = Promise.all(
        Array.from({ length: 5 }, () => gmail.get('one', undefined, { retryRateLimits: true })),
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(starts).toHaveLength(1);
      vi.setSystemTime(Date.now() + 5000);
      await vi.runAllTimersAsync();
      await pending;
      expect(starts).toHaveLength(5);
      expect(starts.slice(1).every((at, i) => at - starts[i]! >= 250)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not delay ordinary reads behind the initial-read queue', async () => {
    vi.useFakeTimers();
    try {
      const starts: number[] = [];
      const { fetch } = fakeFetch((url) => {
        starts.push(Date.now());
        return { body: url.includes('/messages?') ? { messages: [{ id: 'one' }] } : { id: 'one' } };
      });
      const gmail = new GmailConnector({ token: async () => 't', fetch, grantedScopes: ALL });
      await gmail.get('one', undefined, { retryRateLimits: true });
      await Promise.all([gmail.list(), gmail.get('one'), gmail.get('two')]);
      expect(starts).toHaveLength(5);
      expect(new Set(starts).size).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('cancels a paced initial read without blocking the next read or dispatching it', async () => {
    vi.useFakeTimers();
    try {
      const { fetch, calls } = fakeFetch(() => ({ body: { id: 'one' } }));
      const gmail = new GmailConnector({ token: async () => 't', fetch, grantedScopes: ALL });
      await gmail.get('one', undefined, { retryRateLimits: true });
      const abort = new AbortController();
      const cancelled = gmail
        .get('cancelled', abort.signal, { retryRateLimits: true })
        .catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(0);
      abort.abort();
      expect(await cancelled).toMatchObject({ reason: 'timed_out' });
      const next = gmail.get('next', undefined, { retryRateLimits: true });
      await vi.advanceTimersByTimeAsync(250);
      await next;
      expect(calls).toHaveLength(2);
      expect(calls[1]!.url).toContain('/next?');
    } finally {
      vi.useRealTimers();
    }
  });

  it('backs off rate-limited reads for one then two seconds before succeeding', async () => {
    vi.useFakeTimers();
    try {
      let attempt = 0;
      const { fetch, calls } = fakeFetch(() =>
        ++attempt < 3
          ? { status: 429, body: { error: { message: 'rate limited' } } }
          : { body: { messages: [] } },
      );
      const gmail = new GmailConnector({ token: async () => 't', fetch, grantedScopes: ALL });
      const pending = gmail.list({ retryRateLimits: true });
      await vi.advanceTimersByTimeAsync(999);
      expect(calls).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(calls).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(1999);
      expect(calls).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(1);
      expect(await pending).toEqual([]);
      expect(calls).toHaveLength(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('retries explicit Google 403 rate limits only for opted-in reads', async () => {
    vi.useFakeTimers();
    try {
      let attempts = 0;
      const { fetch, calls } = fakeFetch(() =>
        ++attempts < 3
          ? {
              status: 403,
              body: {
                error: {
                  message: 'PRIVATE_PROVIDER_DETAIL',
                  errors: [{ reason: 'userRateLimitExceeded' }],
                },
              },
            }
          : { body: { messages: [] } },
      );
      const gmail = new GmailConnector({
        token: async () => 't',
        fetch,
        grantedScopes: ALL,
        now: NOW,
      });
      const pending = gmail.list({ retryRateLimits: true });
      await vi.advanceTimersByTimeAsync(3000);
      expect(await pending).toEqual([]);
      expect(calls).toHaveLength(3);

      attempts = 0;
      await expect(gmail.list()).rejects.toMatchObject({ reason: 'rate_limited' });
      expect(attempts).toBe(1);
      attempts = 0;
      await expect(
        gmail.send(
          { to: ['a@example.invalid'], subject: 'test', body: 'test' },
          proof('gmail.send'),
        ),
      ).rejects.toMatchObject({ reason: 'rate_limited' });
      expect(attempts).toBe(1);

      const denied = fakeFetch(() => ({
        status: 403,
        body: { error: { message: 'Permission denied', errors: [{ reason: 'forbidden' }] } },
      }));
      await expect(
        new GmailConnector({
          token: async () => 't',
          fetch: denied.fetch,
          grantedScopes: ALL,
        }).list({ retryRateLimits: true }),
      ).rejects.toMatchObject({ reason: 'permission_denied' });
      expect(denied.calls).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops after three rate-limited attempts and never retries authentication errors or sends', async () => {
    vi.useFakeTimers();
    try {
      const limited = fakeFetch(() => ({ status: 429, body: { error: { message: 'limited' } } }));
      const gmail = new GmailConnector({
        token: async () => 't',
        fetch: limited.fetch,
        grantedScopes: ALL,
        now: NOW,
      });
      const pending = gmail.list({ retryRateLimits: true }).catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(3000);
      expect(await pending).toMatchObject({ reason: 'rate_limited' });
      expect(limited.calls).toHaveLength(3);
      await expect(
        gmail.send(
          { to: ['a@example.invalid'], subject: 'test', body: 'test' },
          proof('gmail.send'),
        ),
      ).rejects.toMatchObject({ reason: 'rate_limited' });
      expect(limited.calls).toHaveLength(4);
      const denied = fakeFetch(() => ({
        status: 401,
        body: { error: { message: 'unauthorized' } },
      }));
      await expect(
        new GmailConnector({
          token: async () => 't',
          fetch: denied.fetch,
          grantedScopes: ALL,
        }).list(),
      ).rejects.toMatchObject({ reason: 'token_expired' });
      expect(denied.calls).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('cancels a pending rate-limit retry without another provider request', async () => {
    vi.useFakeTimers();
    try {
      const { fetch, calls } = fakeFetch(() => ({
        status: 429,
        body: { error: { message: 'limited' } },
      }));
      const gmail = new GmailConnector({ token: async () => 't', fetch, grantedScopes: ALL });
      const abort = new AbortController();
      const pending = gmail
        .list({ retryRateLimits: true }, abort.signal)
        .catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(0);
      abort.abort();
      expect(await pending).toMatchObject({ reason: 'timed_out' });
      await vi.advanceTimersByTimeAsync(3000);
      expect(calls).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('skips the detail round trip entirely when nothing matched', async () => {
    const { fetch, calls } = fakeFetch(() => ({ body: {} }));
    const gmail = new GmailConnector({ token: async () => 't', fetch, grantedScopes: ALL });
    expect(await gmail.list({ query: 'nope' })).toEqual([]);
    expect(calls).toHaveLength(1);
  });

  it('reads a full message with its body and attachments', async () => {
    const { fetch } = fakeFetch(() => ({
      body: {
        id: 'm1',
        threadId: 't1',
        internalDate: '1756252800000',
        payload: {
          headers: [
            { name: 'Subject', value: 'Re: 見積もり' },
            { name: 'Message-ID', value: '<abc@mail>' },
            { name: 'Cc', value: 'c@example.com' },
          ],
          mimeType: 'multipart/mixed',
          parts: [
            { mimeType: 'text/plain', body: { data: encode('確認しました。') } },
            { mimeType: 'application/pdf', filename: 'quote.pdf', body: { size: 9 } },
          ],
        },
      },
    }));
    const gmail = new GmailConnector({ token: async () => 't', fetch, grantedScopes: ALL });

    const message = await gmail.get('m1');

    expect(message.body).toBe('確認しました。');
    expect(message.bodyIsHtml).toBe(false);
    expect(message.hasAttachments).toBe(true);
    expect(message.attachments[0]!.filename).toBe('quote.pdf');
    expect(message.messageIdHeader).toBe('<abc@mail>');
    expect(message.cc).toEqual(['c@example.com']);
  });

  it('creates a draft without approval, and does not send it', async () => {
    const { fetch, calls } = fakeFetch(() => ({ body: { id: 'd1', message: { id: 'm9' } } }));
    const gmail = new GmailConnector({
      token: async () => 't',
      fetch,
      grantedScopes: ALL,
      now: NOW,
    });

    const draft = await gmail.draft({
      to: ['a@example.com'],
      subject: '週次報告',
      body: '添付のとおりです。',
    });

    expect(draft).toEqual({ draftId: 'd1', messageId: 'm9' });
    expect(calls[0]!.url).toContain('/drafts');
    expect(calls[0]!.url).not.toContain('/send');
  });

  it('will not send without an approval, and issues no request at all', async () => {
    const { fetch, calls } = fakeFetch(() => ({ body: {} }));
    const gmail = new GmailConnector({
      token: async () => 't',
      fetch,
      grantedScopes: ALL,
      now: NOW,
    });

    await expect(
      gmail.send({ to: ['a@example.com'], subject: 's', body: 'b' }, undefined),
    ).rejects.toBeInstanceOf(ApprovalRequired);
    // 送らなかっただけでなく、送信の要求すら出していない
    expect(calls).toHaveLength(0);
  });

  it('will not send on an approval that was granted for the draft operation', async () => {
    const { fetch, calls } = fakeFetch(() => ({ body: {} }));
    const gmail = new GmailConnector({
      token: async () => 't',
      fetch,
      grantedScopes: ALL,
      now: NOW,
    });
    await expect(
      gmail.send({ to: ['a@example.com'], subject: 's', body: 'b' }, proof('gmail.draft')),
    ).rejects.toBeInstanceOf(ApprovalRequired);
    expect(calls).toHaveLength(0);
  });

  it('sends what the approval described, with the subject intact', async () => {
    const { fetch, calls } = fakeFetch(() => ({ body: { id: 'm1', threadId: 't1' } }));
    const gmail = new GmailConnector({
      token: async () => 't',
      fetch,
      grantedScopes: ALL,
      now: NOW,
    });

    const sent = await gmail.send(
      { to: ['a@example.com'], subject: '請求書の件', body: 'よろしくお願いします。' },
      proof('gmail.send'),
    );

    expect(sent).toEqual({ messageId: 'm1', threadId: 't1' });
    const raw = new TextDecoder().decode(fromBase64Url((calls[0]!.body as { raw: string }).raw));
    expect(raw).toContain('To: a@example.com');
    expect(raw).toContain('=?UTF-8?B?');
    expect(raw).toContain('Content-Type: text/plain; charset="UTF-8"');
  });

  it('refuses to send when only the read scope was granted', async () => {
    const { fetch, calls } = fakeFetch(() => ({ body: {} }));
    const gmail = new GmailConnector({
      token: async () => 't',
      fetch,
      grantedScopes: ['email.read'],
      now: NOW,
    });
    await expect(
      gmail.send({ to: ['a@example.com'], subject: 's', body: 'b' }, proof('gmail.send')),
    ).rejects.toMatchObject({ reason: 'insufficient_scope' });
    expect(calls).toHaveLength(0);
  });

  it('refuses a draft with no recipient, or a malformed address', async () => {
    const { fetch, calls } = fakeFetch(() => ({ body: {} }));
    const gmail = new GmailConnector({ token: async () => 't', fetch, grantedScopes: ALL });

    await expect(gmail.draft({ to: [], subject: 's', body: 'b' })).rejects.toBeInstanceOf(
      ConnectorError,
    );
    await expect(
      gmail.draft({ to: ['not-an-address'], subject: 's', body: 'b' }),
    ).rejects.toBeInstanceOf(ConnectorError);
    expect(calls).toHaveLength(0);
  });

  it('trashes rather than deletes, and only with approval', async () => {
    const { fetch, calls } = fakeFetch(() => ({ body: {} }));
    const gmail = new GmailConnector({
      token: async () => 't',
      fetch,
      grantedScopes: ALL,
      now: NOW,
    });

    await expect(gmail.trash('m1', undefined)).rejects.toBeInstanceOf(ApprovalRequired);
    await gmail.trash('m1', proof('gmail.trash'));

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toContain('/trash');
    // 完全な削除は呼ばない
    expect(calls[0]!.method).toBe('POST');
  });

  it('names what the user must do for each kind of failure', async () => {
    const cases: { status: number; message: string; reason: string }[] = [
      { status: 401, message: 'Invalid Credentials', reason: 'token_expired' },
      {
        status: 403,
        message: 'Request had insufficient authentication scopes',
        reason: 'insufficient_scope',
      },
      { status: 403, message: 'Gmail API has not been used', reason: 'permission_denied' },
      { status: 404, message: 'Not Found', reason: 'not_found' },
      { status: 429, message: 'User-rate limit exceeded', reason: 'rate_limited' },
      { status: 500, message: 'Backend Error', reason: 'provider_error' },
    ];

    for (const { status, message, reason } of cases) {
      const { fetch } = fakeFetch(() => ({ status, body: { error: { message } } }));
      const gmail = new GmailConnector({ token: async () => 't', fetch, grantedScopes: ALL });
      await expect(gmail.get('m1')).rejects.toMatchObject({ reason });
    }
  });

  it('does not treat an unreadable body as a success', async () => {
    const fetch = (async () =>
      new Response('<html>proxy error</html>', {
        status: 502,
      })) as unknown as typeof globalThis.fetch;
    const gmail = new GmailConnector({ token: async () => 't', fetch, grantedScopes: ALL });
    await expect(gmail.get('m1')).rejects.toMatchObject({ reason: 'provider_error' });
  });

  it('does not disguise "not connected" as a timeout', async () => {
    /*
     * トークンを取る所で失敗したのを通信の失敗として返していた。
     * 画面には「接続先が時間内に返りませんでした」と出るので、
     * **繋いでいないことに気づけない。**
     */
    const { fetch, calls } = fakeFetch(() => ({ body: {} }));
    const gmail = new GmailConnector({
      token: async () => {
        throw new ConnectorError('not_connected', 'com.astra.gmail is not connected');
      },
      fetch,
      grantedScopes: ALL,
    });

    await expect(gmail.get('m1')).rejects.toMatchObject({ reason: 'not_connected' });
    expect(calls).toEqual([]);
  });

  it('stops on cancellation before it reaches the network', async () => {
    const { fetch, calls } = fakeFetch(() => ({ body: {} }));
    const gmail = new GmailConnector({ token: async () => 't', fetch, grantedScopes: ALL });
    const controller = new AbortController();
    controller.abort();

    await expect(gmail.get('m1', controller.signal)).rejects.toMatchObject({ reason: 'timed_out' });
    expect(calls).toHaveLength(0);
  });
});
