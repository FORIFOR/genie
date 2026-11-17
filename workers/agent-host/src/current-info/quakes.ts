/**
 * 気象庁の最近の地震（地震のニュースに添える、Genie が作る図の元のデータ。本人の方針 2026-10-29）。
 *
 * 取りに行くのは気象庁の公開の一覧（何も送らない）。図は記事の図の写しではなく、
 * 気象庁の発表の数字（発生時刻・震央地名・マグニチュード・最大震度）だけから作る。
 * 同じ地震の続報（震度速報 → 震源・震度情報）は 1 件にまとめ、いちばん新しい発表を使う。
 */
import type { InfoFetch } from './hosts.js';

export const JMA_QUAKES = 'https://www.jma.go.jp/bosai/quake/data/list.json';
/** 出典として添える気象庁のページ（取りに行く先ではない）。 */
export const JMA_QUAKES_PAGE = 'https://www.jma.go.jp/bosai/map.html#contents=earthquake_map';

/** 震度の並び（気象庁の表記「5-」「5+」…）。 */
export const INTENSITIES = ['1', '2', '3', '4', '5-', '5+', '6-', '6+', '7'] as const;
export type Intensity = (typeof INTENSITIES)[number];

export interface Quake {
  /** 発生時刻（ISO 8601、気象庁の発表のまま）。 */
  readonly at: string;
  readonly place: string;
  readonly magnitude: number | null;
  readonly max_intensity: Intensity;
}

export interface OfficialQuakes {
  readonly kind: 'quakes';
  readonly source: { readonly name: '気象庁'; readonly url: string };
  readonly fetched_at: string;
  readonly items: readonly Quake[];
}

const MAX_ITEMS = 6;
const WINDOW_MS = 7 * 86_400_000;

/** 一覧を読む。発表（訓練・取り消しでない）で、震央と最大震度がそろったものだけ。 */
export function parseQuakes(json: string, now: Date): Quake[] {
  let rows: unknown;
  try {
    rows = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(rows)) return [];
  const latest = new Map<string, { rdt: string; quake: Quake }>();
  for (const raw of rows) {
    const r = raw as Record<string, unknown>;
    const eid = typeof r['eid'] === 'string' ? r['eid'] : null;
    const at = typeof r['at'] === 'string' ? r['at'] : null;
    const place = typeof r['anm'] === 'string' ? r['anm'].trim() : '';
    const maxi = r['maxi'];
    if (!eid || !at || !place || r['ift'] !== '発表') continue;
    if (!(INTENSITIES as readonly unknown[]).includes(maxi)) continue;
    const when = Date.parse(at);
    if (Number.isNaN(when) || now.getTime() - when > WINDOW_MS || when > now.getTime()) continue;
    const mag = typeof r['mag'] === 'string' ? Number(r['mag']) : NaN;
    const rdt = typeof r['rdt'] === 'string' ? r['rdt'] : '';
    const seen = latest.get(eid);
    if (seen && seen.rdt >= rdt) continue;
    latest.set(eid, {
      rdt,
      quake: {
        at,
        place: place.slice(0, 40),
        magnitude: Number.isFinite(mag) ? mag : null,
        max_intensity: maxi as Intensity,
      },
    });
  }
  return [...latest.values()]
    .map((v) => v.quake)
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
    .slice(0, MAX_ITEMS);
}

/** 地震の話題か（本人が聞いた話題の語で決める。見出しからは決めない）。 */
export const QUAKE_TOPIC = /地震|震度|余震|揺れ/;

export async function lookupQuakes(get: InfoFetch, now: Date): Promise<OfficialQuakes | null> {
  const items = parseQuakes(await get(JMA_QUAKES), now);
  if (items.length === 0) return null;
  return {
    kind: 'quakes',
    source: { name: '気象庁', url: JMA_QUAKES_PAGE },
    fetched_at: now.toISOString(),
    items,
  };
}
