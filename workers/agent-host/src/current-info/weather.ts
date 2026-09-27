/**
 * 天気。Open-Meteo の予報を、そのまま定型の文とカードの値にする。
 *
 * 数字は取得した値だけ。無い値は「—」にし、埋めない。
 */
import { INFO_SCHEMA, type InfoEnvelope, type WeatherDay } from './envelope.js';
import type { InfoFetch } from './hosts.js';
import { knownPlace, resolvePlace, type Place } from './places.js';

export const OPEN_METEO = { name: 'Open-Meteo.com', url: 'https://open-meteo.com/' } as const;

const FORECAST_DAYS = 8;
const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'] as const;

/** WMO weather code → 日本語。 */
export function weatherSummary(code: number): string {
  if (code === 0) return '快晴';
  if (code === 1) return '晴れ';
  if (code === 2) return '晴れ時々くもり';
  if (code === 3) return 'くもり';
  if (code === 45 || code === 48) return '霧';
  if (code >= 51 && code <= 57) return '霧雨';
  if (code >= 61 && code <= 67) return code >= 65 ? '強い雨' : '雨';
  if (code >= 71 && code <= 77) return '雪';
  if (code >= 80 && code <= 82) return 'にわか雨';
  if (code === 85 || code === 86) return 'にわか雪';
  if (code >= 95) return '雷雨';
  return '不明';
}

interface Forecast {
  readonly current?: { temperature_2m?: number; weather_code?: number };
  readonly daily?: {
    time?: string[];
    weather_code?: (number | null)[];
    temperature_2m_max?: (number | null)[];
    temperature_2m_min?: (number | null)[];
    precipitation_probability_max?: (number | null)[];
  };
}

function weekday(date: string): number {
  return new Date(`${date}T00:00:00Z`).getUTCDay();
}

/** 読み上げる文で使う言い方（今日・明日・明後日・9/30）。 */
function relative(date: string, index: number): string {
  if (index === 0) return '今日';
  if (index === 1) return '明日';
  if (index === 2) return '明後日';
  const [, month, day] = date.split('-');
  return `${Number(month)}/${Number(day)}`;
}

/** カードの見出し。どの日も曜日をそろえて付ける（今日(日)・9/30(水)）。 */
function label(date: string, index: number): string {
  return `${relative(date, index)}(${WEEKDAYS[weekday(date)]})`;
}

/** 聞かれた日を、予報の何日目かにする。 */
export function selectDays(when: string, dates: readonly string[]): number[] {
  const all = dates.map((_, i) => i);
  if (when === 'tomorrow') return all.slice(1, 2);
  if (when === 'day_after') return all.slice(2, 3);
  if (when === 'week') return all.slice(0, 7);
  if (when === 'weekend') {
    const saturday = all.find((i) => weekday(dates[i]!) === 6);
    const sunday = all.find((i) => weekday(dates[i]!) === 0 && (saturday === undefined || i > saturday));
    // 日曜に聞かれたら今日（日曜）だけ
    if (weekday(dates[0]!) === 0) return [0];
    return [saturday, sunday].filter((i): i is number => i !== undefined);
  }
  const named = /^weekday:(\d)$/.exec(when);
  if (named) {
    const found = all.find((i) => weekday(dates[i]!) === Number(named[1]));
    return found === undefined ? [] : [found];
  }
  return all.slice(0, 1);
}

function degrees(value: number | null): string {
  return value === null ? '—' : `${Math.round(value)}℃`;
}

function sentence(place: string, days: readonly (WeatherDay & { spoken: string })[], current: { temperature: number } | null): string {
  if (days.length === 1) {
    const d = days[0]!;
    const now = current ? `いまは${degrees(current.temperature)}。` : '';
    const rain = d.precipitation === null ? '' : `、降水確率${d.precipitation}%`;
    return `${d.spoken}の${place}は${d.summary}。${now}最高${degrees(d.high)}、最低${degrees(d.low)}${rain}です。`;
  }
  const lines = days.map(
    (d) =>
      `${d.spoken} ${d.summary} ${degrees(d.high)}/${degrees(d.low)}${d.precipitation === null ? '' : ` 降水${d.precipitation}%`}`,
  );
  return `${place}の天気: ${lines.join('、')}。`;
}

export interface WeatherQuery {
  readonly when: string;
  readonly place: string | null;
}

export async function lookupWeather(
  query: WeatherQuery,
  get: InfoFetch,
  region: string,
  now: () => Date = () => new Date(),
): Promise<InfoEnvelope> {
  const fetchedAt = now().toISOString();
  const base = { schema: INFO_SCHEMA, kind: 'weather', sources: [OPEN_METEO], fetched_at: fetchedAt } as const;
  const place: Place | null = query.place
    ? await resolvePlace(query.place, get)
    : knownPlace(region);
  if (!place)
    return {
      ...base,
      text: `「${query.place ?? region}」の場所が見つかりませんでした。市区町村名や都道府県名で聞いてください。`,
      data: null,
    };
  const params = new URLSearchParams({
    latitude: String(place.latitude),
    longitude: String(place.longitude),
    daily: 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max',
    current: 'temperature_2m,weather_code',
    timezone: 'auto',
    forecast_days: String(FORECAST_DAYS),
  });
  const forecast = JSON.parse(
    await get(`https://api.open-meteo.com/v1/forecast?${params.toString()}`),
  ) as Forecast;
  const daily = forecast.daily ?? {};
  const dates = daily.time ?? [];
  const picked = selectDays(query.when, dates);
  const spokenDays = picked
    .filter((i) => typeof daily.weather_code?.[i] === 'number')
    .map((i) => {
      const code = daily.weather_code![i]!;
      return {
        spoken: relative(dates[i]!, i),
        date: dates[i]!,
        label: label(dates[i]!, i),
        code,
        summary: weatherSummary(code),
        high: daily.temperature_2m_max?.[i] ?? null,
        low: daily.temperature_2m_min?.[i] ?? null,
        precipitation: daily.precipitation_probability_max?.[i] ?? null,
      };
    });
  const days: WeatherDay[] = spokenDays.map(({ spoken: _spoken, ...day }) => day);
  if (days.length === 0)
    return { ...base, text: `${place.name}の、その日の予報はまだ出ていません。`, data: null };
  const c = forecast.current;
  const current =
    picked[0] === 0 && days.length === 1 && typeof c?.temperature_2m === 'number' && typeof c.weather_code === 'number'
      ? { temperature: c.temperature_2m, code: c.weather_code, summary: weatherSummary(c.weather_code) }
      : null;
  return {
    ...base,
    text: sentence(place.name, spokenDays, current),
    data: { place: place.name, current, days },
  };
}
