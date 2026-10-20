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
import { lookupNews, sameStory } from '../current-info/news.js';
import { DEFAULT_WATCHLIST, lookupMarkets } from '../current-info/markets.js';
import { knownPlace, resolvePlace, type Place } from '../current-info/places.js';
import { OPEN_METEO, lookupWeather } from '../current-info/weather.js';
import { offsetOf, type CloudCalendar } from './calendar.js';

export interface BriefDeps {
  readonly get: InfoFetch;
  /** 既定の地域（設定。無ければ東京都） */
  readonly region: string;
  readonly now?: () => Date;
  readonly timeZone?: string;
  /** Fresh metadata from the existing local read-only connection. */
  readonly mail?: () => Promise<BriefSection>;
  /** つないであるクラウドのカレンダー（Google）。読めなければ null。 */
  readonly cloudCalendar?: (
    window: { timeMin: string; timeMax: string },
    offset: string,
  ) => Promise<CloudCalendar | null>;
}

/** 同じ予定（Mac のカレンダーにも Google の予定が入っていることがある）を 1 つにする。 */
function mergeEvents(local: readonly BriefEvent[], cloud: readonly BriefEvent[]): BriefEvent[] {
  const key = (e: BriefEvent) => `${e.title.trim()}|${new Date(e.start).getTime()}`;
  const seen = new Set(local.map(key));
  return [...local, ...cloud.filter((e) => !seen.has(key(e)) && seen.add(key(e)))];
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

export interface HourlyRain {
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
    latitude: String(Math.round(place.latitude * 100) / 100),
    longitude: String(Math.round(place.longitude * 100) / 100),
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

/**
 * 今日これから（今の時刻〜21 時）の時間ごとの降水確率から、外出の判断に使う 1 行を作る。
 * 規則だけで決める: 50% 以上の時間帯があれば「傘を」、30% 未満なら「雨の心配は少なめ」。
 */
export function rainAdvice(rain: HourlyRain, now: Date, timeZone: string): string | null {
  const today = localHour(now, timeZone);
  const day = today.slice(0, 10);
  const from = Number(today.slice(11, 13));
  const hours: { hour: number; p: number }[] = [];
  for (let hour = from; hour <= 21; hour += 1) {
    const p = rain.byHour.get(`${day}T${String(hour).padStart(2, '0')}`);
    if (p !== undefined) hours.push({ hour, p });
  }
  if (hours.length === 0) return null;
  const max = Math.max(...hours.map((h) => h.p));
  const wet = hours.filter((h) => h.p >= RAIN_THRESHOLD);
  if (wet.length) {
    const first = wet[0]!.hour;
    const last = wet.at(-1)!.hour;
    const span = first === last ? `${first}時台` : `${first}〜${last + 1}時`;
    return `${span}に雨の可能性（最大${max}%）。外出には傘を。`;
  }
  if (max < 30) return `${from}時以降は雨の心配は少なめ（最大${max}%）。`;
  return `${from}時以降、にわか雨に注意（最大${max}%）。`;
}

export async function composeBrief(args: BriefArgs, deps: BriefDeps): Promise<BriefEnvelope> {
  const now = deps.now ?? (() => new Date());
  const timeZone = deps.timeZone ?? 'Asia/Tokyo';
  const region = args.region ?? deps.region;
  const location = args.weather_location;
  const currentPlace: Place | null =
    location?.status === 'ok'
      ? {
          name: '現在地付近',
          latitude: Math.round(location.latitude! * 100) / 100,
          longitude: Math.round(location.longitude! * 100) / 100,
        }
      : null;
  const mailRead = deps.mail?.().catch((): BriefSection => ({
    id: 'mail',
    title: '主要メール',
    status: 'stale',
    reason: 'メールを取得できませんでした',
    fetched_at: null,
    sources: [],
    lines: [],
  }));
  const at = () => now().toISOString();
  const sections: BriefSection[] = [];
  const highlights: string[] = [];
  const spoken: string[] = [];
  // 会話へ渡す文。題名・相手・件名を入れない（件数・時刻・状態・公開の天気だけ）。
  const talk: string[] = [];
  // 画面の冒頭の 1〜3 文: 予定 → 対応が要るもの → 雨。
  const summary: { schedule?: string; attention?: string; rain?: string; weather?: string } = {};

  // ---- 予定（Mac の EventKit と、つないである Google カレンダーから） ----
  const day = args.date;
  const cloud = deps.cloudCalendar
    ? await deps
        .cloudCalendar(
          {
            timeMin: new Date(now().getTime() - 86_400_000).toISOString(),
            timeMax: new Date(now().getTime() + 86_400_000).toISOString(),
          },
          offsetOf(now(), timeZone),
        )
        .catch(() => null)
    : null;
  // 今日（その人の日付）に掛かる予定だけ。終日予定は日付で見る。
  const today = (cloud?.events ?? []).filter((e) =>
    e.allDay
      ? e.start.slice(0, 10) <= day && day < e.end.slice(0, 10)
      : localHour(new Date(e.start), timeZone).slice(0, 10) <= day &&
        day <= localHour(new Date(e.end), timeZone).slice(0, 10),
  );
  const localEvents = args.calendar.status === 'granted' ? args.calendar.events : [];
  const events = mergeEvents(localEvents, today).sort((a, b) => a.start.localeCompare(b.start));
  const calendarSources = [
    ...(args.calendar.status === 'granted' ? [{ name: 'このMacのカレンダー', url: '' }] : []),
    ...(cloud ? [{ name: cloud.source, url: '' }] : []),
  ];
  if (args.calendar.status !== 'granted' && !cloud) {
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
      sources: calendarSources,
      lines: events.map((e) => ({
        text: `${e.allDay ? '終日' : `${clock(e.start, timeZone)}–${clock(e.end, timeZone)}`} ${e.title}${e.location ? `（${e.location}）` : ''}`,
        ...(e.allDay ? {} : { time: clock(e.start, timeZone) }),
      })),
    });
    const timed = events.filter((e) => !e.allDay);
    const upcoming = timed.find((e) => new Date(e.end).getTime() > now().getTime());
    if (events.length === 0) {
      summary.schedule = '今日は予定が入っていません。';
      spoken.push('今日の予定はありません。');
      talk.push('今日の予定はありません。');
    } else if (upcoming) {
      summary.schedule = `今日は予定が${events.length}件、次は${clock(upcoming.start, timeZone)}の「${upcoming.title.slice(0, 40)}」です。`;
      spoken.push(
        `今日の予定は${events.length}件、次は${clock(upcoming.start, timeZone)}の「${upcoming.title}」です。`,
      );
      highlights.push(`次の予定: ${clock(upcoming.start, timeZone)} ${upcoming.title}`);
      talk.push(`今日の予定は${events.length}件、次は${clock(upcoming.start, timeZone)}からです。`);
    } else {
      const done = `今日の予定は${events.length}件で、時間の決まった予定はもう終わっています。`;
      summary.schedule = done;
      spoken.push(done);
      talk.push(done);
    }
  }

  // ---- 天気（地域の今日 + 予定の時間・場所に重なる雨） ----
  if (location && location.status !== 'ok') {
    sections.push({
      id: 'weather',
      title: '天気',
      status: location.status,
      reason:
        location.reason ??
        (location.status === 'none'
          ? '天気を表示するには現在地の使用を許可してください'
          : '現在地を取得できませんでした'),
      fetched_at: null,
      sources: [],
      lines: [],
    });
  } else
    try {
      const today = await lookupWeather(
        {
          when: 'today',
          date: args.date,
          place: currentPlace ? null : knownPlace(region) ? null : region,
          ...(currentPlace
            ? {
                coordinates: { latitude: currentPlace.latitude, longitude: currentPlace.longitude },
              }
            : {}),
        },
        deps.get,
        region,
        now,
      );
      const day = today.kind === 'weather' ? today.data?.days[0] : undefined;
      if (!day || today.kind !== 'weather' || !today.data) throw new Error(today.text);
      const lines: BriefLine[] = [
        {
          // 数字だけ並べると高低の順が読めないので「最高・最低」を付ける。
          text: `${today.data.place} ${day.summary} 最高${day.high ?? '-'}° 最低${day.low ?? '-'}°${day.precipitation === null ? '' : ` 降水${day.precipitation}%`}`,
        },
      ];
      // 予定の場所ごとに時間の予報を取り、予定の時間に雨が重なるかを見る（場所が読めなければ地域で）。
      const regionPlace =
        currentPlace ??
        knownPlace(region) ??
        (await resolvePlace(region, deps.get).catch(() => null));
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
      // 今日これからの時間帯の雨（予定が無くても、外出の判断に使える 1 行）。
      const regionRain = regionPlace ? await rainFor(regionPlace) : null;
      if (regionRain) {
        const advice = rainAdvice(regionRain, now(), timeZone);
        if (advice) lines.push({ text: advice });
        if (advice?.includes('傘')) summary.rain = advice;
      }
      const upcomingTimed =
        calendarSources.length > 0
          ? events.filter((e) => !e.allDay && new Date(e.end).getTime() > now().getTime())
          : [];
      for (const event of upcomingTimed) {
        const place =
          currentPlace ??
          (event.location
            ? await resolvePlace(event.location, deps.get).catch(() => null)
            : null) ??
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
      summary.weather = `${today.data.place}は${day.summary}、最高${day.high ?? '-'}度の予報です。`;
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

  // ---- 主要メール（まとめを作るたび、許可された本人の接続から取得） ----
  const mail = (await mailRead) ?? {
    id: 'mail' as const,
    title: '主要メール',
    status: 'none' as const,
    reason: 'メールの読み取り接続がありません',
    fetched_at: null,
    sources: [],
    lines: [],
  };
  sections.push(mail);
  if (mail.status === 'ok') {
    const mailCount = `主要メールは${mail.lines.length}件を画面に出しています。`;
    spoken.push(mailCount);
    talk.push(mailCount);
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
    // メールから推測した候補を「まず…から」と名指ししない（広告や通知が先頭に来ることがある）。
    // 名指すのは本人が TODO と確かめたものだけ。
    const confirmed = items.filter((i) => i.confirmed);
    const candidates = items.length - confirmed.length;
    // 候補は前回の Work 同期から来る。いまメールを 1 件も読めていないなら、そう言う
    // （「メールから30件」と「メールを取得できませんでした」が並んでいた、2026-10-19）。
    const mailUnread = mail.status === 'stale' && !mail.fetched_at;
    const from = mailUnread ? '前回同期したメール' : 'メール';
    summary.attention = confirmed.length
      ? `TODOが${confirmed.length}件、まず「${confirmed[0]!.title.slice(0, 40)}」から。${candidates ? `${from}からの候補も${candidates}件あります。` : ''}`
      : candidates
        ? mailUnread
          ? `${from}からTODOの候補が${candidates}件あります。いまはメールを読めていません。`
          : `メールからTODOの候補が${candidates}件見つかっています。下で確かめられます。`
        : '急いで対応が要るものは見つかっていません。';
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

  // ---- ニュース（主要・国際の大きな出来事 + 本人が決めた話題。同じ出来事は 1 件に） ----
  // 関心に合う記事だけで閉じないよう、主要と国際の枠は話題があっても残す。
  try {
    const feeds: { label: string; topic: string | null; feed?: 'top' | 'world' }[] = [
      // NHK の主要ニュースには海外の出来事も入る。「国内」とは呼ばず「主要」、国際の枠と重なれば「国際」。
      { label: '主要', topic: null, feed: 'top' },
      { label: '国際', topic: null, feed: 'world' },
      ...args.interests.map((topic) => ({ label: topic, topic })),
    ];
    const perFeed = args.interests.length ? 2 : 3;
    const stories: { line: BriefLine; title: string; label: string; outlets: Set<string> }[] = [];
    const sources: { name: string; url: string }[] = [];
    let fetchedAt: string | null = null;
    let failures = 0;
    for (const feed of feeds) {
      try {
        const news = await lookupNews(
          { topic: feed.topic, ...(feed.feed ? { feed: feed.feed } : {}) },
          deps.get,
          now,
        );
        if (news.kind !== 'news' || !news.data || news.data.items.length === 0) {
          failures += 1;
          continue;
        }
        fetchedAt = news.fetched_at;
        for (const s of news.sources)
          if (!sources.some((x) => x.name === s.name)) sources.push({ ...s });
        let added = 0;
        for (const item of news.data.items) {
          if (added >= perFeed) break;
          const outlet = item.source ?? news.sources[0]?.name ?? '';
          const same = stories.find((story) => sameStory(story.title, item.title));
          if (same) {
            if (outlet) same.outlets.add(outlet);
            if (feed.feed === 'world' && same.label === '主要') same.label = '国際';
            continue;
          }
          // 見出しは記事の題だけ。枠（主要・国際・話題）と媒体は副題へ。
          stories.push({
            title: item.title,
            label: feed.label,
            outlets: new Set(outlet ? [outlet] : []),
            line: { text: item.title, url: item.url },
          });
          added += 1;
        }
      } catch {
        failures += 1;
      }
    }
    if (failures === feeds.length) throw new Error('ニュースを取得できませんでした');
    sections.push({
      id: 'news',
      title: 'ニュース',
      status: failures ? 'stale' : 'ok',
      ...(failures
        ? {
            reason: `${feeds.length}件の枠のうち${failures}件を取得できませんでした。取得できた記事を表示しています。`,
          }
        : {}),
      fetched_at: fetchedAt,
      sources,
      lines: stories.slice(0, 8).map(({ line, label, outlets }) => {
        const names = [...outlets];
        const outlet = names.length > 1 ? `${names[0]} ほか${names.length - 1}媒体` : names[0];
        return { ...line, subtitle: outlet ? `${label} · ${outlet}` : label };
      }),
    });
  } catch {
    sections.push({
      id: 'news',
      title: 'ニュース',
      status: 'stale',
      reason: 'ニュースを取得できませんでした',
      fetched_at: null,
      sources: [],
      lines: [],
    });
  }

  // ---- 株価・指数（ニュース見出しから価格を推測しない） ----
  sections.push(await lookupMarkets(args.watchlist ?? DEFAULT_WATCHLIST, deps.get, now, timeZone));

  const stale = sections.filter((s) => s.status === 'stale').map((s) => s.title);
  if (stale.length) {
    spoken.push(`${stale.join('・')}は一部または全部を取得できず、未更新の情報があります。`);
    talk.push(`${stale.join('・')}は一部または全部を取得できず、未更新の情報があります。`);
  }
  const news = sections.find((s) => s.id === 'news');
  if (news?.status === 'ok' && news.lines.length)
    talk.push(`ニュースは${news.lines.length}件を画面に出しています。`);
  const markets = sections.find((s) => s.id === 'markets');
  if (markets?.status === 'ok' && markets.lines.length)
    talk.push(`市況・株価情報は画面に出しています。`);
  return {
    schema: BRIEF_SCHEMA,
    date: args.date,
    generated_at: at(),
    text: spoken.join(''),
    talk: talk.join(''),
    highlights: highlights.slice(0, 4),
    summary: [summary.schedule, summary.attention, summary.rain ?? summary.weather].filter(
      (sentence): sentence is string => Boolean(sentence),
    ),
    sections,
  };
}
