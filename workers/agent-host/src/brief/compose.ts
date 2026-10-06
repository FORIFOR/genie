/**
 * 今日のまとめを組み立てる（先回り 段階1、読み取り専用）。
 *
 * **モデルは使わない。**予定・対応事項は Mac から受け取り、天気とニュースは既存の許可された
 * 取得先（Open-Meteo・NHK・Google ニュース）から取り、要点は規則で選ぶ。
 * 取れなかった情報源は「未更新」と書き、古い値や推測で埋めない。外へは何も作用しない。
 */
import {
  BRIEF_SCHEMA,
  type BriefArgs,
  type BriefEnvelope,
  type BriefEvent,
  type BriefLine,
  type BriefSection,
} from '@genie/contracts';
import type { InfoFetch } from '../current-info/hosts.js';
import { lookupNews } from '../current-info/news.js';
import { knownPlace, resolvePlace, type Place } from '../current-info/places.js';
import { OPEN_METEO, lookupWeather } from '../current-info/weather.js';

export interface BriefDeps {
  readonly get: InfoFetch;
  /** 既定の地域（設定。無ければ東京都） */
  readonly region: string;
  readonly now?: () => Date;
  readonly timeZone?: string;
}

/** 予定の時間に重なる降水確率がこれ以上なら「雨が重なる」と言う。 */
export const RAIN_THRESHOLD = 50;
const MAX_PLACES = 3;

const reasonOf = (error: unknown) =>
  error instanceof Error && error.message ? error.message.slice(0, 120) : '取得できませんでした';

function clock(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat('ja-JP', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(iso));
}

/** その時刻の、指定した時間帯での「YYYY-MM-DDTHH」（Open-Meteo の hourly の時刻と比べる）。 */
function localHour(date: Date, timeZone: string): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      hour12: false,
    })
      .formatToParts(date)
      .map((p) => [p.type, p.value]),
  );
  return `${parts['year']}-${parts['month']}-${parts['day']}T${parts['hour'] === '24' ? '00' : parts['hour']}`;
}

interface HourlyRain {
  readonly place: string;
  readonly byHour: ReadonlyMap<string, number>;
}

async function hourlyRain(
  place: Place,
  date: string,
  get: InfoFetch,
  timeZone: string,
): Promise<HourlyRain> {
  const params = new URLSearchParams({
    latitude: String(place.latitude),
    longitude: String(place.longitude),
    hourly: 'precipitation_probability',
    timezone: timeZone,
    start_date: date,
    end_date: date,
  });
  const body = JSON.parse(
    await get(`https://api.open-meteo.com/v1/forecast?${params.toString()}`),
  ) as {
    hourly?: { time?: string[]; precipitation_probability?: (number | null)[] };
  };
  const times = body.hourly?.time ?? [];
  const probs = body.hourly?.precipitation_probability ?? [];
  const byHour = new Map<string, number>();
  times.forEach((t, i) => {
    const p = probs[i];
    if (typeof p === 'number') byHour.set(t.slice(0, 13), p);
  });
  if (byHour.size === 0) throw new Error('時間ごとの予報が空でした');
  return { place: place.name, byHour };
}

/** 予定の時間（開始の時から終了の前の時まで）で、いちばん高い降水確率。 */
export function rainDuring(event: BriefEvent, rain: HourlyRain, timeZone: string): number | null {
  const start = new Date(event.start).getTime();
  const end = Math.max(new Date(event.end).getTime(), start + 1);
  let best: number | null = null;
  for (let t = start - (start % 3_600_000); t < end; t += 3_600_000) {
    const p = rain.byHour.get(localHour(new Date(t), timeZone));
    if (p !== undefined) best = best === null ? p : Math.max(best, p);
  }
  return best;
}

export async function composeBrief(args: BriefArgs, deps: BriefDeps): Promise<BriefEnvelope> {
  const now = deps.now ?? (() => new Date());
  const timeZone = deps.timeZone ?? 'Asia/Tokyo';
  const at = () => now().toISOString();
  const sections: BriefSection[] = [];
  const highlights: string[] = [];
  const spoken: string[] = [];
  // 会話へ渡す文。題名・相手・件名を入れない（件数・時刻・状態・公開の天気だけ）。
  const talk: string[] = [];

  // ---- 予定（Mac の EventKit から） ----
  const events = [...args.calendar.events].sort((a, b) => a.start.localeCompare(b.start));
  if (args.calendar.status !== 'granted') {
    sections.push({
      id: 'calendar',
      title: '予定',
      status: 'none',
      reason: 'カレンダーの許可がありません',
      fetched_at: null,
      sources: [],
      lines: [],
    });
  } else {
    sections.push({
      id: 'calendar',
      title: '予定',
      status: 'ok',
      fetched_at: args.calendar.fetched_at,
      sources: [{ name: 'このMacのカレンダー', url: '' }],
      lines: events.map((e) => ({
        text: `${e.allDay ? '終日' : `${clock(e.start, timeZone)}–${clock(e.end, timeZone)}`} ${e.title}${e.location ? `（${e.location}）` : ''}`,
        ...(e.allDay ? {} : { time: clock(e.start, timeZone) }),
      })),
    });
    const timed = events.filter((e) => !e.allDay);
    const upcoming = timed.find((e) => new Date(e.end).getTime() > now().getTime());
    if (events.length === 0) {
      spoken.push('今日の予定はありません。');
      talk.push('今日の予定はありません。');
    } else if (upcoming) {
      spoken.push(
        `今日の予定は${events.length}件、次は${clock(upcoming.start, timeZone)}の「${upcoming.title}」です。`,
      );
      highlights.push(`次の予定: ${clock(upcoming.start, timeZone)} ${upcoming.title}`);
      talk.push(`今日の予定は${events.length}件、次は${clock(upcoming.start, timeZone)}からです。`);
    } else {
      const done = `今日の予定は${events.length}件で、時間の決まった予定はもう終わっています。`;
      spoken.push(done);
      talk.push(done);
    }
  }

  // ---- 天気（地域の今日 + 予定の時間・場所に重なる雨） ----
  try {
    const today = await lookupWeather({ when: 'today', place: null }, deps.get, deps.region, now);
    const day = today.kind === 'weather' ? today.data?.days[0] : undefined;
    if (!day || today.kind !== 'weather' || !today.data) throw new Error(today.text);
    const lines: BriefLine[] = [
      {
        text: `${today.data.place} ${day.summary} ${day.high ?? '-'}°/${day.low ?? '-'}°${day.precipitation === null ? '' : ` 降水${day.precipitation}%`}`,
      },
    ];
    // 予定の場所ごとに時間の予報を取り、予定の時間に雨が重なるかを見る（場所が読めなければ地域で）。
    const regionPlace = knownPlace(deps.region);
    const cache = new Map<string, Promise<HourlyRain | null>>();
    const rainFor = (place: Place) => {
      const key = `${place.latitude},${place.longitude}`;
      if (!cache.has(key) && cache.size < MAX_PLACES)
        cache.set(
          key,
          hourlyRain(place, args.date, deps.get, timeZone).catch(() => null),
        );
      return cache.get(key) ?? Promise.resolve(null);
    };
    const upcomingTimed =
      args.calendar.status === 'granted'
        ? events.filter((e) => !e.allDay && new Date(e.end).getTime() > now().getTime())
        : [];
    for (const event of upcomingTimed) {
      const place =
        (event.location ? await resolvePlace(event.location, deps.get).catch(() => null) : null) ??
        regionPlace;
      if (!place) continue;
      const rain = await rainFor(place);
      if (!rain) continue;
      const p = rainDuring(event, rain, timeZone);
      if (p !== null && p >= RAIN_THRESHOLD) {
        const line = `${clock(event.start, timeZone)}「${event.title}」の時間に雨の可能性（${rain.place} ${p}%）`;
        lines.push({ text: line, time: clock(event.start, timeZone) });
        highlights.unshift(line);
        spoken.push(
          `${clock(event.start, timeZone)}の「${event.title}」の時間は雨の可能性があります（${p}%）。`,
        );
        talk.push(
          `${clock(event.start, timeZone)}からの予定の時間は雨の可能性があります（${p}%）。`,
        );
      }
    }
    if (
      upcomingTimed.length === 0 &&
      day.precipitation !== null &&
      day.precipitation >= RAIN_THRESHOLD
    )
      spoken.push(`${today.data.place}は今日、降水確率${day.precipitation}%です。`);
    talk.push(
      `${today.data.place}の天気は${day.summary}、最高${day.high ?? '-'}度、最低${day.low ?? '-'}度${day.precipitation === null ? '' : `、降水確率${day.precipitation}%`}です。`,
    );
    sections.push({
      id: 'weather',
      title: '天気',
      status: 'ok',
      fetched_at: today.fetched_at,
      sources: [OPEN_METEO],
      lines,
    });
  } catch (error) {
    sections.push({
      id: 'weather',
      title: '天気',
      status: 'stale',
      reason: reasonOf(error),
      fetched_at: null,
      sources: [OPEN_METEO],
      lines: [],
    });
  }

  // ---- 対応が要るもの（Mac が Work から渡す。メールや Work をつないでいなければ none） ----
  if (args.attention.status === 'ok') {
    const items = args.attention.items;
    sections.push({
      id: 'attention',
      title: '要対応',
      status: 'ok',
      fetched_at: args.attention.fetched_at ?? null,
      sources: [{ name: 'Work（メール・予定の同期）', url: '' }],
      lines: items.map((i) => ({
        text: `${i.title}${i.from ? `（${i.from}）` : ''}${i.due ? ` 期限 ${i.due}` : ''}`,
        ...(i.ref ? { ref: i.ref } : {}),
      })),
    });
    if (items.length > 0) {
      highlights.push(`対応が要るもの ${items.length}件`);
      spoken.push(`対応が要るものが${items.length}件あります。`);
      talk.push(`対応が要るものが${items.length}件あります。`);
    }
  } else {
    sections.push({
      id: 'attention',
      title: '要対応',
      status: args.attention.status,
      reason:
        args.attention.status === 'none'
          ? 'メールや Work をつないでいません'
          : 'Work を読めませんでした',
      fetched_at: null,
      sources: [],
      lines: [],
    });
  }

  // ---- ニュース（本人が決めた話題。無ければ主なニュース） ----
  try {
    const topics = args.interests.length ? args.interests : [null];
    const seen = new Set<string>();
    const lines: BriefLine[] = [];
    const sources: { name: string; url: string }[] = [];
    let fetchedAt: string | null = null;
    let failures = 0;
    for (const topic of topics) {
      try {
        const news = await lookupNews({ topic }, deps.get, now);
        fetchedAt = news.fetched_at;
        for (const s of news.sources)
          if (!sources.some((x) => x.name === s.name)) sources.push({ ...s });
        if (news.kind !== 'news' || !news.data) continue;
        for (const item of news.data.items.slice(0, 3)) {
          if (seen.has(item.title)) continue;
          seen.add(item.title);
          lines.push({ text: `${topic ? `［${topic}］` : ''}${item.title}`, url: item.url });
        }
      } catch {
        failures += 1;
      }
    }
    if (failures === topics.length) throw new Error('ニュースを取得できませんでした');
    sections.push({
      id: 'news',
      title: 'ニュース',
      status: 'ok',
      fetched_at: fetchedAt,
      sources,
      lines: lines.slice(0, 6),
    });
  } catch (error) {
    sections.push({
      id: 'news',
      title: 'ニュース',
      status: 'stale',
      reason: reasonOf(error),
      fetched_at: null,
      sources: [],
      lines: [],
    });
  }

  // ---- 相場（取得元が未設定。米国向けの配信で国内株を代用しない） ----
  sections.push({
    id: 'markets',
    title: '監視銘柄',
    status: 'none',
    reason: '株価の取得元が未設定です（国内株に対応する提供元を選んでから使います）',
    fetched_at: null,
    sources: [],
    lines: [],
  });

  const stale = sections.filter((s) => s.status === 'stale').map((s) => s.title);
  if (stale.length) {
    spoken.push(`${stale.join('・')}は取得できず、未更新です。`);
    talk.push(`${stale.join('・')}は取得できず、未更新です。`);
  }
  const news = sections.find((s) => s.id === 'news');
  if (news?.status === 'ok' && news.lines.length)
    talk.push(`ニュースは${news.lines.length}件を画面に出しています。`);
  return {
    schema: BRIEF_SCHEMA,
    date: args.date,
    generated_at: at(),
    text: spoken.join(''),
    talk: talk.join(''),
    highlights: highlights.slice(0, 4),
    sections,
  };
}
