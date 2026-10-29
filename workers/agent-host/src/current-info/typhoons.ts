/**
 * 気象庁の台風の情報（台風のニュースに添える、Genie が作る図の元のデータ。本人の方針 2026-10-29）。
 *
 * 取りに行くのは気象庁の公開の一覧と、台風ごとの諸元（何も送らない）。
 * 図は気象庁の発表の数字（時刻・位置の地名・中心気圧・最大風速・強さ）だけから作り、予報は「予報」と書く。
 * 発表から 24 時間より古いものは使わない（気象庁のほかの一覧に、何か月も前のまま残っているものがあった）。
 */
import type { InfoFetch } from './hosts.js';

export const JMA_TYPHOONS = 'https://www.jma.go.jp/bosai/typhoon/data/targetTc.json';
const specsUrl = (tc: string) =>
  `https://www.jma.go.jp/bosai/typhoon/data/${tc}/specifications.json`;
/** 出典として添える気象庁のページ（取りに行く先ではない）。 */
export const JMA_TYPHOON_PAGE = 'https://www.jma.go.jp/bosai/map.html#contents=typhoon';

const TC_ID = /^TC\d{4}$/;
const STALE_MS = 24 * 3_600_000;
const MAX_TYPHOONS = 2;

export interface TyphoonPoint {
  /** 0 は実況、ほかは何時間後の予報か。 */
  readonly hours: number;
  /** その時刻（ISO 8601、気象庁の発表のまま）。 */
  readonly at: string;
  readonly location: string | null;
  readonly pressure_hpa: number | null;
  readonly wind_ms: number | null;
  readonly intensity: string | null;
}

export interface Typhoon {
  /** 「第31号」の 31。 */
  readonly number: number;
  readonly name: string | null;
  readonly issued_at: string;
  readonly points: readonly TyphoonPoint[];
}

export interface OfficialTyphoons {
  readonly kind: 'typhoons';
  readonly source: { readonly name: '気象庁'; readonly url: string };
  readonly fetched_at: string;
  readonly items: readonly Typhoon[];
}

const num = (v: unknown) => {
  const n = typeof v === 'string' || typeof v === 'number' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
};
const str = (v: unknown) =>
  typeof v === 'string' && v.trim() && v.trim() !== '-' ? v.trim() : null;

/** 台風ごとの諸元（specifications.json）を読む。形が違う・古いときは null。 */
export function parseTyphoon(json: string, now: Date): Typhoon | null {
  let rows: unknown;
  try {
    rows = JSON.parse(json);
  } catch {
    return null;
  }
  if (!Array.isArray(rows)) return null;
  const title = rows.find((r) => (r as { part?: unknown })?.part === 'title') as
    { issue?: { JST?: unknown }; typhoonNumber?: unknown; name?: { jp?: unknown } } | undefined;
  const issued = str(title?.issue?.JST);
  const code = str(title?.typhoonNumber);
  if (!issued || !code || !/^\d{4}$/.test(code)) return null;
  const issuedMs = Date.parse(issued);
  if (
    Number.isNaN(issuedMs) ||
    now.getTime() - issuedMs > STALE_MS ||
    issuedMs > now.getTime() + 3_600_000
  )
    return null;
  const points: TyphoonPoint[] = [];
  for (const raw of rows) {
    const r = raw as Record<string, unknown>;
    if (r['part'] === 'title' || typeof r['advancedHours'] !== 'number') continue;
    const at = str((r['validtime'] as { JST?: unknown } | undefined)?.JST);
    if (!at) continue;
    const wind = (r['maximumWind'] as { sustained?: Record<string, unknown> } | undefined)
      ?.sustained;
    points.push({
      hours: r['advancedHours'],
      at,
      location: str(r['location'])?.slice(0, 30) ?? null,
      pressure_hpa: num(r['pressure']),
      wind_ms: num(wind?.['m/s']),
      intensity: str(r['intensity'])?.slice(0, 12) ?? null,
    });
  }
  if (points.length === 0) return null;
  return {
    number: Number(code.slice(2)),
    name: str(title?.name?.jp)?.slice(0, 20) ?? null,
    issued_at: issued,
    points: points.sort((a, b) => a.hours - b.hours).slice(0, 6),
  };
}

/** 台風の話題か（本人が聞いた話題の語で決める。見出しからは決めない）。 */
export const TYPHOON_TOPIC = /台風/;

export async function lookupTyphoons(get: InfoFetch, now: Date): Promise<OfficialTyphoons | null> {
  let list: unknown;
  try {
    list = JSON.parse(await get(JMA_TYPHOONS));
  } catch {
    return null;
  }
  if (!Array.isArray(list)) return null;
  const ids = list
    .map((t) => (t as { tropicalCyclone?: unknown; typhoonNumber?: unknown }) ?? {})
    // 番号の付いた台風だけ（熱帯低気圧は入れない）
    .filter(
      (t) =>
        typeof t.tropicalCyclone === 'string' &&
        TC_ID.test(t.tropicalCyclone) &&
        typeof t.typhoonNumber === 'string',
    )
    .map((t) => t.tropicalCyclone as string)
    .slice(0, MAX_TYPHOONS);
  const items: Typhoon[] = [];
  for (const id of ids) {
    const typhoon = parseTyphoon(await get(specsUrl(id)).catch(() => ''), now);
    if (typhoon) items.push(typhoon);
  }
  if (items.length === 0) return null;
  return {
    kind: 'typhoons',
    source: { name: '気象庁', url: JMA_TYPHOON_PAGE },
    fetched_at: now.toISOString(),
    items,
  };
}
