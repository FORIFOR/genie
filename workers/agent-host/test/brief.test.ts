import { describe, expect, it } from 'vitest';
import { BriefEnvelope, type BriefArgs } from '@genie/contracts';
import { composeBrief } from '../src/brief/compose.js';
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
    return RSS(['見出しA', '見出しB', '見出しC', '見出しD']);
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
    // 会話へ渡す文には、予定の題名・相手・件名を入れない
    expect(brief.talk).toBe(
      '今日の予定は3件、次は10:00からです。14:00からの予定の時間は雨の可能性があります（70%）。東京都の天気は雨、最高22度、最低16度、降水確率80%です。対応が要るものが1件あります。ニュースは3件を画面に出しています。',
    );
    for (const secret of ['設計レビュー', 'A社', '見積り', '田中', '品川', '見出し'])
      expect(brief.talk).not.toContain(secret);
    expect(section('attention').lines).toEqual([
      { text: '見積りの数量変更（A社 田中）', ref: 'work:1' },
    ]);
    expect(section('news').lines).toHaveLength(3);
    expect(section('markets')).toMatchObject({
      status: 'none',
      reason: expect.stringContaining('未設定'),
    });
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
    expect(brief.text).toContain('天気・ニュースは取得できず、未更新です。');
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
    expect(brief.sections.find((s) => s.id === 'news')!.lines.map((l) => l.text)).toEqual([
      '［半導体］見出しA',
      '［半導体］見出しB',
      '［半導体］見出しC',
    ]);
  });

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
});
