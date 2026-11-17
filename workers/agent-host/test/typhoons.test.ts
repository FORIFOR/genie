/**
 * 気象庁の台風の情報（台風のニュースに添える図の元）。
 *
 * 見ること:
 *   - 実況と予報を時刻の順に読み、風速・気圧・強さ・位置の地名だけを持つ
 *   - 発表から 24 時間より古いもの・番号の無いもの（熱帯低気圧）・形の違うものは使わない
 *   - 台風の話題のときだけ気象庁へ行く
 */
import { describe, expect, it } from 'vitest';
import { JMA_TYPHOONS, parseTyphoon } from '../src/current-info/typhoons.js';
import { lookupNews } from '../src/current-info/news.js';

const NOW = new Date('2026-10-29T15:00:00Z');
const specs = (issue = '2026-10-29T21:45:00+09:00') =>
  JSON.stringify([
    { part: 'title', issue: { JST: issue }, typhoonNumber: '2631', name: { jp: 'インファ' } },
    {
      part: { jp: '予報　１２時間後' },
      advancedHours: 12,
      validtime: { JST: '2026-10-30T09:00:00+09:00' },
      location: 'マリアナ諸島',
      pressure: '940',
      maximumWind: { sustained: { 'm/s': '45' } },
      intensity: '非常に強い',
    },
    {
      part: { jp: '実況' },
      advancedHours: 0,
      validtime: { JST: '2026-10-29T21:00:00+09:00' },
      location: '南鳥島近海',
      pressure: '940',
      maximumWind: { sustained: { 'm/s': '45' } },
      intensity: '非常に強い',
      scale: '-',
    },
  ]);

describe('typhoons from JMA', () => {
  it('reads the analysis and forecasts in time order', () => {
    expect(parseTyphoon(specs(), NOW)).toEqual({
      number: 31,
      name: 'インファ',
      issued_at: '2026-10-29T21:45:00+09:00',
      points: [
        {
          hours: 0,
          at: '2026-10-29T21:00:00+09:00',
          location: '南鳥島近海',
          pressure_hpa: 940,
          wind_ms: 45,
          intensity: '非常に強い',
        },
        {
          hours: 12,
          at: '2026-10-30T09:00:00+09:00',
          location: 'マリアナ諸島',
          pressure_hpa: 940,
          wind_ms: 45,
          intensity: '非常に強い',
        },
      ],
    });
  });

  it('refuses stale, malformed or unnumbered data', () => {
    expect(parseTyphoon(specs('2026-10-27T21:45:00+09:00'), NOW)).toBeNull();
    expect(parseTyphoon('[]', NOW)).toBeNull();
    expect(parseTyphoon('nope', NOW)).toBeNull();
  });

  it('goes to JMA only for a typhoon topic, and follows only typhoon ids it can trust', async () => {
    const rss =
      '<rss><channel><item><title>台風の話 - 共同</title><link>https://x.example/a</link></item></channel></rss>';
    const asked: string[] = [];
    const get = async (url: string) => {
      asked.push(url);
      if (url === JMA_TYPHOONS)
        return JSON.stringify([
          { tropicalCyclone: 'TC2637', typhoonNumber: '2631' },
          { tropicalCyclone: 'TD2638' },
          { tropicalCyclone: '../x', typhoonNumber: '2632' },
        ]);
      if (url.endsWith('/TC2637/specifications.json')) return specs();
      return rss;
    };
    const news = await lookupNews({ topic: '台風' }, get, () => NOW);
    expect(news.data?.official).toMatchObject({ kind: 'typhoons', items: [{ number: 31 }] });
    expect(asked.filter((u) => u.includes('/typhoon/data/T') && u !== JMA_TYPHOONS)).toEqual([
      'https://www.jma.go.jp/bosai/typhoon/data/TC2637/specifications.json',
    ]);
    asked.length = 0;
    await lookupNews({ topic: '株価' }, get, () => NOW);
    expect(asked).not.toContain(JMA_TYPHOONS);
  });
});
