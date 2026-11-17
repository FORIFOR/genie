import { describe, expect, it } from 'vitest';
import { BriefEnvelope, BriefArgs as BriefArgsSchema, type BriefArgs } from '@genie/contracts';
import type { ConnectorRuntime } from '../src/connector-steps.js';
import { sameStory } from '../src/current-info/news.js';
import { composeBrief, rainAdvice } from '../src/brief/compose.js';
import { BriefRuntime } from '../src/brief/runtime.js';

const NOW = new Date('2026-10-06T00:30:00Z'); // 09:30 JST
const DAILY = JSON.stringify({
  daily: {
    time: ['2026-10-06'],
    weather_code: [61],
    temperature_2m_max: [22],
    temperature_2m_min: [16],
    precipitation_probability_max: [80],
  },
  current: { temperature_2m: 18, weather_code: 61 },
});
// 14 時台だけ雨（70%）、ほかは 10%
const HOURLY = JSON.stringify({
  hourly: {
    time: Array.from({ length: 24 }, (_, h) => `2026-10-06T${String(h).padStart(2, '0')}:00`),
    precipitation_probability: Array.from({ length: 24 }, (_, h) => (h === 14 ? 70 : 10)),
  },
});
const RSS = (titles: string[]) =>
  `<rss><channel>${titles.map((t, i) => `<item><title>${t}</title><link>https://example.com/${i}</link><pubDate>Mon, 06 Oct 2026 00:00:00 GMT</pubDate></item>`).join('')}</channel></rss>`;

function fakeGet(fail: { news?: boolean; weather?: boolean } = {}) {
  const urls: string[] = [];
  const get = async (url: string) => {
    urls.push(url);
    if (url.includes('open-meteo.com/v1/forecast')) {
      if (fail.weather) throw new Error('timeout');
      return url.includes('hourly=') ? HOURLY : DAILY;
    }
    if (url.includes('geocoding')) return JSON.stringify({ results: [] });
    if (fail.news) throw new Error('timeout');
    if (url.includes('cat6.xml')) return RSS(['海外の出来事A', '海外の出来事B', '海外の出来事C']);
    const topic = url.includes('news.google.com') ? new URL(url).searchParams.get('q') : null;
    return RSS(
      ['見出しA', '見出しB', '見出しC', '見出しD'].map((t) => (topic ? `${topic}の${t}` : t)),
    );
  };
  return { get, urls };
}

const args = (over: Partial<BriefArgs> = {}): BriefArgs => ({
  date: '2026-10-06',
  calendar: {
    status: 'granted',
    fetched_at: '2026-10-06T00:29:00Z',
    events: [
      { title: '定例', start: '2026-10-06T01:00:00+09:00', end: '2026-10-06T01:30:00+09:00' }, // 終わっている
      {
        title: 'A社訪問',
        start: '2026-10-06T14:00:00+09:00',
        end: '2026-10-06T15:00:00+09:00',
        location: '品川',
      },
      {
        title: '設計レビュー',
        start: '2026-10-06T10:00:00+09:00',
        end: '2026-10-06T11:00:00+09:00',
      },
    ],
  },
  attention: {
    status: 'ok',
    fetched_at: '2026-10-06T00:20:00Z',
    items: [{ title: '見積りの数量変更', from: 'A社 田中', ref: 'work:1' }],
  },
  interests: [],
  watchlist: [],
  ...over,
});

describe('morning brief (read-only, rules only)', () => {
  it('lists today, flags rain during a planned visit, and counts what needs attention', async () => {
    const { get } = fakeGet();
    const brief = BriefEnvelope.parse(
      await composeBrief(args(), { get, region: '東京都', now: () => NOW }),
    );
    const section = (id: string) => brief.sections.find((s) => s.id === id)!;
    expect(section('calendar').lines.map((l) => l.text)).toEqual([
      '01:00–01:30 定例',
      '10:00–11:00 設計レビュー',
      '14:00–15:00 A社訪問（品川）',
    ]);
    expect(section('weather').lines.map((l) => l.text)).toContain(
      '14:00「A社訪問」の時間に雨の可能性（東京都 70%）',
    );
    expect(
      section('weather').lines.some((l) => l.text.includes('設計レビュー')),
      '10 時台は 10% なので言わない',
    ).toBe(false);
    expect(brief.highlights[0]).toBe('14:00「A社訪問」の時間に雨の可能性（東京都 70%）');
    expect(brief.highlights).toContain('次の予定: 10:00 設計レビュー');
    expect(brief.text).toBe(
      '今日の予定は3件、次は10:00の「設計レビュー」です。14:00の「A社訪問」の時間は雨の可能性があります（70%）。対応が要るものが1件あります。',
    );
    expect(brief.summary).toEqual([
      '今日は予定が3件、次は10:00の「設計レビュー」です。',
      'メールからTODOの候補が1件見つかっています。下で確かめられます。',
      '14時台に雨の可能性（最大70%）。外出には傘を。',
    ]);
    expect(BriefEnvelope.parse(brief).summary).toHaveLength(3);
    // 名指すのは本人が TODO と確かめたものだけ（推測の候補が広告でも冒頭に出さない）。
    const confirmed = await composeBrief(
      args({
        attention: {
          status: 'ok',
          fetched_at: '2026-10-06T00:20:00Z',
          items: [
            { title: '【必見】キャンペーンのお知らせ', ref: 'work:2' },
            { title: '見積りの数量変更', ref: 'work:1', confirmed: true },
          ],
        },
      }),
      { get, region: '東京都', now: () => NOW },
    );
    expect(confirmed.summary[1]).toBe(
      'TODOが1件、まず「見積りの数量変更」から。メールからの候補も1件あります。',
    );
    expect(confirmed.summary.join('')).not.toContain('キャンペーン');
    // 会話へ渡す文には、予定の題名・相手・件名を入れない
    expect(brief.talk).toBe(
      '今日の予定は3件、次は10:00からです。14:00からの予定の時間は雨の可能性があります（70%）。東京都の天気は雨、最高22度、最低16度、降水確率80%です。対応が要るものが1件あります。ニュースは6件を画面に出しています。',
    );
    for (const secret of ['設計レビュー', 'A社', '見積り', '田中', '品川', '見出し'])
      expect(brief.talk).not.toContain(secret);
    expect(section('attention').lines).toEqual([
      { text: '見積りの数量変更（A社 田中）', ref: 'work:1' },
    ]);
    expect(section('news').lines).toHaveLength(6); // 主要 3 + 国際 3
    expect(section('markets')).toMatchObject({ status: 'none' });
    for (const s of brief.sections.filter((s) => s.status === 'ok'))
      expect(s.fetched_at, s.id).not.toBeNull();
  });

  it('says "未更新" for a source that failed instead of pretending nothing changed', async () => {
    const { get } = fakeGet({ news: true, weather: true });
    const brief = await composeBrief(args(), { get, region: '東京都', now: () => NOW });
    expect(brief.sections.find((s) => s.id === 'weather')).toMatchObject({
      status: 'stale',
      lines: [],
    });
    expect(brief.sections.find((s) => s.id === 'news')).toMatchObject({
      status: 'stale',
      lines: [],
    });
    expect(brief.text).toContain(
      '天気・ニュースは一部または全部を取得できず、未更新の情報があります。',
    );
    expect(brief.highlights.some((h) => h.includes('雨'))).toBe(false);
  });

  it('does not read the calendar or mail it was not given', async () => {
    const { get } = fakeGet();
    const brief = await composeBrief(
      args({
        calendar: { status: 'denied', events: [], fetched_at: '2026-10-06T00:29:00Z' },
        attention: { status: 'none', items: [] },
      }),
      { get, region: '東京都', now: () => NOW },
    );
    expect(brief.sections.find((s) => s.id === 'calendar')).toMatchObject({
      status: 'none',
      reason: 'カレンダーの許可がありません',
    });
    expect(brief.sections.find((s) => s.id === 'attention')).toMatchObject({ status: 'none' });
    expect(brief.text).not.toContain('予定');
  });

  /** 「今日の予定は？」が Google カレンダーを読まずに「予定はありません」と答えていた（2026-10-19）。 */
  it('adds today from the connected Google Calendar, once, and only today', async () => {
    const { get } = fakeGet();
    const asked: { timeMin: string; timeMax: string }[] = [];
    const brief = await composeBrief(
      args({ calendar: { status: 'denied', events: [], fetched_at: NOW.toISOString() } }),
      {
        get,
        region: '東京都',
        now: () => NOW,
        cloudCalendar: async (window, offset) => {
          asked.push(window);
          expect(offset).toBe('+09:00');
          return {
            source: 'Google カレンダー',
            events: [
              {
                title: '歯医者',
                start: '2026-10-06T16:00:00+09:00',
                end: '2026-10-06T17:00:00+09:00',
              },
              { title: '歯医者', start: '2026-10-06T07:00:00Z', end: '2026-10-06T08:00:00Z' },
              {
                title: '休み',
                start: '2026-10-06T00:00:00+09:00',
                end: '2026-10-07T00:00:00+09:00',
                allDay: true,
              },
              {
                title: '明日の会議',
                start: '2026-10-07T10:00:00+09:00',
                end: '2026-10-07T11:00:00+09:00',
              },
            ],
          };
        },
      },
    );
    expect(asked).toHaveLength(1);
    const calendar = brief.sections.find((s) => s.id === 'calendar');
    expect(calendar).toMatchObject({ status: 'ok', sources: [{ name: 'Google カレンダー' }] });
    expect(calendar?.lines.map((l) => l.text)).toEqual(['終日 休み', '16:00–17:00 歯医者']);
  });

  it('keeps the Mac calendar when Google Calendar cannot be read', async () => {
    const { get } = fakeGet();
    const brief = await composeBrief(args(), {
      get,
      region: '東京都',
      now: () => NOW,
      cloudCalendar: async () => {
        throw new Error('token_expired');
      },
    });
    const calendar = brief.sections.find((s) => s.id === 'calendar');
    expect(calendar).toMatchObject({ status: 'ok', sources: [{ name: 'このMacのカレンダー' }] });
    expect(calendar?.lines).toHaveLength(3);
  });

  it('does not call a cut Google Calendar empty or unauthorized', async () => {
    const cut = async () => ({ events: [], source: 'Google カレンダー', reconnect: true });
    const denied = await composeBrief(
      args({ calendar: { status: 'denied', events: [], fetched_at: NOW.toISOString() } }),
      { get: fakeGet().get, region: '東京都', now: () => NOW, cloudCalendar: cut },
    );
    const section = denied.sections.find((s) => s.id === 'calendar');
    expect(section).toMatchObject({ status: 'stale', sources: [] });
    expect(section?.reason).toContain('Google カレンダーの接続の期限が切れました');
    expect(section?.reason).not.toContain('許可がありません');
    const empty = await composeBrief(
      args({ calendar: { status: 'granted', events: [], fetched_at: NOW.toISOString() } }),
      { get: fakeGet().get, region: '東京都', now: () => NOW, cloudCalendar: cut },
    );
    expect(empty.sections.find((s) => s.id === 'calendar')).toMatchObject({
      status: 'stale',
      sources: [{ name: 'このMacのカレンダー' }],
    });
    expect(JSON.stringify(empty)).toContain('今日の予定を確かめられません');
    expect(JSON.stringify(empty)).not.toContain('今日は予定が入っていません');
  });

  it('uses the topics the person chose and drops duplicate headlines', async () => {
    const { get, urls } = fakeGet();
    const brief = await composeBrief(args({ interests: ['半導体', '為替'] }), {
      get,
      region: '東京都',
      now: () => NOW,
    });
    expect(
      urls.filter((u) => u.includes('news.google.com')).map((u) => decodeURIComponent(u)),
    ).toEqual([expect.stringContaining('q=半導体'), expect.stringContaining('q=為替')]);
    expect(
      brief.sections
        .find((s) => s.id === 'news')!
        .lines.map((l) => [l.text, l.subtitle?.split(' · ')[0]]),
    ).toEqual([
      ['見出しA', '主要'],
      ['見出しB', '主要'],
      ['海外の出来事A', '国際'],
      ['海外の出来事B', '国際'],
      ['半導体の見出しA', '半導体'],
      ['半導体の見出しB', '半導体'],
      ['為替の見出しA', '為替'],
      ['為替の見出しB', '為替'],
    ]);
  });

  it('keeps successful topic articles but marks failed or empty topics stale', async () => {
    for (const failure of ['transport', 'empty'] as const) {
      const fallback = fakeGet().get;
      const get = async (url: string) => {
        if (new URL(url).searchParams.get('q') === '文化') {
          if (failure === 'transport') throw new Error('PRIVATE_PROVIDER_RESPONSE');
          return RSS([]);
        }
        return fallback(url);
      };
      const brief = BriefEnvelope.parse(
        await composeBrief(args({ interests: ['科学', '文化'] }), {
          get,
          region: '東京都',
          now: () => NOW,
        }),
      );
      const news = brief.sections.find((section) => section.id === 'news')!;
      expect(news).toMatchObject({ status: 'stale', fetched_at: NOW.toISOString() });
      expect(news.sources.map((source) => source.name)).toEqual(['NHK', 'Google ニュース']);
      expect(news.lines.map((line) => [line.text, line.subtitle?.split(' · ')[0]])).toContainEqual([
        '科学の見出しA',
        '科学',
      ]);
      expect(news.lines.some((line) => line.subtitle?.startsWith('文化'))).toBe(false);
      expect(news.reason).toContain('4件の枠のうち1件');
      expect(brief.talk).toContain('ニュースは一部または全部を取得できず');
      expect(JSON.stringify(brief)).not.toContain('PRIVATE_PROVIDER_RESPONSE');
      expect(brief.sections.find((section) => section.id === 'weather')?.status).toBe('ok');
    }
  });

  it('treats entirely empty or failed news topics as unavailable without a success timestamp', async () => {
    const fallback = fakeGet().get;
    const get = async (url: string) => {
      const topic = new URL(url).searchParams.get('q');
      if (topic === '文化') throw new Error('PRIVATE_PROVIDER_RESPONSE');
      if (topic === '科学' || url.includes('news.web.nhk')) return RSS([]);
      return fallback(url);
    };
    const brief = BriefEnvelope.parse(
      await composeBrief(args({ interests: ['科学', '文化'] }), {
        get,
        region: '東京都',
        now: () => NOW,
      }),
    );
    expect(brief.sections.find((section) => section.id === 'news')).toMatchObject({
      status: 'stale',
      fetched_at: null,
      sources: [],
      lines: [],
      reason: 'ニュースを取得できませんでした',
    });
    expect(brief.talk).not.toContain('ニュースは0件');
    expect(JSON.stringify(brief)).not.toContain('PRIVATE_PROVIDER_RESPONSE');
  });

  it('uses provider prices instead of repackaging market news as stock quotes', async () => {
    const urls: string[] = [];
    const get = async (url: string) => {
      urls.push(url);
      if (url.includes('open-meteo.com/v1/forecast')) return DAILY;
      if (url.includes('geocoding')) return JSON.stringify({ results: [] });
      if (url.includes('query1.finance.yahoo.com'))
        return JSON.stringify({
          chart: {
            error: null,
            result: [
              {
                meta: {
                  symbol: '7203.T',
                  shortName: 'Synthetic Motor',
                  currency: 'JPY',
                  regularMarketPrice: 2500,
                  regularMarketTime: Math.floor(NOW.getTime() / 1000),
                  instrumentType: 'EQUITY',
                },
              },
            ],
          },
        });
      return RSS(['日経平均株価が反発', '為替は円安水準で推移', '通常ニュース']);
    };
    const brief = await composeBrief(args({ interests: ['株価', '為替'], watchlist: ['7203.T'] }), {
      get,
      region: '東京都',
      now: () => NOW,
    });
    const markets = brief.sections.find((s) => s.id === 'markets');
    expect(markets).toBeDefined();
    expect(markets?.status).toBe('ok');
    expect(markets?.lines[0]?.text).toContain('2,500');
    expect(markets?.lines[0]?.text).toContain('JPY');
    expect(markets?.lines.some((line) => line.text.includes('日経平均株価が反発'))).toBe(false);
    expect(brief.talk).toContain('市況・株価情報は画面に出しています。');
  });

  it('accepts bounded settings while preserving old callers and applies the requested region', async () => {
    const legacy = args();
    delete legacy.watchlist;
    expect(BriefArgsSchema.parse(legacy)).not.toHaveProperty('watchlist');
    for (const invalid of [
      { region: ' ' },
      { region: 'x'.repeat(81) },
      { watchlist: [' '] },
      { watchlist: ['x'.repeat(21)] },
      { watchlist: Array(9).fill('ABC') },
    ])
      expect(BriefArgsSchema.safeParse({ ...args(), ...invalid }).success).toBe(false);
    const { get, urls } = fakeGet();
    const brief = await composeBrief(
      args({
        region: '大阪府',
        calendar: { status: 'denied', events: [], fetched_at: NOW.toISOString() },
      }),
      { get, region: '東京都', now: () => NOW },
    );
    expect(brief.sections.find((section) => section.id === 'weather')?.lines[0]?.text).toContain(
      '大阪府',
    );
    expect(urls.find((url) => url.includes('forecast'))).toContain('latitude=34.69');
  });

  it('reads the existing mailbox during composition and keeps private metadata out of talk', async () => {
    const { get } = fakeGet();
    let reads = 0;
    const connectors = {
      connected: async (key: string) => key === 'gmail',
      granted: () => ['email.read'],
      gmail: () => ({
        list: async (query: { query: string }) => {
          reads++;
          return query.query.includes('(is:starred OR')
            ? [
                {
                  id: 'mail-one',
                  threadId: 'thread-one',
                  subject: 'PRIVATE_SUBJECT',
                  from: 'PRIVATE_SENDER <person@example.invalid>',
                  receivedAt: '2026-10-05T23:00:00Z',
                  snippet: 'PRIVATE_SNIPPET',
                  unread: true,
                  labels: ['IMPORTANT'],
                },
              ]
            : [];
        },
      }),
    } as unknown as ConnectorRuntime;
    const runtime = new BriefRuntime({ get, region: () => '東京都', now: () => NOW, connectors });
    const outcome = await runtime.run({
      id: 's',
      toolId: 'brief.compose',
      args: args() as unknown as Record<string, unknown>,
      approval: null,
    });
    const artifact = (outcome.result as { artifact: { markdown: string } }).artifact;
    const brief = BriefEnvelope.parse(JSON.parse(artifact.markdown));
    expect(reads).toBe(2);
    expect(brief.sections.find((section) => section.id === 'mail')).toMatchObject({
      status: 'ok',
      lines: [
        {
          text: expect.stringContaining('PRIVATE_SUBJECT'),
          ref: 'gmail:mail-one',
          received_at: '2026-10-05T23:00:00.000Z',
        },
      ],
    });
    expect(brief.talk).toContain('主要メールは1件');
    expect(brief.talk).not.toMatch(/PRIVATE_|person@example/);
    expect(artifact.markdown).not.toContain('PRIVATE_SNIPPET');
  });

  it('validates location results without breaking callers that omit location', () => {
    expect(BriefArgsSchema.parse(args())).not.toHaveProperty('weather_location');
    for (const invalid of [
      { status: 'ok' },
      { status: 'ok', latitude: 35 },
      { status: 'ok', longitude: 139 },
      { status: 'ok', latitude: 91, longitude: 139 },
      { status: 'ok', latitude: 35, longitude: -181 },
      { status: 'ok', latitude: Number.NaN, longitude: 139 },
      { status: 'ok', latitude: 35, longitude: Number.POSITIVE_INFINITY },
      { status: 'none', reason: 'x'.repeat(121) },
      { status: 'unknown' },
    ])
      expect(BriefArgsSchema.safeParse({ ...args(), weather_location: invalid }).success).toBe(
        false,
      );
    for (const location of [
      { status: 'none' },
      { status: 'stale' },
      { status: 'ok', latitude: -90, longitude: 180 },
    ])
      expect(BriefArgsSchema.safeParse({ ...args(), weather_location: location }).success).toBe(
        true,
      );
  });

  it.each(['none', 'stale'] as const)(
    'keeps location %s without requesting a fallback forecast',
    async (status) => {
      const { get, urls } = fakeGet();
      const brief = await composeBrief(
        args({
          region: '大阪府',
          weather_location: {
            status,
            reason: 'Synthetic location state',
            latitude: 35,
            longitude: 139,
          },
        }),
        { get, region: '東京都', now: () => NOW },
      );
      expect(brief.sections.find((section) => section.id === 'weather')).toMatchObject({
        status,
        reason: 'Synthetic location state',
        fetched_at: null,
        lines: [],
        sources: [],
      });
      expect(urls.some((url) => url.includes('open-meteo'))).toBe(false);
      expect(brief.sections.find((section) => section.id === 'news')?.status).toBe('ok');
      expect(brief.talk).not.toMatch(/大阪府|東京都|Synthetic location state/);
    },
  );

  it('uses rounded current coordinates for daily and hourly rain without sending event locations', async () => {
    const { get, urls } = fakeGet();
    const brief = await composeBrief(
      args({
        region: '大阪府',
        weather_location: { status: 'ok', latitude: 35.678912, longitude: 139.765432 },
      }),
      { get, region: '東京都', now: () => NOW },
    );
    const weather = brief.sections.find((section) => section.id === 'weather')!;
    expect(weather.status).toBe('ok');
    expect(weather.lines[0]?.text).toContain('現在地付近');
    expect(weather.lines.some((line) => line.text.includes('現在地付近 70%'))).toBe(true);
    const forecasts = urls.filter((url) => url.includes('open-meteo'));
    expect(forecasts).toHaveLength(2);
    for (const raw of forecasts) {
      const query = new URL(raw).searchParams;
      expect(query.get('latitude')).toBe('35.68');
      expect(query.get('longitude')).toBe('139.77');
    }
    expect(urls.some((url) => url.includes('geocoding'))).toBe(false);
    expect(JSON.stringify(urls)).not.toMatch(/35\.678912|139\.765432|品川/);
    expect(brief.talk).not.toMatch(/35\.68|139\.77|品川|A社/);
  });

  it('keeps other sources and successful mail rows when the mail read is partial', async () => {
    const { get } = fakeGet();
    const brief = await composeBrief(args(), {
      get,
      region: '東京都',
      now: () => NOW,
      mail: async () => ({
        id: 'mail',
        title: '主要メール',
        status: 'stale',
        reason: '一部を取得できませんでした',
        fetched_at: NOW.toISOString(),
        sources: [],
        lines: [{ text: 'Synthetic retained mail' }],
      }),
    });
    expect(brief.sections.find((section) => section.id === 'mail')?.lines).toHaveLength(1);
    expect(brief.sections.find((section) => section.id === 'weather')?.status).toBe('ok');
    expect(brief.talk).toContain('未更新の情報');
  });

  it('does not count mail candidates as fresh when no mail could be read', async () => {
    const { get } = fakeGet();
    const brief = await composeBrief(args(), {
      get,
      region: '東京都',
      now: () => NOW,
      mail: async () => ({
        id: 'mail',
        title: '主要メール',
        status: 'stale',
        reason: 'Gmailの接続の期限が切れました。Apps の「つなぎ直す」から許可し直してください。',
        fetched_at: null,
        sources: [],
        lines: [],
      }),
    });
    expect(brief.summary).toContain(
      '前回同期したメールからTODOの候補が1件あります。いまはメールを読めていません。',
    );
    expect(brief.summary.join('')).not.toContain('見つかっています');
  });

  it.each(['2026-10-05', '2026-10-07'])(
    'marks weather stale when the response contains %s instead of the brief date',
    async (providerDate) => {
      const { get, urls } = fakeGet();
      const brief = await composeBrief(
        args({
          calendar: { status: 'denied', events: [], fetched_at: NOW.toISOString() },
          weather_location: { status: 'ok', latitude: 34.05, longitude: -118.24 },
        }),
        {
          get: async (url) =>
            url.includes('open-meteo') ? DAILY.replaceAll('2026-10-06', providerDate) : get(url),
          region: '東京都',
          now: () => NOW,
        },
      );
      expect(brief.sections.find((section) => section.id === 'weather')).toMatchObject({
        status: 'stale',
        fetched_at: null,
        lines: [],
        reason: '対象日の天気予報を取得できませんでした。',
      });
      expect(brief.sections.find((section) => section.id === 'news')?.status).toBe('ok');
      expect(brief.talk).not.toMatch(/最高22|最低16|降水確率80/);
      expect(urls.some((url) => url.includes('geocoding'))).toBe(false);
    },
  );

  it('runs as the brief.compose step and returns the envelope as the artifact', async () => {
    const { get } = fakeGet();
    const runtime = new BriefRuntime({ get, region: () => '東京都', now: () => NOW });
    expect(runtime.handles('brief.compose')).toBe(true);
    const outcome = await runtime.run({
      id: 's',
      toolId: 'brief.compose',
      args: args() as unknown as Record<string, unknown>,
      approval: null,
    });
    const artifact = (outcome.result as { artifact: { title: string; markdown: string } }).artifact;
    expect(artifact.title).toBe('今日のまとめ');
    expect(BriefEnvelope.parse(JSON.parse(artifact.markdown)).schema).toBe('genie.brief/v1');
    expect(
      (await runtime.run({ id: 's', toolId: 'brief.compose', args: { date: 'x' }, approval: null }))
        .error?.code,
    ).toBe('brief.invalid_args');
  });

  it('merges the same story from different outlets into one line and names the outlets', async () => {
    const get = async (url: string) => {
      if (url.includes('open-meteo.com/v1/forecast'))
        return url.includes('hourly=') ? HOURLY : DAILY;
      if (url.includes('geocoding')) return JSON.stringify({ results: [] });
      if (url.includes('cat6.xml')) return RSS(['米大統領、関税引き上げを発表']);
      if (url.includes('news.web.nhk'))
        return RSS(['熊本地震以来約2か月半ぶり JR鹿児島本線 宇土～八代 運行再開']);
      return `<rss><channel><item><title>米大統領が関税の引き上げを発表 - 日経</title><link>https://example.com/n</link><source>日経</source></item><item><title>JR鹿児島本線 宇土～八代 約2か月半ぶりに運行再開 - 西日本新聞</title><link>https://example.com/w</link><source>西日本新聞</source></item><item><title>まったく別の話題 - 共同</title><link>https://example.com/k</link><source>共同</source></item></channel></rss>`;
    };
    const brief = await composeBrief(args({ interests: ['経済'] }), {
      get,
      region: '東京都',
      now: () => NOW,
    });
    const news = brief.sections.find((s) => s.id === 'news')!;
    expect(news.lines.map((l) => [l.text, l.subtitle])).toEqual([
      ['熊本地震以来約2か月半ぶり JR鹿児島本線 宇土～八代 運行再開', '主要 · NHK ほか1媒体'],
      ['米大統領、関税引き上げを発表', '国際 · NHK ほか1媒体'],
      ['まったく別の話題', '経済 · 共同'],
    ]);
    expect(sameStory('第1試合 日本が勝利し決勝へ進出', '第2試合 日本が勝利し決勝へ進出')).toBe(
      false,
    );
    expect(sameStory('台風10号が接近', '台風11号が接近')).toBe(false);
  });

  it('adds one rule-based rain line for the rest of today, with advice only when it is likely', () => {
    const hourly = (probs: Record<number, number>) => ({
      place: '東京都',
      byHour: new Map(
        Array.from(
          { length: 24 },
          (_, h) => [`2026-10-06T${String(h).padStart(2, '0')}`, probs[h] ?? 10] as const,
        ),
      ),
    });
    const morning = new Date('2026-10-05T23:30:00Z'); // 08:30 JST
    expect(rainAdvice(hourly({ 15: 60, 16: 70, 17: 55 }), morning, 'Asia/Tokyo')).toBe(
      '15〜18時に雨の可能性（最大70%）。外出には傘を。',
    );
    expect(rainAdvice(hourly({ 14: 70 }), morning, 'Asia/Tokyo')).toBe(
      '14時台に雨の可能性（最大70%）。外出には傘を。',
    );
    expect(rainAdvice(hourly({}), morning, 'Asia/Tokyo')).toBe(
      '8時以降は雨の心配は少なめ（最大10%）。',
    );
    expect(rainAdvice(hourly({ 12: 40 }), morning, 'Asia/Tokyo')).toBe(
      '8時以降、にわか雨に注意（最大40%）。',
    );
    // 過ぎた時間の雨は言わない
    expect(rainAdvice(hourly({ 7: 90 }), morning, 'Asia/Tokyo')).toBe(
      '8時以降は雨の心配は少なめ（最大10%）。',
    );
    expect(rainAdvice(hourly({}), new Date('2026-10-06T13:30:00Z'), 'Asia/Tokyo')).toBeNull(); // 22:30
  });

  it('labels a main-feed story as world news when the world feed carries it too', async () => {
    const get = async (url: string) => {
      if (url.includes('open-meteo.com/v1/forecast'))
        return url.includes('hourly=') ? HOURLY : DAILY;
      if (url.includes('geocoding')) return JSON.stringify({ results: [] });
      if (url.includes('cat6.xml')) return RSS(['ネパールで土石流が発生 軍が救助活動']);
      return RSS(['ネパールで土石流が発生 軍が救助活動', '国会で補正予算が成立']);
    };
    const brief = await composeBrief(args(), { get, region: '東京都', now: () => NOW });
    expect(
      brief.sections.find((s) => s.id === 'news')!.lines.map((l) => [l.text, l.subtitle]),
    ).toEqual([
      ['ネパールで土石流が発生 軍が救助活動', '国際 · NHK'],
      ['国会で補正予算が成立', '主要 · NHK'],
    ]);
  });

  it('still says something useful at the top without a calendar or Work', async () => {
    const { get } = fakeGet();
    const brief = await composeBrief(
      args({
        calendar: { status: 'denied', events: [], fetched_at: NOW.toISOString() },
        attention: { status: 'none', items: [] },
      }),
      { get, region: '東京都', now: () => NOW },
    );
    expect(brief.summary).toEqual(['14時台に雨の可能性（最大70%）。外出には傘を。']);
    const dry = await composeBrief(
      args({
        calendar: { status: 'denied', events: [], fetched_at: NOW.toISOString() },
        attention: { status: 'none', items: [] },
      }),
      {
        get: async (url: string) =>
          url.includes('hourly=')
            ? JSON.stringify({
                hourly: { time: ['2026-10-06T12:00'], precipitation_probability: [0] },
              })
            : get(url),
        region: '東京都',
        now: () => NOW,
      },
    );
    expect(dry.summary).toEqual(['東京都は雨、最高22度の予報です。']);
  });
});
