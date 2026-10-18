import { afterEach, describe, expect, it, vi } from 'vitest';
import { BriefSection } from '@genie/contracts';
import {
  GmailConnector,
  type MailSummary,
  type OutlookMailSummary,
} from '@genie/service-connectors';
import type { ConnectorRuntime } from '../src/connector-steps.js';
import { readBriefMail } from '../src/brief/mail.js';

const NOW = new Date('2026-10-10T00:00:00Z');
const mail = (id: string, over: Partial<MailSummary> = {}): MailSummary => ({
  id,
  threadId: id,
  subject: `Synthetic ${id}`,
  from: 'Person <person@example.invalid>',
  to: [],
  receivedAt: '2026-10-09T00:00:00Z',
  snippet: 'PRIVATE_SNIPPET',
  unread: false,
  hasAttachments: false,
  ...over,
});
const outlookMail = (id: string): OutlookMailSummary => ({
  id,
  conversationId: id,
  subject: `Synthetic ${id}`,
  from: { name: 'Person', address: 'person@example.invalid' },
  to: [],
  cc: [],
  receivedAt: '2026-10-09T00:00:00Z',
  sentAt: null,
  preview: 'PRIVATE_PREVIEW',
  unread: true,
  hasAttachments: false,
  webLink: 'https://outlook.office.com/mail/inbox/id/synthetic',
  folder: 'inbox',
});

function fixture(
  important: MailSummary[] = [],
  incoming: MailSummary[] = [],
  outlook?: OutlookMailSummary[],
) {
  const list = vi.fn(async (args: { query?: string; maxResults?: number }) =>
    (args.query?.includes('(is:starred OR') ? important : incoming).slice(0, args.maxResults),
  );
  const get = vi.fn();
  const outlookList = vi.fn(async (args: { maxResults?: number }) =>
    (outlook ?? []).slice(0, args.maxResults),
  );
  const connected = vi.fn(
    async (key: string) => key === 'gmail' || (key === 'outlook' && outlook !== undefined),
  );
  const granted = vi.fn(() => ['email.read']);
  const connectors = {
    connected,
    granted,
    gmail: () => ({ list, get }),
    outlookMail: () => ({ list: outlookList, get }),
  } as unknown as ConnectorRuntime;
  return { connectors, list, get, outlookList, connected, granted };
}

describe('fresh daily brief mail', () => {
  afterEach(() => vi.useRealTimers());

  it('ranks important/unread mail, removes automated mail, and keeps the newest row per thread', async () => {
    const h = fixture(
      [
        mail('important', { labels: ['IMPORTANT'] }),
        mail('older', {
          threadId: 'conversation',
          labels: ['IMPORTANT'],
          receivedAt: '2026-10-07T00:00:00Z',
        }),
      ],
      [
        mail('normal'),
        mail('unread', { unread: true }),
        mail('newer', { threadId: 'conversation', unread: true }),
        mail('important', { labels: ['IMPORTANT'] }),
        ...['CATEGORY_PROMOTIONS', 'CATEGORY_SOCIAL', 'CATEGORY_FORUMS', 'CATEGORY_UPDATES'].map(
          (label) => mail(label, { labels: [label] }),
        ),
        mail('noreply', { from: 'noreply@example.invalid' }),
        mail('list', { listUnsubscribe: true }),
        mail('auto', { autoSubmitted: 'auto-generated' }),
        mail('bulk', { precedence: 'bulk' }),
        mail('sent', { labels: ['SENT'] }),
        mail('old', { receivedAt: '2026-09-01T00:00:00Z' }),
        mail('future', { receivedAt: '2027-01-01T00:00:00Z' }),
        mail('bad-date', { receivedAt: null }),
      ],
    );
    const result = BriefSection.parse(await readBriefMail(h.connectors, () => NOW));
    expect(result.status).toBe('ok');
    expect(result.lines.map((line) => line.ref)).toEqual([
      'gmail:important',
      'gmail:newer',
      'gmail:unread',
      'gmail:normal',
    ]);
    expect(result.lines[0]).toMatchObject({
      subtitle: '重要 · Person',
      received_at: '2026-10-09T00:00:00.000Z',
      url: 'https://mail.google.com/mail/u/0/#all/important',
    });
    expect(result.reason).toContain('4件を表示');
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE_SNIPPET|PRIVATE_PREVIEW/);
    expect(h.get).not.toHaveBeenCalled();
    expect(h.list.mock.calls[0]![0].maxResults).toBe(50);
    expect(h.list.mock.calls[1]![0].maxResults).toBe(98);
  });

  it('folds subjects from one sender that differ only in numbers into one row', async () => {
    const testflight = 'Example Inc via TestFlight <team@example.invalid>';
    const h = fixture(
      [
        mail('build-2158', {
          labels: ['IMPORTANT'],
          from: testflight,
          subject: 'Wonder 0.1.0 (202610112158) for iOS is now available to test.',
        }),
        mail('build-2051', {
          labels: ['IMPORTANT'],
          from: testflight,
          subject: 'Wonder 0.1.0 (202610112051) for iOS is now available to test.',
          receivedAt: '2026-10-08T00:00:00Z',
        }),
      ],
      [mail('other')],
    );
    const result = await readBriefMail(h.connectors, () => NOW);
    expect(result.lines.map((line) => [line.text, line.subtitle])).toEqual([
      [
        'Wonder 0.1.0 (202610112158) for iOS is now available to test.',
        '重要 · Example Inc via TestFlight · ほか1件',
      ],
      ['Synthetic other', 'Person'],
    ]);
  });

  it('returns a successful zero count separately from an unavailable connection', async () => {
    const h = fixture();
    const result = await readBriefMail(h.connectors, () => NOW);
    expect(result).toMatchObject({ status: 'ok', fetched_at: NOW.toISOString(), lines: [] });
    expect(result.reason).toContain('取得0件');
    expect(await readBriefMail(undefined, () => NOW)).toMatchObject({
      status: 'none',
      fetched_at: null,
      lines: [],
    });
    h.connected.mockResolvedValue(false);
    h.list.mockClear();
    expect(await readBriefMail(h.connectors, () => NOW)).toMatchObject({ status: 'none' });
    expect(h.list).not.toHaveBeenCalled();
  });

  it('retains important and starred automatic updates without admitting excluded folders', async () => {
    const h = fixture(
      [
        mail('payment', {
          subject: 'お支払い期限のお知らせ',
          labels: ['IMPORTANT', 'CATEGORY_UPDATES'],
          from: 'noreply@example.invalid',
          autoSubmitted: 'auto-generated',
        }),
        mail('security', {
          labels: ['STARRED', 'CATEGORY_UPDATES'],
          from: 'alerts@example.invalid',
          listUnsubscribe: true,
          precedence: 'bulk',
        }),
        ...['SPAM', 'TRASH', 'DRAFT', 'SENT'].map((label) =>
          mail(label, { labels: ['IMPORTANT', 'STARRED', label] }),
        ),
      ],
      [mail('ordinary-update', { labels: ['CATEGORY_UPDATES'] })],
    );
    const result = await readBriefMail(h.connectors, () => NOW);
    expect(result.lines.map((line) => line.ref)).toEqual(['gmail:security', 'gmail:payment']);
    expect(h.list.mock.calls[0]![0].query).not.toContain('-category:updates');
    expect(h.list.mock.calls[1]![0].query).toContain('-category:updates');
    expect(h.get).not.toHaveBeenCalled();
  });

  it('does not let IMPORTANT exempt investment promotions, race guides, or bulk notices', async () => {
    const automatic = {
      labels: ['IMPORTANT', 'CATEGORY_UPDATES'],
      from: 'noreply@example.invalid',
      autoSubmitted: 'auto-generated',
    };
    const h = fixture([
      mail('moneyforward', {
        ...automatic,
        subject: 'MoneyForward 投資のご案内',
        listUnsubscribe: true,
      }),
      mail('winticket', { ...automatic, subject: 'WINTICKET 本日のレース案内' }),
      mail('campaign', { ...automatic, subject: '本人確認のお願い キャンペーンでポイント還元' }),
      mail('bulk-payment', { ...automatic, subject: 'お支払い期限のお知らせ', precedence: 'bulk' }),
      mail('list-security', { ...automatic, subject: 'セキュリティ警告', listUnsubscribe: true }),
      mail('generic-update', { ...automatic, subject: '今月のお知らせ' }),
    ]);
    const result = await readBriefMail(h.connectors, () => NOW);
    expect(result).toMatchObject({ status: 'ok', lines: [] });
    expect(result.reason).toContain('取得6件');
    expect(h.get).not.toHaveBeenCalled();
  });

  it('puts direct correspondence ahead of retained actionable notices and explicit stars', async () => {
    const automatic = {
      labels: ['IMPORTANT', 'CATEGORY_UPDATES'],
      from: 'noreply@example.invalid',
      autoSubmitted: 'auto-generated',
      unread: true,
    };
    const h = fixture(
      [
        mail('payment', { ...automatic, subject: '請求のお支払い期限が近づいています' }),
        mail('security', { ...automatic, subject: '不審なログインを検出しました' }),
        mail('identity', { ...automatic, subject: '本人確認のお願い' }),
        mail('starred-promo', {
          ...automatic,
          labels: ['STARRED', 'CATEGORY_PROMOTIONS'],
          subject: '明示して残したキャンペーン',
          listUnsubscribe: true,
        }),
      ],
      [
        mail('human', {
          subject: 'キャンペーン資料の確認をお願いします',
          receivedAt: '2026-10-05T00:00:00Z',
        }),
      ],
    );
    const result = await readBriefMail(h.connectors, () => NOW);
    expect(result.lines.map((line) => line.ref)).toEqual([
      'gmail:human',
      'gmail:starred-promo',
      'gmail:identity',
      'gmail:payment',
      'gmail:security',
    ]);
    expect(result.lines[1]?.subtitle).toContain('スター付き');
    // The star is outside the important branch's category exclusions.
    expect(h.list.mock.calls[0]![0].query).toMatch(
      /\(is:starred OR \(is:important -category:promotions -category:social -category:forums\)\)$/,
    );
    expect(JSON.stringify(result)).not.toContain('PRIVATE_SNIPPET');
  });

  it('applies the same bulk exclusion and narrow important-notice rule to Outlook', async () => {
    const h = fixture(
      [],
      [],
      [
        { ...outlookMail('newsletter'), importance: 'high', listUnsubscribe: true },
        {
          ...outlookMail('identity'),
          importance: 'high',
          subject: '本人確認のお願い',
          from: { name: 'Automatic', address: 'noreply@example.invalid' },
          autoSubmitted: 'auto-generated',
        },
        { ...outlookMail('human'), importance: 'normal' },
      ],
    );
    const result = await readBriefMail(h.connectors, () => NOW);
    expect(result.lines.map((line) => line.ref)).toEqual([
      'outlook_mail:human',
      'outlook_mail:identity',
    ]);
    expect(h.get).not.toHaveBeenCalled();
  });

  it('does not read without the existing email.read grant', async () => {
    const h = fixture([mail('one')]);
    h.granted.mockReturnValue([]);
    expect(await readBriefMail(h.connectors, () => NOW)).toMatchObject({
      status: 'none',
      lines: [],
    });
    expect(h.list).not.toHaveBeenCalled();
    expect(h.get).not.toHaveBeenCalled();
  });

  it('retains successful rows if a later read fails and never exposes the error', async () => {
    const h = fixture([mail('one', { labels: ['IMPORTANT'] })]);
    h.list.mockImplementationOnce(async () => [mail('one', { labels: ['IMPORTANT'] })]);
    h.list.mockRejectedValueOnce(new Error('PRIVATE_PROVIDER_RESPONSE'));
    const result = await readBriefMail(h.connectors, () => NOW);
    expect(result).toMatchObject({ status: 'stale', fetched_at: NOW.toISOString() });
    expect(result.lines).toHaveLength(1);
    expect(result.reason).toContain('一部を取得できませんでした');
    expect(JSON.stringify(result)).not.toContain('PRIVATE_PROVIDER_RESPONSE');
  });

  it('reports total read and connection failures with no invented freshness', async () => {
    const h = fixture();
    h.list.mockRejectedValue(new Error('PRIVATE_PROVIDER_RESPONSE'));
    expect(await readBriefMail(h.connectors, () => NOW)).toMatchObject({
      status: 'stale',
      fetched_at: null,
      lines: [],
    });
    h.connected.mockRejectedValue(new Error('PRIVATE_KEYCHAIN_DETAIL'));
    const result = await readBriefMail(h.connectors, () => NOW);
    expect(result).toMatchObject({ status: 'stale', fetched_at: null, lines: [] });
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE/);
  });

  it('shares the maximum 100 metadata rows between connected providers and rejects unsafe links', async () => {
    const h = fixture(
      // 差出人を分ける（同じ差出人で番号だけ違う件名は 1 行にまとまるため）。
      Array.from({ length: 100 }, (_, i) =>
        mail(`important${i}`, { labels: ['IMPORTANT'], from: `Sender${i} <s@example.invalid>` }),
      ),
      Array.from({ length: 100 }, (_, i) =>
        mail(`in${i}`, { from: `Inbox${i} <i@example.invalid>` }),
      ),
      Array.from({ length: 100 }, (_, i) => ({
        ...outlookMail(`out${i}`),
        from: { name: `Outlook${i}`, address: 'o@example.invalid' },
        ...(i === 0 ? { webLink: 'javascript:alert(1)' } : {}),
      })),
    );
    const result = await readBriefMail(h.connectors, () => NOW);
    expect(h.list.mock.calls.map(([args]) => args.maxResults)).toEqual([25, 25]);
    expect(h.outlookList.mock.calls[0]![0]).toMatchObject({
      maxResults: 50,
      folder: 'inbox',
      selectionMetadata: true,
      since: '2026-10-03T00:00:00.000Z',
    });
    expect(result.lines).toHaveLength(100);
    expect(result.reason).toContain('取得100件');
    expect(result.lines.find((line) => line.ref === 'outlook_mail:out0')?.url).toBeUndefined();
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE|javascript:/);
  });

  it('uses real paced connector requests for at most 100 metadata rows, without body requests', async () => {
    vi.useFakeTimers();
    const starts: number[] = [];
    const fetch = (async (raw: string, init: RequestInit) => {
      starts.push(Date.now());
      expect(init.method).toBe('GET');
      const url = new URL(raw);
      if (url.pathname.endsWith('/messages')) {
        const query = url.searchParams.get('q')!;
        for (const part of [
          '-in:sent',
          '-in:trash',
          '-category:promotions',
          '-category:social',
          '-category:forums',
        ])
          expect(query).toContain(part);
        if (query.includes('(is:starred OR')) expect(query).not.toContain('-category:updates');
        else expect(query).toContain('-category:updates');
        expect(query).toContain(`after:${Math.floor((NOW.getTime() - 7 * 86_400_000) / 1000)}`);
        const prefix = query.includes('(is:starred OR') ? 'important' : 'incoming';
        return Response.json({
          messages: Array.from({ length: 50 }, (_, i) => ({ id: `${prefix}${i}` })),
        });
      }
      expect(url.searchParams.get('format')).toBe('metadata');
      const id = url.pathname.split('/').at(-1)!;
      return Response.json({
        id,
        threadId: id,
        internalDate: String(NOW.getTime() - 1000),
        labelIds: id.startsWith('important') ? ['IMPORTANT'] : ['UNREAD'],
        snippet: 'PRIVATE_SNIPPET',
        payload: {
          headers: [
            { name: 'Subject', value: `Synthetic ${id}` },
            { name: 'From', value: `Person ${id} <person@example.invalid>` },
          ],
        },
      });
    }) as typeof globalThis.fetch;
    const gmail = new GmailConnector({
      token: async () => 'synthetic-token',
      fetch,
      grantedScopes: ['email.read'],
    });
    const connectors = {
      connected: async (key: string) => key === 'gmail',
      granted: () => ['email.read'],
      gmail: () => gmail,
    } as unknown as ConnectorRuntime;
    const pending = readBriefMail(connectors, () => NOW);
    await vi.runAllTimersAsync();
    const result = await pending;
    expect(result.status).toBe('ok');
    expect(result.lines).toHaveLength(100);
    expect(starts).toHaveLength(102);
    expect(starts.slice(1).every((at, i) => at - starts[i]! >= 250)).toBe(true);
    expect(JSON.stringify(result)).not.toContain('PRIVATE_SNIPPET');
  });
});
