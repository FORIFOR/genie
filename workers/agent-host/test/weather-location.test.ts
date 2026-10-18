import { describe, expect, it } from 'vitest';
import type { InfoFetch } from '../src/current-info/hosts.js';
import { lookupWeather, type WeatherQuery } from '../src/current-info/weather.js';

const now = () => new Date('2026-10-10T03:00:00Z');
const forecast = JSON.stringify({
  current: { temperature_2m: 20, weather_code: 1 },
  daily: {
    time: ['2026-10-10'],
    weather_code: [1],
    temperature_2m_max: [23],
    temperature_2m_min: [15],
    precipitation_probability_max: [10],
  },
});

function fixture() {
  const urls: string[] = [];
  const get: InfoFetch = async (url) => {
    urls.push(url);
    return forecast;
  };
  return { get, urls };
}

describe('current location weather provider boundary', () => {
  it.each([
    [35.681236, 139.767125, '35.68', '139.77'],
    [-33.86882, -151.20929, '-33.87', '-151.21'],
    [90, -180, '90', '-180'],
    [0, 0, '0', '0'],
  ])(
    'uses only coarse coordinates without geocoding (%s, %s)',
    async (latitude, longitude, coarseLatitude, coarseLongitude) => {
      const { get, urls } = fixture();
      const result = await lookupWeather(
        {
          when: 'today',
          place: '使わない住所',
          coordinates: { latitude: latitude as number, longitude: longitude as number },
        },
        get,
        '東京都',
        now,
      );
      expect(urls).toHaveLength(1);
      const url = new URL(urls[0]!);
      expect(url.origin).toBe('https://api.open-meteo.com');
      expect(url.searchParams.get('latitude')).toBe(coarseLatitude);
      expect(url.searchParams.get('longitude')).toBe(coarseLongitude);
      expect(urls[0]).not.toContain(encodeURIComponent('使わない住所'));
      expect(result.data).toMatchObject({ place: '現在地付近' });
      expect(result.text).toContain('現在地付近');
      expect(JSON.stringify(result)).not.toMatch(/latitude|longitude/);
    },
  );

  it.each([
    { latitude: NaN, longitude: 0 },
    { latitude: 0, longitude: Infinity },
    { latitude: -Infinity, longitude: 0 },
    { latitude: 90.001, longitude: 0 },
    { latitude: -90.001, longitude: 0 },
    { latitude: 0, longitude: 180.001 },
    { latitude: 0, longitude: -180.001 },
    { latitude: '35.68', longitude: 139.77 },
    {},
    null,
  ])(
    'rejects invalid current location without falling back or disclosing values',
    async (coordinates) => {
      const { get, urls } = fixture();
      const result = await lookupWeather(
        { when: 'today', place: '大阪府', coordinates } as WeatherQuery,
        get,
        '東京都',
        now,
      );
      expect(urls).toEqual([]);
      expect(result.data).toBeNull();
      expect(result.text).toBe('現在地の位置情報を読み取れませんでした。');
    },
  );

  it('preserves configured-region weather when no coordinates were requested', async () => {
    const { get, urls } = fixture();
    const result = await lookupWeather({ when: 'today', place: null }, get, '大阪府', now);
    expect(result.data).toMatchObject({ place: '大阪府' });
    expect(new URL(urls[0]!).searchParams.get('latitude')).toBe('34.69');
  });

  it('requests the exact brief date and selects it when the provider starts on the previous local day', async () => {
    const urls: string[] = [];
    const get: InfoFetch = async (url) => {
      urls.push(url);
      return JSON.stringify({
        current: { temperature_2m: 99, weather_code: 1 },
        daily: {
          time: ['2026-10-09', '2026-10-10'],
          weather_code: [1, 61],
          temperature_2m_max: [99, 23],
          temperature_2m_min: [80, 15],
          precipitation_probability_max: [0, 80],
        },
      });
    };
    // Tokyo has entered Oct 10 while the requested US location is still on Oct 9.
    const result = await lookupWeather(
      {
        when: 'today',
        date: '2026-10-10',
        place: null,
        coordinates: { latitude: 34.05, longitude: -118.24 },
      },
      get,
      '東京都',
      () => new Date('2026-10-09T15:30:00Z'),
    );
    expect(result.data).toMatchObject({
      current: null,
      days: [
        {
          date: '2026-10-10',
          label: '10/10(土)',
          summary: '雨',
          high: 23,
          low: 15,
          precipitation: 80,
        },
      ],
    });
    expect(result.text).not.toMatch(/明日|99|いまは/);
    const query = new URL(urls[0]!).searchParams;
    expect(query.get('start_date')).toBe('2026-10-10');
    expect(query.get('end_date')).toBe('2026-10-10');
    expect(query.has('forecast_days')).toBe(false);
  });

  it.each([
    { dates: ['2026-10-09'] },
    { dates: ['2026-10-11'] },
    { dates: [] },
    { dates: ['2026-10-10', '2026-10-10'] },
  ])('rejects missing or ambiguous requested dates $dates', async ({ dates }) => {
    const get: InfoFetch = async () =>
      JSON.stringify({
        daily: {
          time: dates,
          weather_code: dates.map(() => 1),
          temperature_2m_max: dates.map(() => 99),
        },
      });
    const result = await lookupWeather(
      { when: 'today', date: '2026-10-10', place: null },
      get,
      '東京都',
      now,
    );
    expect(result.data).toBeNull();
    expect(result.text).toBe('対象日の天気予報を取得できませんでした。');
    expect(result.text).not.toContain('99');
  });

  it.each(['2026-02-30', '2026-13-01', '2026-00-10', 'invalid', '2026-10-10&latitude=0'])(
    'refuses invalid exact dates without network access: %s',
    async (date) => {
      const { get, urls } = fixture();
      const result = await lookupWeather({ when: 'today', date, place: null }, get, '東京都', now);
      expect(result.data).toBeNull();
      expect(urls).toEqual([]);
    },
  );

  it('keeps the relative forecast request and current observation for legacy callers', async () => {
    const { get, urls } = fixture();
    const result = await lookupWeather({ when: 'today', place: null }, get, '東京都', now);
    const query = new URL(urls[0]!).searchParams;
    expect(query.get('forecast_days')).toBe('8');
    expect(query.has('start_date')).toBe(false);
    expect(result.data).toMatchObject({
      current: { temperature: 20 },
      days: [{ label: '今日(土)' }],
    });
  });
});
