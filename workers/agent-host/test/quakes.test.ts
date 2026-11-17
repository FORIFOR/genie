/**
 * 気象庁の最近の地震（地震のニュースに添える図の元）。
 *
 * 見ること:
 *   - 同じ地震の続報は 1 件（いちばん新しい発表）。訓練・取り消し・震度の無いもの・7 日より前は入れない
 *   - 地震の話題のときだけ気象庁へ行く。取れなくてもニュースは返す
 */
import { describe, expect, it } from 'vitest';
import { JMA_QUAKES, parseQuakes } from '../src/current-info/quakes.js';
import { lookupNews } from '../src/current-info/news.js';

const NOW = new Date('2026-10-29T00:00:00Z');
const row = (over: Record<string, unknown>) => ({
  eid: 'e1',
  at: '2026-10-28T08:14:00+09:00',
  rdt: '2026-10-28T08:18:00+09:00',
  ttl: '震源・震度情報',
  ift: '発表',
  anm: '釧路地方中南部',
  mag: '4.4',
  maxi: '2',
  ...over,
});

describe('recent earthquakes from JMA', () => {
  it('keeps one row per quake with the latest report, newest first', () => {
    const quakes = parseQuakes(
      JSON.stringify([
        row({ ttl: '震度速報', rdt: '2026-10-28T08:16:00+09:00', anm: '', maxi: '2' }),
        row({}),
        row({
          eid: 'e2',
          at: '2026-10-28T20:00:00+09:00',
          rdt: '2026-10-28T20:03:00+09:00',
          anm: '千葉県北東部',
          mag: '5.1',
          maxi: '5-',
        }),
        row({ eid: 'e3', ift: '訓練' }),
        row({ eid: 'e4', maxi: '-' }),
        row({ eid: 'e5', at: '2026-10-10T08:00:00+09:00', rdt: '2026-10-10T08:03:00+09:00' }),
      ]),
      NOW,
    );
    expect(quakes).toEqual([
      {
        at: '2026-10-28T20:00:00+09:00',
        place: '千葉県北東部',
        magnitude: 5.1,
        max_intensity: '5-',
      },
      {
        at: '2026-10-28T08:14:00+09:00',
        place: '釧路地方中南部',
        magnitude: 4.4,
        max_intensity: '2',
      },
    ]);
    expect(parseQuakes('not json', NOW)).toEqual([]);
  });

  it('goes to JMA only for an earthquake topic, and still answers when JMA fails', async () => {
    const rss =
      '<rss><channel><item><title>地震の話 - 共同</title><link>https://x.example/a</link></item></channel></rss>';
    const asked: string[] = [];
    const get = async (url: string) => {
      asked.push(url);
      if (url === JMA_QUAKES) return JSON.stringify([row({})]);
      return rss;
    };
    const quake = await lookupNews({ topic: '地震' }, get, () => NOW);
    expect(quake.data?.official).toMatchObject({
      kind: 'quakes',
      source: { name: '気象庁' },
      items: [{ place: '釧路地方中南部' }],
    });
    expect(asked).toContain(JMA_QUAKES);

    asked.length = 0;
    const other = await lookupNews({ topic: '株価' }, get, () => NOW);
    expect(other.data?.official).toBeUndefined();
    expect(asked).not.toContain(JMA_QUAKES);

    const failing = async (url: string) => {
      if (url === JMA_QUAKES) throw new Error('down');
      return rss;
    };
    const still = await lookupNews({ topic: '地震' }, failing, () => NOW);
    expect(still.data?.items).toHaveLength(1);
    expect(still.data?.official).toBeUndefined();
  });
});
