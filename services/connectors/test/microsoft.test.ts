/**
 * Microsoft Graph（Outlook / To Do）。**読むだけ**の connector。
 *
 * 見るのは:
 *   - 一覧で本文を取りに行かない（`$select` に body が無い）
 *   - 許可が無ければ呼ぶ前に断る
 *   - Graph の時差の無い時刻を ISO にする
 *   - To Do は完了を既定で外す
 */
import { describe, expect, it, vi } from 'vitest';
import {
  MicrosoftTodoConnector,
  OutlookCalendarConnector,
  OutlookMailConnector,
} from '../src/microsoft.js';
import { ConnectorError } from '../src/http.js';

interface Call {
  url: string;
  authorization: string | undefined;
}

function fakeFetch(routes: (url: string) => { status?: number; body: unknown }): {
  fetch: typeof globalThis.fetch;
  calls: Call[];
} {
  const calls: Call[] = [];
  const fetch = (async (url: string, init: RequestInit) => {
    const headers = init.headers as Record<string, string>;
    calls.push({ url, authorization: headers?.['authorization'] });
    const route = routes(url);
    return new Response(JSON.stringify(route.body), { status: route.status ?? 200 });
  }) as unknown as typeof globalThis.fetch;
  return { fetch, calls };
}

const token = async (): Promise<string> => 'ms-tok';
const READ = ['email.read', 'calendar.read', 'tasks.read'];

const rawMessage = {
  id: 'AAMk1',
  conversationId: 'AAQk1',
  from: { emailAddress: { name: '田中 太郎', address: 'tanaka@example.com' } },
  toRecipients: [{ emailAddress: { name: 'me', address: 'me@example.com' } }],
  ccRecipients: [],
  subject: '見積の確認をお願いします',
  bodyPreview: '来週水曜までにご確認いただけますか',
  receivedDateTime: '2026-09-07T01:00:00Z',
  sentDateTime: '2026-09-07T00:59:00Z',
  isRead: false,
  hasAttachments: true,
  webLink: 'https://outlook.office.com/mail/id/AAMk1',
};

describe('OutlookMailConnector', () => {
  it('can sample inbox selection headers while keeping full bodies out', async () => {
    const { fetch, calls } = fakeFetch(() => ({
      body: {
        value: [
          {
            ...rawMessage,
            importance: 'high',
            internetMessageHeaders: [
              { name: 'Auto-Submitted', value: 'auto-generated' },
              { name: 'List-Unsubscribe', value: '<mailto:remove@example.invalid>' },
            ],
          },
        ],
      },
    }));
    const mail = new OutlookMailConnector({ token, fetch, grantedScopes: READ });
    const messages = await mail.list({
      folder: 'inbox',
      selectionMetadata: true,
      since: '2026-09-01T00:00:00.000Z',
      maxResults: 80,
    });
    const url = new URL(calls[0]!.url);
    expect(url.pathname).toBe('/v1.0/me/mailFolders/inbox/messages');
    expect(url.searchParams.get('$select')!.split(',')).toContain('internetMessageHeaders');
    expect(url.searchParams.get('$select')!.split(',')).not.toContain('body');
    expect(messages[0]).toMatchObject({
      importance: 'high',
      autoSubmitted: 'auto-generated',
      listUnsubscribe: true,
      folder: 'inbox',
    });
  });
  it('lists the inbox without fetching bodies', async () => {
    const { fetch, calls } = fakeFetch(() => ({ body: { value: [rawMessage] } }));
    const mail = new OutlookMailConnector({ token, fetch, grantedScopes: READ });

    const list = await mail.list({ since: '2026-09-01T00:00:00.000Z' });

    expect(calls).toHaveLength(1);
    const url = new URL(calls[0]!.url);
    expect(url.pathname).toBe('/v1.0/me/mailFolders/inbox/messages');
    expect(url.searchParams.get('$select')).toContain('bodyPreview');
    // **本文は取らない。**一覧に body が混じると受信箱がまるごと手元に来る。
    expect(url.searchParams.get('$select')!.split(',')).not.toContain('body');
    expect(url.searchParams.get('$filter')).toBe('receivedDateTime ge 2026-09-01T00:00:00.000Z');
    expect(calls[0]!.authorization).toBe('Bearer ms-tok');
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      id: 'AAMk1',
      conversationId: 'AAQk1',
      from: { name: '田中 太郎', address: 'tanaka@example.com' },
      subject: '見積の確認をお願いします',
      unread: true,
      hasAttachments: true,
      folder: 'inbox',
    });
  });

  it('reads sent items by sent time', async () => {
    const { fetch, calls } = fakeFetch(() => ({ body: { value: [] } }));
    const mail = new OutlookMailConnector({ token, fetch, grantedScopes: READ });
    await mail.list({ folder: 'sentitems', since: '2026-09-01T00:00:00.000Z' });
    const url = new URL(calls[0]!.url);
    expect(url.pathname).toBe('/v1.0/me/mailFolders/sentitems/messages');
    expect(url.searchParams.get('$filter')).toBe('sentDateTime ge 2026-09-01T00:00:00.000Z');
    expect(url.searchParams.get('$orderby')).toBe('sentDateTime desc');
  });

  it('refuses to read without email.read, before touching the network', async () => {
    const { fetch, calls } = fakeFetch(() => ({ body: { value: [] } }));
    const mail = new OutlookMailConnector({ token, fetch, grantedScopes: ['calendar.read'] });
    await expect(mail.list()).rejects.toMatchObject({ reason: 'insufficient_scope' });
    expect(calls).toEqual([]);
  });

  it('fetches the body only when one message is asked for', async () => {
    const { fetch, calls } = fakeFetch(() => ({
      body: { ...rawMessage, body: { contentType: 'html', content: '<p>hi</p>' } },
    }));
    const mail = new OutlookMailConnector({ token, fetch, grantedScopes: READ });
    const message = await mail.get('AAMk1');
    expect(new URL(calls[0]!.url).searchParams.get('$select')).toContain('body');
    expect(message.body).toBe('<p>hi</p>');
    expect(message.bodyIsHtml).toBe(true);
  });

  it("replies only with Mail.Send, only with a person's approval, and posts comment to message: reply (202)", async () => {
    const proof = {
      approvalId: 'ap-1',
      operationId: 'outlook.mail.reply',
      decision: 'APPROVED' as const,
      decidedBy: 'user-1',
      decidedAt: '2026-09-07T00:00:00.000Z',
      expiresAt: '2099-01-01T00:00:00.000Z',
    };
    // scope が無ければ網に出ない
    const noScope = fakeFetch(() => ({ status: 202, body: {} }));
    const readOnly = new OutlookMailConnector({
      token,
      fetch: noScope.fetch,
      grantedScopes: ['email.read'],
    });
    await expect(readOnly.reply('AAMk1', 'ありがとうございます', proof)).rejects.toMatchObject({
      reason: 'insufficient_scope',
    });
    expect(noScope.calls).toEqual([]);
    // 承認が無ければ網に出ない
    const noProof = fakeFetch(() => ({ status: 202, body: {} }));
    const sender = new OutlookMailConnector({
      token,
      fetch: noProof.fetch,
      grantedScopes: ['email.read', 'email.send'],
    });
    await expect(sender.reply('AAMk1', 'ありがとうございます', undefined)).rejects.toMatchObject({
      name: 'ApprovalRequired',
    });
    expect(noProof.calls).toEqual([]);
    // 承認つきなら message: reply に comment を送る（Graph は 202、本文無し）
    const calls: { url: string; method: string; body: unknown }[] = [];
    const fetch = (async (url: string, init: RequestInit) => {
      calls.push({
        url,
        method: init.method ?? 'GET',
        body: init.body ? JSON.parse(init.body as string) : undefined,
      });
      return new Response('', { status: 202 });
    }) as unknown as typeof globalThis.fetch;
    const ok = new OutlookMailConnector({
      token,
      fetch,
      grantedScopes: ['email.read', 'email.send'],
    });
    await expect(ok.reply('AAMk1', 'ご連絡ありがとうございます。', proof)).resolves.toEqual({
      accepted: true,
    });
    expect(calls).toEqual([
      {
        url: 'https://graph.microsoft.com/v1.0/me/messages/AAMk1/reply',
        method: 'POST',
        body: { comment: 'ご連絡ありがとうございます。' },
      },
    ]);
  });

  it('maps Graph failures to the shared reasons', async () => {
    const { fetch } = fakeFetch(() => ({
      status: 401,
      body: { error: { code: 'InvalidAuthenticationToken', message: 'expired' } },
    }));
    const mail = new OutlookMailConnector({ token, fetch, grantedScopes: READ });
    await expect(mail.list()).rejects.toBeInstanceOf(ConnectorError);
    await expect(mail.list()).rejects.toMatchObject({ reason: 'token_expired' });
  });
});

describe('OutlookCalendarConnector', () => {
  it('expands the calendar view and turns Graph times into ISO', async () => {
    const { fetch, calls } = fakeFetch(() => ({
      body: {
        value: [
          {
            id: 'ev1',
            subject: 'MOPITA 定例',
            bodyPreview: '進捗確認',
            start: { dateTime: '2026-09-08T01:00:00.0000000', timeZone: 'UTC' },
            end: { dateTime: '2026-09-08T02:00:00.0000000', timeZone: 'UTC' },
            isAllDay: false,
            isCancelled: false,
            isOrganizer: false,
            attendees: [
              {
                emailAddress: { name: '佐藤', address: 'sato@example.com' },
                status: { response: 'tentativelyAccepted' },
                type: 'required',
              },
            ],
            organizer: { emailAddress: { name: '鈴木', address: 'suzuki@example.com' } },
            webLink: 'https://outlook.office.com/calendar/item/ev1',
            onlineMeeting: { joinUrl: 'https://teams.microsoft.com/l/meetup-join/x' },
          },
          {
            id: 'ev2',
            subject: '出張',
            start: { dateTime: '2026-09-10T00:00:00.0000000', timeZone: 'UTC' },
            end: { dateTime: '2026-09-11T00:00:00.0000000', timeZone: 'UTC' },
            isAllDay: true,
          },
        ],
      },
    }));
    const calendar = new OutlookCalendarConnector({ token, fetch, grantedScopes: READ });
    const events = await calendar.list({
      timeMin: '2026-09-07T00:00:00.000Z',
      timeMax: '2026-09-14T00:00:00.000Z',
    });

    const url = new URL(calls[0]!.url);
    expect(url.pathname).toBe('/v1.0/me/calendarView');
    expect(url.searchParams.get('startDateTime')).toBe('2026-09-07T00:00:00.000Z');
    expect(events[0]).toMatchObject({
      id: 'ev1',
      title: 'MOPITA 定例',
      start: { dateTime: '2026-09-08T01:00:00.000Z', date: null },
      attendees: [{ address: 'sato@example.com', responseStatus: 'tentative' }],
      organizer: { address: 'suzuki@example.com' },
      onlineMeetingUrl: 'https://teams.microsoft.com/l/meetup-join/x',
    });
    // 終日は日付だけ。時刻を作らない。
    expect(events[1]!.start).toEqual({ dateTime: null, date: '2026-09-10', timeZone: 'UTC' });
  });

  it('needs calendar.read', async () => {
    const { fetch, calls } = fakeFetch(() => ({ body: { value: [] } }));
    const calendar = new OutlookCalendarConnector({ token, fetch, grantedScopes: ['email.read'] });
    await expect(
      calendar.list({ timeMin: '2026-09-07T00:00:00Z', timeMax: '2026-09-08T00:00:00Z' }),
    ).rejects.toMatchObject({ reason: 'insufficient_scope' });
    expect(calls).toEqual([]);
  });
});

describe('MicrosoftTodoConnector', () => {
  it('walks every list and leaves completed tasks out by default', async () => {
    const { fetch, calls } = fakeFetch((url) =>
      url.endsWith('/me/todo/lists')
        ? {
            body: {
              value: [
                { id: 'L1', displayName: 'Tasks' },
                { id: 'L2', displayName: 'MOPITA' },
              ],
            },
          }
        : {
            body: {
              value: [
                {
                  id: url.includes('/L1/') ? 't1' : 't2',
                  title: url.includes('/L1/') ? '経費精算' : '要件定義書レビュー',
                  status: 'notStarted',
                  importance: 'high',
                  dueDateTime: { dateTime: '2026-09-09T00:00:00.0000000', timeZone: 'UTC' },
                  createdDateTime: '2026-09-01T00:00:00Z',
                  lastModifiedDateTime: '2026-09-06T00:00:00Z',
                  body: { content: '' },
                },
              ],
            },
          },
    );
    const todo = new MicrosoftTodoConnector({ token, fetch, grantedScopes: READ });
    const tasks = await todo.list();

    expect(calls).toHaveLength(3);
    for (const call of calls.slice(1)) {
      expect(new URL(call.url).searchParams.get('$filter')).toBe("status ne 'completed'");
    }
    expect(tasks.map((t) => [t.listName, t.title, t.importance, t.dueAt])).toEqual([
      ['Tasks', '経費精算', 'high', '2026-09-09T00:00:00.000Z'],
      ['MOPITA', '要件定義書レビュー', 'high', '2026-09-09T00:00:00.000Z'],
    ]);
  });

  it('needs tasks.read', async () => {
    const { fetch, calls } = fakeFetch(() => ({ body: { value: [] } }));
    const todo = new MicrosoftTodoConnector({ token, fetch, grantedScopes: ['email.read'] });
    await expect(todo.list()).rejects.toMatchObject({ reason: 'insufficient_scope' });
    expect(calls).toEqual([]);
  });

  it('asks for the token at call time', async () => {
    const t = vi.fn().mockResolvedValue('tok-2');
    const { fetch } = fakeFetch(() => ({ body: { value: [] } }));
    const todo = new MicrosoftTodoConnector({ token: t, fetch, grantedScopes: READ });
    await todo.list();
    await todo.list();
    expect(t).toHaveBeenCalledTimes(2);
  });
});
