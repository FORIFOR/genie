/**
 * 地名 → 緯度経度。
 *
 * 都道府県（県庁所在地）と主な都市は同梱の表で引く。既定の地域と、よく聞かれる地名は
 * どこにも送らない。表に無い地名だけ Open-Meteo の地名検索に聞く。
 */
import type { InfoFetch } from './hosts.js';

export interface Place {
  readonly name: string;
  readonly latitude: number;
  readonly longitude: number;
}

/** [正式名, 緯度, 経度, 別名…]。座標は県庁所在地。 */
const PREFECTURES: readonly (readonly [string, number, number, ...string[]])[] = [
  ['北海道', 43.06, 141.35, '札幌'],
  ['青森県', 40.82, 140.74, '青森'],
  ['岩手県', 39.7, 141.15, '岩手', '盛岡'],
  ['宮城県', 38.27, 140.87, '宮城', '仙台'],
  ['秋田県', 39.72, 140.1, '秋田'],
  ['山形県', 38.24, 140.36, '山形'],
  ['福島県', 37.75, 140.47, '福島'],
  ['茨城県', 36.34, 140.45, '茨城', '水戸'],
  ['栃木県', 36.57, 139.88, '栃木', '宇都宮'],
  ['群馬県', 36.39, 139.06, '群馬', '前橋'],
  ['埼玉県', 35.86, 139.65, '埼玉', 'さいたま'],
  ['千葉県', 35.61, 140.12, '千葉'],
  ['東京都', 35.69, 139.69, '東京'],
  ['神奈川県', 35.45, 139.64, '神奈川', '横浜'],
  ['新潟県', 37.9, 139.02, '新潟'],
  ['富山県', 36.7, 137.21, '富山'],
  ['石川県', 36.59, 136.63, '石川', '金沢'],
  ['福井県', 36.07, 136.22, '福井'],
  ['山梨県', 35.66, 138.57, '山梨', '甲府'],
  ['長野県', 36.65, 138.18, '長野'],
  ['岐阜県', 35.39, 136.72, '岐阜'],
  ['静岡県', 34.98, 138.38, '静岡'],
  ['愛知県', 35.18, 136.91, '愛知', '名古屋'],
  ['三重県', 34.73, 136.51, '三重', '津'],
  ['滋賀県', 35.0, 135.87, '滋賀', '大津'],
  ['京都府', 35.02, 135.76, '京都'],
  ['大阪府', 34.69, 135.52, '大阪'],
  ['兵庫県', 34.69, 135.18, '兵庫', '神戸'],
  ['奈良県', 34.69, 135.83, '奈良'],
  ['和歌山県', 34.23, 135.17, '和歌山'],
  ['鳥取県', 35.5, 134.24, '鳥取'],
  ['島根県', 35.47, 133.05, '島根', '松江'],
  ['岡山県', 34.66, 133.93, '岡山'],
  ['広島県', 34.4, 132.46, '広島'],
  ['山口県', 34.19, 131.47, '山口'],
  ['徳島県', 34.07, 134.56, '徳島'],
  ['香川県', 34.34, 134.04, '香川', '高松'],
  ['愛媛県', 33.84, 132.77, '愛媛', '松山'],
  ['高知県', 33.56, 133.53, '高知'],
  ['福岡県', 33.61, 130.42, '福岡'],
  ['佐賀県', 33.25, 130.3, '佐賀'],
  ['長崎県', 32.74, 129.87, '長崎'],
  ['熊本県', 32.79, 130.74, '熊本'],
  ['大分県', 33.24, 131.61, '大分'],
  ['宮崎県', 31.91, 131.42, '宮崎'],
  ['鹿児島県', 31.56, 130.56, '鹿児島'],
  ['沖縄県', 26.21, 127.68, '沖縄', '那覇'],
];

/** 設定で選べる地域（都道府県の正式名）。 */
export const PREFECTURE_NAMES: readonly string[] = PREFECTURES.map(([name]) => name);

const TABLE = new Map<string, Place>();
for (const [name, latitude, longitude, ...aliases] of PREFECTURES) {
  TABLE.set(name, { name, latitude, longitude });
  // 「札幌」と聞かれたら「札幌」と答える（「北海道」にしない）
  for (const alias of aliases) TABLE.set(alias, { name: alias, latitude, longitude });
}

export function knownPlace(name: string): Place | null {
  const key = name.trim().normalize('NFKC');
  return TABLE.get(key) ?? TABLE.get(key.replace(/市$/, '')) ?? null;
}

interface GeocodeResponse {
  readonly results?: readonly { name?: string; latitude?: number; longitude?: number }[];
}

/**
 * 表に無い地名を探す。見つからなければ null（**近い所を勝手に選ばない**）。
 * 地名検索は「札幌」では空で、「札幌市」なら返すので、両方を試す。
 */
export async function resolvePlace(name: string, get: InfoFetch): Promise<Place | null> {
  const known = knownPlace(name);
  if (known) return known;
  const tries = /[市町村区都道府県]$/.test(name) ? [name] : [name, `${name}市`];
  for (const query of tries) {
    const url = `https://geocoding-api.open-meteo.com/v1/search?${new URLSearchParams({
      name: query,
      count: '1',
      language: 'ja',
    }).toString()}`;
    const found = (JSON.parse(await get(url)) as GeocodeResponse).results?.[0];
    if (found && typeof found.latitude === 'number' && typeof found.longitude === 'number')
      return { name, latitude: found.latitude, longitude: found.longitude };
  }
  return null;
}
