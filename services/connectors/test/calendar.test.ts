import { describe, expect, it } from 'vitest';
import { GoogleCalendarConnector, meetRequestId } from '../src/calendar.js';
import { ApprovalRequired, type ApprovalProof } from '../src/approval.js';

const NOW = (): Date => new Date('2026-08-27T00:00:00.000Z');
const READ_WRITE = ['calendar.read', 'calendar.write'];

const proof: ApprovalProof = {
  approvalId: 'ap-1',
  operationId: 'calendar.create',
  decision: 'APPROVED',
  decidedBy: 'user-1',
  decidedAt: '2026-08-26T23:59:00.000Z',
  expiresAt: '2026-08-27T00:05:00.000Z',
};

function fakeFetch(
  body: unknown,
  status = 200,
): {
  fetch: typeof globalThis.fetch;
  calls: { url: string; method: string; body: unknown }[];
} {
  const calls: { url: string; method: string; body: unknown }[] = [];
  const fetch = (async (url: string, init: RequestInit) => {
    calls.push({
      url,
      method: init.method ?? 'GET',
      body: init.body ? JSON.parse(init.body as string) : undefined,
    });
    return new Response(JSON.stringify(body), { status });
  }) as unknown as typeof globalThis.fetch;
  return { fetch, calls };
}

describe('GoogleCalendarConnector', () => {
  it('expands recurring events so a weekly meeting shows up this week', async () => {
    const { fetch, calls } = fakeFetch({ items: [] });
    const calendar = new GoogleCalendarConnector({
      token: async () => 't',
      fetch,
      grantedScopes: READ_WRITE,
      now: NOW,
    });

    await calendar.list({ timeMin: '2026-08-27T00:00:00Z', timeMax: '2026-08-28T00:00:00Z' });

    expect(calls[0]!.url).toContain('singleEvents=true');
    expect(calls[0]!.url).toContain('orderBy=startTime');
  });

  it('keeps an all-day event as a date, without inventing a time', async () => {
    const { fetch } = fakeFetch({
      items: [
        {
          id: 'e1',
          summary: '夏季休暇',
          start: { date: '2026-08-27' },
          end: { date: '2026-08-28' },
          status: 'confirmed',
        },
      ],
    });
    const calendar = new GoogleCalendarConnector({
      token: async () => 't',
      fetch,
      grantedScopes: READ_WRITE,
    });

    const [event] = await calendar.list({ timeMin: 'a', timeMax: 'b' });

    expect(event!.start).toEqual({ dateTime: null, date: '2026-08-27', timeZone: null });
    expect(event!.end.dateTime).toBeNull();
  });

  it('reads attendees, the organiser and a video link', async () => {
    const { fetch } = fakeFetch({
      id: 'e1',
      summary: '定例',
      start: { dateTime: '2026-08-27T01:00:00Z', timeZone: 'Asia/Tokyo' },
      end: { dateTime: '2026-08-27T02:00:00Z', timeZone: 'Asia/Tokyo' },
      attendees: [
        { email: 'a@example.com', responseStatus: 'accepted', organizer: true },
        { email: 'b@example.com' },
      ],
      organizer: { email: 'a@example.com' },
      status: 'confirmed',
      conferenceData: {
        entryPoints: [
          { entryPointType: 'phone', uri: 'tel:+81' },
          { entryPointType: 'video', uri: 'https://meet.example/abc' },
        ],
      },
    });
    const calendar = new GoogleCalendarConnector({
      token: async () => 't',
      fetch,
      grantedScopes: READ_WRITE,
    });

    const event = await calendar.get({ eventId: 'e1' });

    expect(event.attendees).toEqual([
      { email: 'a@example.com', responseStatus: 'accepted', organizer: true },
      // 返事のない人を「承諾」にしない
      { email: 'b@example.com', responseStatus: 'needsAction', organizer: false },
    ]);
    expect(event.organizerEmail).toBe('a@example.com');
    expect(event.conferenceUri).toBe('https://meet.example/abc');
  });

  it('leaves an untitled event untitled', async () => {
    const { fetch } = fakeFetch({ id: 'e1', status: 'confirmed' });
    const calendar = new GoogleCalendarConnector({
      token: async () => 't',
      fetch,
      grantedScopes: READ_WRITE,
    });
    expect((await calendar.get({ eventId: 'e1' })).title).toBe('');
  });

  it('will not create an event without approval, and issues no request', async () => {
    const { fetch, calls } = fakeFetch({});
    const calendar = new GoogleCalendarConnector({
      token: async () => 't',
      fetch,
      grantedScopes: READ_WRITE,
      now: NOW,
    });

    await expect(
      calendar.create(
        { title: '打ち合わせ', start: { date: '2026-09-01' }, end: { date: '2026-09-02' } },
        undefined,
      ),
    ).rejects.toBeInstanceOf(ApprovalRequired);
    expect(calls).toHaveLength(0);
  });

  it('does not send invitations on its own when it creates an event', async () => {
    const { fetch, calls } = fakeFetch({ id: 'e9', status: 'confirmed' });
    const calendar = new GoogleCalendarConnector({
      token: async () => 't',
      fetch,
      grantedScopes: READ_WRITE,
      now: NOW,
    });

    await calendar.create(
      {
        title: '打ち合わせ',
        start: { dateTime: '2026-09-01T01:00:00Z' },
        end: { dateTime: '2026-09-01T02:00:00Z' },
        attendeeEmails: ['b@example.com'],
      },
      proof,
    );

    expect(calls[0]!.url).toContain('sendUpdates=none');
    expect(calls[0]!.body).toMatchObject({
      summary: '打ち合わせ',
      attendees: [{ email: 'b@example.com' }],
    });
  });

  it('adds a Google Meet only when asked, and returns its link', async () => {
    const { fetch, calls } = fakeFetch({
      id: 'e10',
      status: 'confirmed',
      hangoutLink: 'https://meet.google.com/abc-defg-hij',
    });
    const calendar = new GoogleCalendarConnector({
      token: async () => 't',
      fetch,
      grantedScopes: READ_WRITE,
      now: NOW,
    });
    const input = {
      title: '打ち合わせ',
      start: { dateTime: '2026-09-01T15:00:00+09:00' },
      end: { dateTime: '2026-09-01T15:30:00+09:00' },
    };
    const made = await calendar.create({ ...input, meet: true }, proof);
    // conferenceDataVersion=1 が無いと、Google は Meet の頼みを黙って捨てる
    expect(calls[0]!.url).toContain('conferenceDataVersion=1');
    expect(calls[0]!.url).toContain('sendUpdates=none');
    expect(calls[0]!.body).toMatchObject({
      conferenceData: {
        createRequest: {
          requestId: meetRequestId(input),
          conferenceSolutionKey: { type: 'hangoutsMeet' },
        },
      },
    });
    expect(made.conferenceUri).toBe('https://meet.google.com/abc-defg-hij');
    // 同じ予定の頼みは同じ印（再試行で会議を 2 つ作らない）。違う予定は違う印
    expect(meetRequestId(input)).toBe(meetRequestId({ ...input }));
    expect(meetRequestId({ ...input, title: '別' })).not.toBe(meetRequestId(input));

    await calendar.create(input, proof);
    expect(calls[1]!.url).not.toContain('conferenceDataVersion');
    expect(calls[1]!.body).not.toHaveProperty('conferenceData');
  });

  it('refuses to write when only the read scope was granted', async () => {
    const { fetch, calls } = fakeFetch({});
    const calendar = new GoogleCalendarConnector({
      token: async () => 't',
      fetch,
      grantedScopes: ['calendar.read'],
      now: NOW,
    });

    await expect(
      calendar.create(
        { title: 'x', start: { date: '2026-09-01' }, end: { date: '2026-09-02' } },
        proof,
      ),
    ).rejects.toMatchObject({ reason: 'insufficient_scope' });
    expect(calls).toHaveLength(0);
  });

  it('caps how many events one call can pull back', async () => {
    const { fetch, calls } = fakeFetch({ items: [] });
    const calendar = new GoogleCalendarConnector({
      token: async () => 't',
      fetch,
      grantedScopes: READ_WRITE,
    });
    await calendar.list({ timeMin: 'a', timeMax: 'b', maxResults: 10_000 });
    expect(calls[0]!.url).toContain('maxResults=250');
  });

  // 仕様 v1.0 §11: 「午後にずらして」→ 承認 → 変更。変える前を返し、「元に戻して」に使う
  describe('moving an event', () => {
    const moveProof: ApprovalProof = { ...proof, operationId: 'calendar.move' };
    const sequenced = () => {
      const calls: { url: string; method: string; body: unknown }[] = [];
      const fetch = (async (url: string, init: RequestInit) => {
        const method = init.method ?? 'GET';
        calls.push({ url, method, body: init.body ? JSON.parse(init.body as string) : undefined });
        const event = (start: string, end: string) => ({
          id: 'e1',
          summary: '定例ミーティング',
          status: 'confirmed',
          start: { dateTime: start, timeZone: 'Asia/Tokyo' },
          end: { dateTime: end, timeZone: 'Asia/Tokyo' },
        });
        return new Response(
          JSON.stringify(
            method === 'GET'
              ? event('2026-10-28T10:00:00+09:00', '2026-10-28T11:00:00+09:00')
              : event('2026-10-28T14:00:00+09:00', '2026-10-28T15:00:00+09:00'),
          ),
        );
      }) as unknown as typeof globalThis.fetch;
      return { fetch, calls };
    };

    it('changes the time with approval, without notifying, and returns before and after', async () => {
      const { fetch, calls } = sequenced();
      const calendar = new GoogleCalendarConnector({
        token: async () => 't',
        fetch,
        grantedScopes: READ_WRITE,
        now: NOW,
      });
      const moved = await calendar.move(
        {
          eventId: 'e1',
          start: { dateTime: '2026-10-28T14:00:00+09:00', timeZone: 'Asia/Tokyo' },
          end: { dateTime: '2026-10-28T15:00:00+09:00', timeZone: 'Asia/Tokyo' },
        },
        moveProof,
      );
      expect(moved.before.start.dateTime).toBe('2026-10-28T10:00:00+09:00');
      expect(moved.after.start.dateTime).toBe('2026-10-28T14:00:00+09:00');
      expect(calls.map((c) => c.method)).toEqual(['GET', 'PATCH']);
      expect(calls[1]!.url).toContain('/events/e1?sendUpdates=none');
      expect(calls[1]!.body).toEqual({
        start: { dateTime: '2026-10-28T14:00:00+09:00', timeZone: 'Asia/Tokyo', date: null },
        end: { dateTime: '2026-10-28T15:00:00+09:00', timeZone: 'Asia/Tokyo', date: null },
      });
    });

    it('refuses without approval, with an approval for another operation, or mixing all-day and timed', async () => {
      const { fetch, calls } = sequenced();
      const calendar = new GoogleCalendarConnector({
        token: async () => 't',
        fetch,
        grantedScopes: READ_WRITE,
        now: NOW,
      });
      const input = {
        eventId: 'e1',
        start: { dateTime: '2026-10-28T14:00:00+09:00' },
        end: { dateTime: '2026-10-28T15:00:00+09:00' },
      };
      await expect(calendar.move(input, undefined)).rejects.toBeInstanceOf(ApprovalRequired);
      await expect(calendar.move(input, proof)).rejects.toBeInstanceOf(ApprovalRequired);
      await expect(
        calendar.move(
          {
            eventId: 'e1',
            start: { date: '2026-10-28' },
            end: { dateTime: '2026-10-28T15:00:00+09:00' },
          },
          moveProof,
        ),
      ).rejects.toMatchObject({ reason: 'provider_error' });
      expect(calls).toHaveLength(0);
    });
  });
});
