/**
 * いまの情報は、取得した値だけで答える。取れなければ失敗と言う。一覧に無い所へは出ない。
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CURRENT_INFO_HOSTS, infoFetch, type InfoFetch } from '../src/current-info/hosts.js';
import { parseRss } from '../src/current-info/news.js';
import { knownPlace } from '../src/current-info/places.js';
import { defaultRegion } from '../src/current-info/preferences.js';
import { CurrentInfoRunner } from '../src/current-info/runner.js';
import { selectDays } from '../src/current-info/weather.js';

const FORECAST = JSON.stringify({
  current: { temperature_2m: 17.7, weather_code: 3 },
  daily: {
    time: ['2026-09-26', '2026-09-27', '2026-09-28', '2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02', '2026-10-03'],
    weather_code: [3, 63, 81, 0, 1, 2, 61, 71],
    temperature_2m_max: [21.7, 22.0, 22.7, 25, 24, 23, 20, 5],
    temperature_2m_min: [17.6, 19.5, 19.3, 15, 14, 13, 12, -1],
    precipitation_probability_max: [20, 80, 60, 0, 10, 20, 70, 90],
  },
});

const NHK = `<?xml version="1.0"?><rss><channel><title>NHK</title>
<item><title>見出し一</title><link>https://news.web.nhk/newsweb/na/1</link><pubDate>Sat, 26 Sep 2026 14:00:00 +0900</pubDate></item>
<item><title><![CDATA[見出し &amp; 二]]></title><link>https://news.web.nhk/newsweb/na/2</link></item>
<item><title>危ないリンク</title><link>javascript:alert(1)</link></item>
</channel></rss>`;

const GOOGLE = `<rss><channel>
<item><title>AI の話 - 日経</title><link>https://news.google.com/rss/articles/a</link><source url="https://nikkei.com">日経</source></item>
</channel></rss>`;

function fake(routes: Record<string, string>): { fetch: InfoFetch; urls: string[] } {
  const urls: string[] = [];
  return {
    urls,
    fetch: async (url) => {
      urls.push(url);
      const host = new URL(url).hostname;
      const body = routes[host];
      if (body === undefined) throw new Error(`unexpected ${host}`);
      return body;
    },
  };
}

const step = (args: Record<string, unknown>) => ({ id: 's1', toolId: 'info.lookup', args, approval: null });
const now = () => new Date('2026-09-26T15:00:00Z');

function envelope(outcome: { ok: boolean; result?: unknown }) {
  expect(outcome.ok).toBe(true);
  const result = outcome.result as { artifact: { markdown: string } };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the test reads the JSON the app will decode
  return JSON.parse(result.artifact.markdown) as { schema: string; kind: string; text: string; data: any; sources: { name: string }[] };
}

describe('info.lookup weather', () => {
  it("answers tomorrow's weather for the configured region from the forecast only", async () => {
    const { fetch, urls } = fake({ 'api.open-meteo.com': FORECAST });
    const runner = new CurrentInfoRunner({ fetch, region: () => '大阪府', now });
    const body = envelope(await runner.run(step({ kind: 'weather', when: 'tomorrow', question: '明日の天気教えて' })));
    expect(body).toMatchObject({ schema: 'genie.info/v1', kind: 'weather' });
    expect(body.data.place).toBe('大阪府');
    expect(body.data.days).toEqual([
      { date: '2026-09-27', label: '明日(日)', code: 63, summary: '雨', high: 22, low: 19.5, precipitation: 80 },
    ]);
    expect(body.text).toBe('明日の大阪府は雨。最高22℃、最低20℃、降水確率80%です。');
    expect(body.sources[0]?.name).toBe('Open-Meteo.com');
    // 既定の地域は同梱の表で引く。地名検索には送らない。
    expect(urls.every((u) => new URL(u).hostname === 'api.open-meteo.com')).toBe(true);
    expect(urls[0]).toContain('latitude=34.69');
  });

  it('adds the current temperature only when asked about today', async () => {
    const { fetch } = fake({ 'api.open-meteo.com': FORECAST });
    const body = envelope(await new CurrentInfoRunner({ fetch, region: () => '東京都', now }).run(step({ kind: 'weather', when: 'today' })));
    expect(body.data.current).toEqual({ temperature: 17.7, code: 3, summary: 'くもり' });
    expect(body.text).toContain('いまは18℃');
  });

  it('looks up a named place it does not ship, and says so when nothing matches', async () => {
    const found = fake({
      'geocoding-api.open-meteo.com': JSON.stringify({ results: [{ name: '函館市', latitude: 41.77, longitude: 140.73 }] }),
      'api.open-meteo.com': FORECAST,
    });
    const body = envelope(await new CurrentInfoRunner({ fetch: found.fetch, region: () => '東京都', now }).run(step({ kind: 'weather', when: 'today', place: '函館' })));
    expect(body.data.place).toBe('函館');
    expect(found.urls[0]).toContain('name=%E5%87%BD%E9%A4%A8');

    const missing = fake({ 'geocoding-api.open-meteo.com': '{}' });
    const none = envelope(await new CurrentInfoRunner({ fetch: missing.fetch, region: () => '東京都', now }).run(step({ kind: 'weather', when: 'today', place: 'ほげ' })));
    expect(none.data).toBeNull();
    expect(none.text).toContain('「ほげ」の場所が見つかりませんでした');
    expect(missing.urls).toHaveLength(3); // 日本で「ほげ」「ほげ市」、無ければ世界で「ほげ」
  });

  it('fails instead of guessing when the forecast cannot be fetched', async () => {
    const runner = new CurrentInfoRunner({ fetch: async () => { throw new Error('offline'); }, region: () => '東京都', now });
    expect(await runner.run(step({ kind: 'weather', when: 'today' }))).toEqual({
      ok: false,
      error: { code: 'info.unavailable', message: '天気予報を取得できませんでした。' },
    });
  });

  it('picks the asked days', () => {
    const dates = ['2026-09-26', '2026-09-27', '2026-09-28', '2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02', '2026-10-03'];
    // 2026-09-26 is a Saturday
    expect(selectDays('weekend', dates)).toEqual([0, 1]);
    expect(selectDays('weekday:3', dates)).toEqual([4]);
    expect(selectDays('week', dates)).toHaveLength(7);
    expect(selectDays('weekend', ['2026-09-27', '2026-09-28'])).toEqual([0]);
  });
});

describe('info.lookup news', () => {
  it('reads NHK headlines without sending anything, and keeps only https links', async () => {
    const { fetch, urls } = fake({ 'news.web.nhk': NHK });
    const body = envelope(await new CurrentInfoRunner({ fetch, now }).run(step({ kind: 'news' })));
    expect(urls).toEqual(['https://news.web.nhk/n-data/conf/na/rss/cat0.xml']);
    expect(body.data.items.map((i: { title: string }) => i.title)).toEqual(['見出し一', '見出し & 二']);
    expect(body.data.items[0].published_at).toBe('2026-09-26T05:00:00.000Z');
    expect(body.text).toBe('主なニュース（NHK）: 1. 見出し一 2. 見出し & 二');
  });

  it('sends only the topic to Google News and splits the outlet from the headline', async () => {
    const { fetch, urls } = fake({ 'news.google.com': GOOGLE });
    const body = envelope(await new CurrentInfoRunner({ fetch, now }).run(step({ kind: 'news', topic: 'AI' })));
    expect(new URL(urls[0]!).searchParams.get('q')).toBe('AI');
    expect(body.data.items[0]).toMatchObject({ title: 'AI の話', source: '日経' });
  });

  it('parses a Google headline without a source tag', () => {
    expect(parseRss('<item><title>見出し - 共同</title><link>https://x.example/a</link></item>', null)[0]).toMatchObject({ title: '見出し', source: '共同' });
  });
});

describe('information sources', () => {
  it('refuses any host that is not listed, and plain http', async () => {
    const fetch = infoFetch(async () => new Response('ok'));
    await expect(fetch('https://example.com/')).rejects.toThrow(/not an allowed/);
    await expect(fetch('http://api.open-meteo.com/v1/forecast')).rejects.toThrow(/not an allowed/);
    await expect(fetch('https://api.open-meteo.com/v1/forecast')).resolves.toBe('ok');
    expect(CURRENT_INFO_HOSTS).toEqual(['api.open-meteo.com', 'geocoding-api.open-meteo.com', 'news.web.nhk', 'news.google.com']);
  });

  it('does not follow redirects', async () => {
    let seen: RequestInit | undefined;
    await infoFetch(async (_u, init) => { seen = init; return new Response('ok'); })('https://news.web.nhk/x');
    expect(seen?.redirect).toBe('error');
  });

  it('reads the default region from the Mac setting and falls back to Tokyo', () => {
    const dir = mkdtempSync(join(tmpdir(), 'info-'));
    const path = join(dir, 'current-info.json');
    expect(defaultRegion(path)).toBe('東京都');
    writeFileSync(path, JSON.stringify({ default_region: '福岡県' }));
    expect(defaultRegion(path)).toBe('福岡県');
    writeFileSync(path, JSON.stringify({ default_region: 'Atlantis' }));
    expect(defaultRegion(path)).toBe('東京都');
  });

  it('knows every prefecture and common city names', () => {
    expect(knownPlace('札幌')).toMatchObject({ name: '札幌' });
    expect(knownPlace('名古屋市')).toMatchObject({ name: '名古屋' });
    expect(knownPlace('沖縄県')).toMatchObject({ name: '沖縄県' });
  });
});
