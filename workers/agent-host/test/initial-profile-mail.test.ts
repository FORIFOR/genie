import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorkArtifact } from '@genie/contracts';
import {
  GmailConnector,
  type MailSummary,
  type OutlookMailSummary,
} from '@genie/service-connectors';
import type { ConnectorRuntime } from '../src/connector-steps.js';
import { initialProfileBody, readInitialProfileMail } from '../src/initial-profile-mail.js';

const now = new Date('2026-10-10T00:00:00Z');
const mail = (id: string, patch: Partial<MailSummary> = {}): MailSummary => ({
  id,
  threadId: `thread-${id}`,
  from: 'A <a@example.invalid>',
  to: ['Owner <me@example.invalid>'],
  subject: '共同作業',
  snippet: 'PRIVATE_SNIPPET',
  receivedAt: '2026-10-09T00:00:00Z',
  unread: false,
  hasAttachments: false,
  ...patch,
});
function google(
  incoming: MailSummary[],
  sent: MailSummary[] = [],
  important: MailSummary[] = [],
  bodies: Record<string, string | Error> = {},
) {
  const list = vi.fn(async (args: { query?: string; labelIds?: string[] }) =>
    args.labelIds?.includes('SENT')
      ? sent
      : args.query?.includes('{is:important')
        ? important
        : incoming,
  );
  const get = vi.fn(async (id: string) => {
    const body = bodies[id] ?? 'PRIVATE_BODY: 対応する内容';
    if (body instanceof Error) throw body;
    return { id, body, bodyIsHtml: false };
  });
  const connectors = { gmail: () => ({ list, get }) } as unknown as ConnectorRuntime;
  return { connectors, list, get };
}
function providerMail(
  provider: 'google' | 'microsoft',
  incoming: MailSummary[],
  sent: MailSummary[] = [],
) {
  if (provider === 'google') return google(incoming, sent);
  const outlook = (mail: MailSummary, folder: 'inbox' | 'sentitems'): OutlookMailSummary => ({
    id: mail.id,
    conversationId: mail.threadId,
    from: { name: mail.from, address: mail.from },
    to: mail.to.map((email) => ({ name: email, address: email })),
    cc: [],
    subject: mail.subject,
    preview: mail.snippet,
    receivedAt: mail.receivedAt,
    sentAt: folder === 'sentitems' ? mail.receivedAt : null,
    unread: mail.unread,
    hasAttachments: mail.hasAttachments,
    webLink: null,
    folder,
  });
  const list = vi.fn(async (args: { folder?: string }) =>
    args.folder === 'sentitems'
      ? sent.map((mail) => outlook(mail, 'sentitems'))
      : incoming.map((mail) => outlook(mail, 'inbox')),
  );
  const get = vi.fn(async (id: string) => ({ id, body: 'SYNTHETIC_BODY', bodyIsHtml: false }));
  const connectors = { outlookMail: () => ({ list, get }) } as unknown as ConnectorRuntime;
  return { connectors, list, get };
}

describe.each(['google', 'microsoft'] as const)(
  'initial mail schema boundaries (%s)',
  (provider) => {
    const prefix = provider === 'google' ? 'gmail:' : 'outlook_mail:';
    const recipient = (index: number) => `recipient${index}@example.invalid`;
    const sender = 'sender@example.invalid';
    const own = 'owner@example.invalid';
    const base = (id: string, to: string[]) => mail(id, { from: sender, to });
    const published = (artifacts: unknown) => {
      WorkArtifact.array().parse(artifacts);
    };

    it.each([50, 51])(
      'keeps at most 50 valid people from %s without rejecting other mail',
      async (count) => {
        const recipients = Array.from({ length: count - 1 }, (_, index) => recipient(index));
        const h = providerMail(provider, [base('many', recipients), base('normal', [own])]);
        const onMetadata = vi.fn(async (artifacts: WorkArtifact[]) => published(artifacts));
        const result = await readInitialProfileMail({
          provider,
          connectors: h.connectors,
          readBodies: true,
          now,
          onMetadata,
        });
        expect(result).toMatchObject({
          metadata_count: 2,
          selected_count: 2,
          excluded_count: 0,
          failed_reads: 0,
        });
        expect(result.messages).toHaveLength(2);
        expect(onMetadata).toHaveBeenCalledOnce();
        const many = result.artifacts.find((artifact) => artifact.id === `${prefix}many`)!;
        expect(many.people.map((person) => person.email)).toEqual([
          sender,
          ...recipients.slice(0, 49),
        ]);
        expect(many.people[0]?.role).toBe('from');
        expect(many.people).toHaveLength(50);
        expect(h.get).toHaveBeenCalledTimes(2);
      },
    );

    it('removes the owner before applying the 50-person limit', async () => {
      const recipients = Array.from({ length: 49 }, (_, index) => recipient(index));
      const h = providerMail(
        provider,
        [base('many', [own, ...recipients]), base('normal', [own])],
        [mail('sent', { from: own, to: [sender], labels: ['SENT'] })],
      );
      const result = await readInitialProfileMail({
        provider,
        connectors: h.connectors,
        readBodies: true,
        now,
        onMetadata: async (artifacts) => published(artifacts),
      });
      expect(result).toMatchObject({ metadata_count: 3, selected_count: 3, excluded_count: 0 });
      expect(
        result.artifacts
          .find((artifact) => artifact.id === `${prefix}many`)!
          .people.map((person) => person.email),
      ).toEqual([sender, ...recipients]);
      expect(
        result.artifacts
          .flatMap((artifact) => artifact.people)
          .some((person) => person.email === own),
      ).toBe(false);
      expect(h.get).toHaveBeenCalledTimes(3);
    });

    it('omits an overlong address without truncating it or dropping valid recipients and mail', async () => {
      const invalid = 'x'.repeat(321) + '@example.invalid';
      const h = providerMail(provider, [
        base('invalid-person', [invalid, recipient(0)]),
        base('normal', [own]),
      ]);
      const result = await readInitialProfileMail({
        provider,
        connectors: h.connectors,
        readBodies: true,
        now,
        onMetadata: async (artifacts) => published(artifacts),
      });
      expect(result).toMatchObject({ metadata_count: 2, selected_count: 2, excluded_count: 0 });
      expect(
        result.artifacts
          .find((artifact) => artifact.id === `${prefix}invalid-person`)!
          .people.map((person) => person.email),
      ).toEqual([sender, recipient(0)]);
      expect(JSON.stringify(result.artifacts)).not.toContain(invalid.slice(0, 320));
      expect(h.get).toHaveBeenCalledTimes(2);
    });

    it('excludes only an artifact that remains invalid and preserves exact selection counts', async () => {
      const invalidId = 'x'.repeat(201);
      const h = providerMail(provider, [base(invalidId, [own]), base('normal', [own])]);
      const result = await readInitialProfileMail({
        provider,
        connectors: h.connectors,
        readBodies: true,
        now,
        onMetadata: async (artifacts) => published(artifacts),
      });
      expect(result).toMatchObject({
        metadata_count: 2,
        selected_count: 1,
        excluded_count: 1,
        failed_reads: 0,
      });
      expect(result.artifacts.map((artifact) => artifact.id)).toEqual([`${prefix}normal`]);
      expect(result.messages.map((message) => message.artifact.id)).toEqual([`${prefix}normal`]);
      expect(h.get.mock.calls.map(([id]) => id)).toEqual(['normal']);
    });
  },
);
describe('bounded initial mail selection', () => {
  afterEach(() => vi.useRealTimers());
  it.each([false, true])(
    'reaches 100 distinct bodies beyond advertisement pages and reports missing reads honestly (missing=%s)',
    async (missing) => {
      vi.useFakeTimers();
      const requestStarts: number[] = [];
      const incoming = Array.from({ length: 60 }, (_, i) => `in-${String(i).padStart(2, '0')}`);
      const outgoing = incoming.map((id) => id.replace('in-', 'out-'));
      const bodyReads: string[] = [];
      const listPages: string[] = [];
      const published: unknown[] = [];
      const fetch = (async (raw: string) => {
        requestStarts.push(Date.now());
        const url = new URL(raw);
        if (url.pathname.endsWith('/messages')) {
          const query = url.searchParams.get('q') ?? '';
          expect(query).toContain('-in:trash -in:spam -in:drafts');
          for (const category of ['promotions', 'social', 'forums', 'updates'])
            expect(query).toContain(`-category:${category}`);
          expect(url.searchParams.get('maxResults')).toBe('100');
          if (url.searchParams.get('labelIds') === 'SENT') {
            listPages.push('sent');
            return Response.json({ messages: outgoing.map((id) => ({ id })) });
          }
          if (query.includes('{is:important')) {
            listPages.push('important');
            return Response.json({ messages: [{ id: 'in-00' }, { id: 'in-00' }] });
          }
          const page = Number(url.searchParams.get('pageToken') ?? '0');
          listPages.push(`incoming-${page}`);
          return Response.json(
            page < 2
              ? {
                  messages: Array.from({ length: 100 }, (_, i) => ({ id: `ad-${page}-${i}` })),
                  nextPageToken: String(page + 1),
                }
              : { messages: [...incoming, ...incoming.slice(0, 10)].map((id) => ({ id })) },
          );
        }
        const id = url.pathname.split('/').at(-1)!;
        const outbound = id.startsWith('out-');
        const metadata = {
          id,
          threadId: id.startsWith('ad-') ? id : `thread-${id.split('-')[1]}`,
          internalDate: String(
            Date.parse(outbound ? '2026-10-09T01:00:00Z' : '2026-10-09T00:00:00Z'),
          ),
          labelIds: id.startsWith('ad-')
            ? ['CATEGORY_PROMOTIONS']
            : outbound
              ? ['SENT']
              : id === 'in-00'
                ? ['IMPORTANT']
                : [],
          snippet: 'PRIVATE_SNIPPET',
          payload: {
            headers: [
              { name: 'From', value: outbound ? 'me@example.invalid' : 'peer@example.invalid' },
              { name: 'To', value: outbound ? 'peer@example.invalid' : 'me@example.invalid' },
              { name: 'Subject', value: 'Synthetic project review' },
            ],
          },
        };
        if (url.searchParams.get('format') === 'metadata') return Response.json(metadata);
        expect(url.searchParams.get('format')).toBe('full');
        bodyReads.push(id);
        if (missing && id === 'in-01')
          return Response.json({ error: { message: 'PRIVATE_PROVIDER_FAILURE' } }, { status: 404 });
        return Response.json({
          ...metadata,
          id: missing && id === 'out-00' ? 'unexpected-id' : id,
          payload: {
            ...metadata.payload,
            mimeType: 'text/plain',
            body: {
              data: Buffer.from(
                missing && id === 'in-00' ? '' : 'PRIVATE_BODY ' + '内容'.repeat(1500),
              ).toString('base64url'),
            },
          },
        });
      }) as typeof globalThis.fetch;
      const gmail = new GmailConnector({
        token: async () => 'synthetic',
        fetch,
        grantedScopes: ['email.read'],
      });
      const connectors = { gmail: () => gmail } as unknown as ConnectorRuntime;
      const pending = readInitialProfileMail({
        provider: 'google',
        connectors,
        readBodies: true,
        now,
        onMetadata: async (artifacts) => {
          published.push(artifacts);
        },
      });
      await vi.runAllTimersAsync();
      const result = await pending;
      expect(requestStarts.slice(1).every((at, i) => at - requestStarts[i]! >= 250)).toBe(true);
      expect(listPages).toEqual(['incoming-0', 'incoming-1', 'incoming-2', 'sent', 'important']);
      expect(result).toMatchObject({
        metadata_count: 320,
        excluded_count: 200,
        selected_count: 100,
        failed_reads: missing ? 3 : 0,
      });
      expect(bodyReads).toHaveLength(100);
      expect(new Set(bodyReads).size).toBe(100);
      const threads = new Map<string, Set<string>>();
      for (const id of bodyReads) {
        const [direction, thread] = id.split('-');
        threads.set(thread!, new Set([...(threads.get(thread!) ?? []), direction!]));
      }
      expect(threads.size).toBe(50);
      for (const directions of threads.values())
        expect([...directions].sort()).toEqual(['in', 'out']);
      expect(result.messages).toHaveLength(missing ? 97 : 100);
      expect(result.messages.every((message) => message.body.length <= 2000)).toBe(true);
      expect(JSON.stringify(published)).not.toMatch(
        /PRIVATE_BODY|PRIVATE_SNIPPET|PRIVATE_PROVIDER_FAILURE/,
      );
    },
  );

  it('caps metadata at 1000 even when a provider adapter overreturns duplicate and excess candidates', async () => {
    const incoming = Array.from({ length: 1100 }, (_, i) => mail(`mail-${i}`));
    const h = google([...incoming, ...incoming.slice(0, 30)]);
    const result = await readInitialProfileMail({
      provider: 'google',
      connectors: h.connectors,
      readBodies: false,
      now,
    });
    expect(result.metadata_count).toBe(1000);
    expect(result.artifacts).toHaveLength(1000);
    expect(result.selected_count).toBe(100);
    expect(h.get).not.toHaveBeenCalled();
    expect(h.list.mock.calls.map(([args]) => args)).toMatchObject([
      { maxResults: 100, maxPages: 4, retryRateLimits: true },
      { maxResults: 100, maxPages: 4, retryRateLimits: true },
      { maxResults: 100, maxPages: 2, retryRateLimits: true },
    ]);
  });
  it('finishes each Gmail metadata bucket and renews progress before starting the next', async () => {
    const events: string[] = [];
    let active = false;
    const list = vi.fn(async () => {
      expect(active).toBe(false);
      active = true;
      events.push('start');
      await Promise.resolve();
      events.push('finish');
      active = false;
      return [];
    });
    const connectors = { gmail: () => ({ list }) } as unknown as ConnectorRuntime;
    await readInitialProfileMail({
      provider: 'google',
      connectors,
      readBodies: false,
      now,
      onProgress: async () => {
        events.push('progress');
      },
    });
    expect(events).toEqual([
      'start',
      'finish',
      'progress',
      'start',
      'finish',
      'progress',
      'start',
      'finish',
      'progress',
    ]);
    expect(list).toHaveBeenCalledTimes(3);
  });
  it('includes archived/older important mail, excludes ads, and retains coherent reply pairs', async () => {
    const incoming = [
      mail('request', { threadId: 'shared' }),
      ...Array.from({ length: 30 }, (_, i) =>
        mail(`ad${i}`, {
          labels: [
            ['CATEGORY_PROMOTIONS', 'CATEGORY_SOCIAL', 'CATEGORY_FORUMS', 'CATEGORY_UPDATES'][
              i % 4
            ]!,
          ],
        }),
      ),
      mail('no-reply', { from: 'Notify <noreply@example.invalid>' }),
      mail('list', { listUnsubscribe: true }),
      mail('auto', { autoSubmitted: 'auto-generated' }),
      mail('bulk', { precedence: 'bulk' }),
      mail('draft', { labels: ['DRAFT'] }),
      mail('expired', { receivedAt: '2026-01-01T00:00:00Z' }),
    ];
    const sent = [
      mail('reply', {
        threadId: 'shared',
        from: 'Owner <me@example.invalid>',
        to: ['A <a@example.invalid>'],
        labels: ['SENT'],
        inReplyTo: '<request>',
        receivedAt: '2026-10-09T01:00:00Z',
      }),
    ];
    const h = google(incoming, sent, [
      mail('archived', { labels: ['IMPORTANT'], receivedAt: '2026-08-01T00:00:00Z' }),
    ]);
    const out = await readInitialProfileMail({
      provider: 'google',
      connectors: h.connectors,
      readBodies: true,
      now,
    });
    expect(out.messages.map((item) => item.artifact.id)).toEqual([
      'gmail:reply',
      'gmail:request',
      'gmail:archived',
    ]);
    expect(out.artifacts.find((a) => a.id === 'gmail:request')?.responded).toBe(true);
    expect(
      out.artifacts.flatMap((a) => a.people).some((p) => p.email === 'me@example.invalid'),
    ).toBe(false);
    expect(h.list.mock.calls[0]![0].labelIds).toBeUndefined();
    expect(h.list.mock.calls[0]![0].query).toContain('-in:sent');
    expect(h.list.mock.calls[2]![0].query).toContain('{is:important is:starred}');
    expect(out.selected_count).toBe(3);
    expect(JSON.stringify(out.artifacts)).not.toMatch(/PRIVATE_BODY|PRIVATE_SNIPPET/);
    expect(
      out.artifacts.every(
        (a) => a.body_excerpt === null && a.provenance.excerpt === null && a.semantic === null,
      ),
    ).toBe(true);
  });
  it('limits body reads to 100, diversifies threads, and never omits the newest observed counterpart', async () => {
    const incoming = Array.from({ length: 60 }, (_, i) =>
      mail(`in${i}`, { threadId: `thread${i}` }),
    );
    const sent = Array.from({ length: 60 }, (_, i) =>
      mail(`out${i}`, {
        threadId: `thread${i}`,
        from: 'me@example.invalid',
        to: ['a@example.invalid'],
        labels: ['SENT'],
      }),
    );
    sent.push(
      ...Array.from({ length: 40 }, (_, i) =>
        mail(`long${i}`, {
          threadId: 'thread0',
          from: 'me@example.invalid',
          to: ['a@example.invalid'],
          labels: ['SENT'],
        }),
      ),
    );
    const h = google(incoming, sent);
    const out = await readInitialProfileMail({
      provider: 'google',
      connectors: h.connectors,
      readBodies: true,
      now,
    });
    expect(h.get).toHaveBeenCalledTimes(100);
    const threads = new Map<string, string[]>();
    for (const { artifact } of out.messages)
      threads.set(artifact.thread_id!, [
        ...(threads.get(artifact.thread_id!) ?? []),
        artifact.direction,
      ]);
    expect(threads.size).toBe(50);
    for (const directions of threads.values())
      expect(directions.sort()).toEqual(['inbound', 'outbound']);
  });
  it('does not fetch any full body when no local analyzer is available', async () => {
    const h = google([mail('one')]);
    const out = await readInitialProfileMail({
      provider: 'google',
      connectors: h.connectors,
      readBodies: false,
      now,
    });
    expect(h.get).not.toHaveBeenCalled();
    expect(out.selected_count).toBe(1);
    expect(out.messages).toEqual([]);
  });
  it('keeps older important inbound mail ahead of more than 100 ordinary outgoing threads', async () => {
    const sent = Array.from({ length: 130 }, (_, i) =>
      mail(`sent${i}`, {
        from: 'me@example.invalid',
        to: ['a@example.invalid'],
        labels: ['SENT'],
      }),
    );
    const h = google(
      [mail('paired-in', { threadId: 'paired' })],
      [
        ...sent,
        mail('paired-out', {
          threadId: 'paired',
          from: 'me@example.invalid',
          to: ['a@example.invalid'],
          labels: ['SENT'],
        }),
      ],
      [mail('important-in', { labels: ['IMPORTANT'], receivedAt: '2026-08-01T00:00:00Z' })],
    );
    const out = await readInitialProfileMail({
      provider: 'google',
      connectors: h.connectors,
      readBodies: true,
      now,
    });
    const ids = out.messages.map((message) => message.artifact.id);
    expect(ids).toHaveLength(100);
    expect(ids.slice(0, 2).sort()).toEqual(['gmail:paired-in', 'gmail:paired-out']);
    expect(ids[2]).toBe('gmail:important-in');
    expect(h.get).toHaveBeenCalledTimes(100);
  });
  it('counts failed/empty reads without exposing provider error data or substituting snippets', async () => {
    const h = google([mail('broken'), mail('empty'), mail('good')], [], [], {
      broken: new Error('PRIVATE_PROVIDER_RESPONSE'),
      empty: '',
      good: '内容'.repeat(3000),
    });
    const progress = vi.fn(async () => {});
    const out = await readInitialProfileMail({
      provider: 'google',
      connectors: h.connectors,
      readBodies: true,
      now,
      onProgress: progress,
    });
    expect(out.selected_count).toBe(3);
    expect(out.failed_reads).toBe(2);
    expect(out.messages).toHaveLength(1);
    expect(out.messages[0]!.body.length).toBe(2000);
    expect(JSON.stringify(out)).not.toContain('PRIVATE_PROVIDER_RESPONSE');
    expect(progress).toHaveBeenCalledTimes(6);
  });
  it('limits Outlook to inbox and sent counterparts without invoking Google or all folders', async () => {
    const raw: OutlookMailSummary = {
      id: 'in',
      conversationId: 'thread',
      from: { name: 'A', address: 'a@example.invalid' },
      to: [{ name: 'Me', address: 'me@example.invalid' }],
      cc: [],
      subject: '確認',
      preview: 'PRIVATE_SNIPPET',
      receivedAt: '2026-10-09T00:00:00Z',
      sentAt: null,
      unread: true,
      hasAttachments: false,
      webLink: null,
      folder: 'inbox',
    };
    const sent = {
      ...raw,
      id: 'out',
      from: raw.to[0]!,
      to: [raw.from!],
      folder: 'sentitems' as const,
      sentAt: '2026-10-09T01:00:00Z',
    };
    const list = vi.fn(async (args: { folder?: string }) =>
      args.folder === 'sentitems' ? [sent] : [raw, { ...raw, id: 'draft', isDraft: true }],
    );
    const get = vi.fn(async (id: string) => ({ id, body: '<p>確認します</p>', bodyIsHtml: true }));
    const connectors = { outlookMail: () => ({ list, get }) } as unknown as ConnectorRuntime;
    const out = await readInitialProfileMail({
      provider: 'microsoft',
      connectors,
      readBodies: true,
      now,
    });
    expect(list.mock.calls[0]![0]).toMatchObject({
      folder: 'inbox',
      selectionMetadata: true,
      maxResults: 100,
    });
    expect(list.mock.calls.map(([args]) => args.folder)).toEqual(['inbox', 'sentitems']);
    expect(list.mock.calls.every(([args]) => !('allFolders' in args))).toBe(true);
    expect(out.messages.map((m) => m.artifact.direction).sort()).toEqual(['inbound', 'outbound']);
    expect(out.messages.every((m) => m.body === '確認します')).toBe(true);
    expect(out.artifacts).toHaveLength(2);
  });
});
describe('local body minimization', () => {
  it('removes executable markup, quoted history and signatures', () => {
    expect(
      initialProfileBody(
        '<head>PRIVATE_STYLE</head><script>PRIVATE_SCRIPT</script><p>資料を確認 &amp; 共有</p><blockquote>PRIVATE_OLD_THREAD</blockquote>',
        true,
      ),
    ).toBe('資料を確認 & 共有');
    expect(initialProfileBody('確認します\n\n-- \nPRIVATE_SIGNATURE', false)).toBe('確認します');
    expect(initialProfileBody('対応します\nOn Tuesday, A wrote:\nPRIVATE_QUOTE', false)).toBe(
      '対応します',
    );
    expect(
      initialProfileBody('<p>回答です</p><div class="gmail_quote">PRIVATE_QUOTE</div>', true),
    ).toBe('回答です');
    expect(initialProfileBody('&#x110000; &#0; &#x41;', true)).toBe('A');
  });
});
