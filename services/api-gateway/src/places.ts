/**
 * お店を探す（Google Places API (New) の Text Search）。Mac の「近くの店」と同じ提供元・同じキー（キーチェーンの google-maps）。
 *
 * 送るのは検索の語だけ（「新橋 居酒屋」）。会話の文脈・名前・住所は送らない。
 * 本人の月の上限（GENIE_PLACES_MONTHLY_SEARCHES、既定 300）を超えたら探さない。
 * 頼まれた時刻に開いているかは、取れた営業時間（regularOpeningHours）から決める。分からなければ null（作らない）。
 *
 * 写真（本人の方針 2026-10-28: 実在の店に紐づいた本物の画像だけ。作った画像で代えない）:
 *   上位 3 件だけ、その店の Google マップの写真（Place Photos）を 1 枚取る。キーを含まない短命の URL（photoUri）を
 *   skipHttpRedirect で受け取り、撮った人の名前（帰属表示）と一緒にカードへ出す。写真の URL は保存しない
 *   （目的に残す候補からは外す）。月の上限（GENIE_PLACES_MONTHLY_PHOTOS、既定 900）を超えたら写真なしで出す。
 */
import { withTenant, type DbHandle } from '@genie/db';

export const PLACES_ENDPOINT = 'https://places.googleapis.com/v1/places:searchText';
const FIELDS = [
  'places.id',
  'places.displayName',
  'places.shortFormattedAddress',
  'places.formattedAddress',
  'places.rating',
  'places.userRatingCount',
  'places.priceLevel',
  'places.priceRange',
  'places.googleMapsUri',
  'places.websiteUri',
  'places.nationalPhoneNumber',
  'places.reservable',
  'places.regularOpeningHours',
  'places.primaryTypeDisplayName',
  'places.photos',
  'places.location',
].join(',');
const PHOTO_PLACES = 3;

export interface Place {
  readonly id: string;
  readonly name: string;
  readonly kind: string | null;
  readonly address: string | null;
  readonly rating: number | null;
  readonly ratingCount: number | null;
  /** 1 人あたりの目安（円）。取れなければ null。 */
  readonly priceFrom: number | null;
  readonly priceTo: number | null;
  readonly mapsUri: string | null;
  readonly websiteUri: string | null;
  readonly phone: string | null;
  readonly reservable: boolean | null;
  /** 頼まれた日時に開いているか。時刻を聞いていない・営業時間が取れないときは null。 */
  readonly openAt: boolean | null;
  /** その店の Google マップの写真（短命の URL と撮った人）。取れなければ無し（作った画像で代えない）。 */
  readonly photo?: { readonly uri: string; readonly attribution: string | null };
  /** 地図に番号を打つための位置。 */
  readonly location?: { readonly lat: number; readonly lng: number };
}

interface RawPeriodPoint {
  day?: number;
  hour?: number;
  minute?: number;
}
interface RawPlace {
  id?: string;
  displayName?: { text?: string };
  shortFormattedAddress?: string;
  formattedAddress?: string;
  rating?: number;
  userRatingCount?: number;
  priceRange?: { startPrice?: { units?: string }; endPrice?: { units?: string } };
  googleMapsUri?: string;
  websiteUri?: string;
  nationalPhoneNumber?: string;
  reservable?: boolean;
  regularOpeningHours?: { periods?: { open?: RawPeriodPoint; close?: RawPeriodPoint }[] };
  primaryTypeDisplayName?: { text?: string };
  photos?: { name?: string; authorAttributions?: { displayName?: string }[] }[];
  location?: { latitude?: number; longitude?: number };
}

/** その曜日（0=日）・時刻（分）に、営業時間の中か。営業時間が無ければ null。 */
export function openAt(raw: RawPlace, weekday: number, minutes: number): boolean | null {
  const periods = raw.regularOpeningHours?.periods;
  if (!periods || periods.length === 0) return null;
  const at = weekday * 1440 + minutes;
  const week = 7 * 1440;
  for (const p of periods) {
    if (!p.open) continue;
    // close が無い = 24 時間
    if (!p.close) return true;
    const open = (p.open.day ?? 0) * 1440 + (p.open.hour ?? 0) * 60 + (p.open.minute ?? 0);
    let close = (p.close.day ?? 0) * 1440 + (p.close.hour ?? 0) * 60 + (p.close.minute ?? 0);
    if (close <= open) close += week;
    if ((at >= open && at < close) || (at + week >= open && at + week < close)) return true;
  }
  return false;
}

export interface PlacesDeps {
  readonly apiKey: string | null;
  readonly monthlySearches: number;
  /** 写真を取る回数の月の上限（既定 900）。 */
  readonly monthlyPhotos?: number;
  readonly db: DbHandle;
  readonly fetchImpl?: typeof fetch;
  /**
   * 写真を gateway の中継（media.ts）で出すときのリンク。あれば短命の URL は取らず、これを使う
   * （写真は LINE が取りに来たときに取り直す）。
   */
  readonly photoLink?: (
    tenantId: string,
    placeId: string,
    photoName: string,
  ) => Promise<string | null>;
}

export type SearchOutcome =
  | { readonly kind: 'ok'; readonly places: readonly Place[] }
  | { readonly kind: 'unavailable'; readonly reason: 'no_key' | 'limit' | 'failed' };

export class PlacesSearch {
  constructor(private readonly deps: PlacesDeps) {}

  get available(): boolean {
    return Boolean(this.deps.apiKey);
  }

  /** 今月の残りを 1 つ使う。上限なら false。 */
  async #spend(
    tenantId: string,
    month: string,
    kind: 'places.search' | 'places.photo' = 'places.search',
    limit = this.deps.monthlySearches,
  ): Promise<boolean> {
    return withTenant(this.deps.db, tenantId, async (tx) => {
      const row = await tx
        .insertInto('usage_counters')
        .values({ tenant_id: tenantId, kind, month, count: 1 })
        .onConflict((oc) =>
          oc
            .columns(['tenant_id', 'kind', 'month'])
            .doUpdateSet((eb) => ({ count: eb('usage_counters.count', '+', 1) })),
        )
        .returning('count')
        .executeTakeFirstOrThrow();
      return row.count <= limit;
    });
  }

  async search(
    tenantId: string,
    input: {
      readonly query: string;
      readonly month: string;
      readonly at: { weekday: number; minutes: number } | null;
    },
  ): Promise<SearchOutcome> {
    if (!this.deps.apiKey) return { kind: 'unavailable', reason: 'no_key' };
    if (!(await this.#spend(tenantId, input.month)))
      return { kind: 'unavailable', reason: 'limit' };
    let body: { places?: RawPlace[] };
    try {
      const res = await (this.deps.fetchImpl ?? fetch)(PLACES_ENDPOINT, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-goog-api-key': this.deps.apiKey,
          'x-goog-fieldmask': FIELDS,
        },
        body: JSON.stringify({
          textQuery: input.query,
          languageCode: 'ja',
          regionCode: 'JP',
          pageSize: 5,
        }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) return { kind: 'unavailable', reason: 'failed' };
      body = (await res.json()) as { places?: RawPlace[] };
    } catch {
      return { kind: 'unavailable', reason: 'failed' };
    }
    const raw = (body.places ?? []).filter((p) => p.id && p.displayName?.text);
    const photos = await Promise.all(
      raw.map((p, i) => (i < PHOTO_PLACES ? this.#photo(tenantId, input.month, p) : null)),
    );
    const places = raw.map((p, i): Place => ({
      id: p.id!,
      name: p.displayName!.text!,
      kind: p.primaryTypeDisplayName?.text ?? null,
      address: p.shortFormattedAddress ?? p.formattedAddress ?? null,
      rating: typeof p.rating === 'number' ? p.rating : null,
      ratingCount: typeof p.userRatingCount === 'number' ? p.userRatingCount : null,
      priceFrom: p.priceRange?.startPrice?.units ? Number(p.priceRange.startPrice.units) : null,
      priceTo: p.priceRange?.endPrice?.units ? Number(p.priceRange.endPrice.units) : null,
      mapsUri: p.googleMapsUri ?? null,
      websiteUri: p.websiteUri ?? null,
      phone: p.nationalPhoneNumber ?? null,
      reservable: typeof p.reservable === 'boolean' ? p.reservable : null,
      openAt: input.at ? openAt(p, input.at.weekday, input.at.minutes) : null,
      ...(photos[i] ? { photo: photos[i] } : {}),
      ...(typeof p.location?.latitude === 'number' && typeof p.location.longitude === 'number'
        ? { location: { lat: p.location.latitude, lng: p.location.longitude } }
        : {}),
    }));
    return { kind: 'ok', places };
  }

  /** その店の最初の写真の、キーを含まない URL（Place Photos、skipHttpRedirect）。取れなければ null。 */
  async #photo(
    tenantId: string,
    month: string,
    place: RawPlace,
  ): Promise<{ uri: string; attribution: string | null } | null> {
    const first = place.photos?.[0];
    if (!first?.name || !/^places\/[^/]+\/photos\/[^/?#]+$/.test(first.name)) return null;
    const by =
      first.authorAttributions
        ?.map((a) => a.displayName)
        .filter((n): n is string => typeof n === 'string' && n.length > 0)
        .join('・') || null;
    // 中継があれば、そのリンク（数えるのは LINE が取りに来たとき）
    if (this.deps.photoLink) {
      const uri = await this.deps.photoLink(tenantId, place.id!, first.name).catch(() => null);
      return uri ? { uri, attribution: by } : null;
    }
    if (!(await this.#spend(tenantId, month, 'places.photo', this.deps.monthlyPhotos ?? 900)))
      return null;
    try {
      const res = await (this.deps.fetchImpl ?? fetch)(
        `https://places.googleapis.com/v1/${first.name}/media?maxWidthPx=800&skipHttpRedirect=true`,
        {
          headers: { 'x-goog-api-key': this.deps.apiKey! },
          signal: AbortSignal.timeout(10_000),
        },
      );
      if (!res.ok) return null;
      const body = (await res.json()) as { photoUri?: string };
      if (typeof body.photoUri !== 'string' || !/^https:\/\//.test(body.photoUri)) return null;
      return { uri: body.photoUri, attribution: by };
    } catch {
      return null;
    }
  }
}
