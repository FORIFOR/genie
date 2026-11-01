import { describe, expect, it } from 'vitest';
import { ConnectorError, type CalendarEvent } from '@genie/service-connectors';
import type { ConnectorRuntime } from '../src/connector-steps.js';
import { briefEventFrom, offsetOf, readBriefGoogleCalendar } from '../src/brief/calendar.js';

const event = (over: Partial<CalendarEvent>): CalendarEvent => ({
  id: 'e',
  title: '定例',
  description: null,
  location: null,
  start: { dateTime: '2026-10-06T10:00:00+09:00', date: null, timeZone: null },
  end: { dateTime: '2026-10-06T11:00:00+09:00', date: null, timeZone: null },
  attendees: [],
  organizerEmail: null,
  status: 'confirmed',
  htmlLink: null,
  conferenceUri: null,
  ...over,
});

const runtime = (over: {
  connected?: boolean;
  granted?: string[];
  list?: () => Promise<CalendarEvent[]>;
}): ConnectorRuntime =>
  ({
    connected: async () => over.connected ?? true,
    granted: () => over.granted ?? ['calendar.read'],
    googleCalendar: () => ({ list: over.list ?? (async () => [event({})]) }),
  }) as unknown as ConnectorRuntime;

const window = { timeMin: '2026-10-05T00:00:00Z', timeMax: '2026-10-07T00:00:00Z' };

describe('Google Calendar in the brief', () => {
  it('turns timed and all-day events into brief events, without cancelled ones', () => {
    expect(briefEventFrom(event({ location: ' 品川 ' }), '+09:00')).toEqual({
      title: '定例',
      start: '2026-10-06T10:00:00+09:00',
      end: '2026-10-06T11:00:00+09:00',
      location: '品川',
    });
    expect(
      briefEventFrom(
        event({
          start: { dateTime: null, date: '2026-10-06', timeZone: null },
          end: { dateTime: null, date: '2026-10-07', timeZone: null },
        }),
        '+09:00',
      ),
    ).toMatchObject({
      start: '2026-10-06T00:00:00+09:00',
      end: '2026-10-07T00:00:00+09:00',
      allDay: true,
    });
    expect(briefEventFrom(event({ status: 'cancelled' }), '+09:00')).toBeNull();
  });

  it('reads only when connected and allowed, and gives null instead of failing', async () => {
    expect(await readBriefGoogleCalendar(undefined, window, '+09:00')).toBeNull();
    expect(
      await readBriefGoogleCalendar(runtime({ connected: false }), window, '+09:00'),
    ).toBeNull();
    expect(await readBriefGoogleCalendar(runtime({ granted: [] }), window, '+09:00')).toBeNull();
    expect(
      await readBriefGoogleCalendar(
        runtime({ list: () => Promise.reject(new Error('token_expired')) }),
        window,
        '+09:00',
      ),
    ).toBeNull();
    expect(await readBriefGoogleCalendar(runtime({}), window, '+09:00')).toMatchObject({
      source: 'Google カレンダー',
      events: [{ title: '定例' }],
    });
  });

  it('tells a cut connection apart from an ordinary failure', async () => {
    const list = (error: Error) => async () => {
      throw error;
    };
    expect(
      await readBriefGoogleCalendar(
        runtime({ list: list(new ConnectorError('token_expired', 'x')) }),
        window,
        '+09:00',
      ),
    ).toEqual({ events: [], source: 'Google カレンダー', reconnect: true });
    expect(
      await readBriefGoogleCalendar(runtime({ list: list(new Error('network')) }), window, '+09:00'),
    ).toBeNull();
  });

  it('writes the time zone offset of the day', () => {
    expect(offsetOf(new Date('2026-10-06T00:00:00Z'), 'Asia/Tokyo')).toBe('+09:00');
    expect(offsetOf(new Date('2026-07-01T00:00:00Z'), 'UTC')).toBe('+00:00');
  });
});
