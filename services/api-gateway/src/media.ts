/**
 * Media Resolver（本人の方針 2026-10-28）。カードの画像は、実在のものに紐づいた本物だけを、gateway が中継する。
 *
 *   店の写真  … その店（place_id）の Google マップの写真（Place Photos）。撮った人の名前はカード側で出す
 *   地図      … 探した候補の位置に番号を付けた地図（Maps Static API）
 *
 * - Google のキーは gateway から Google への呼び出しにだけ載せる（LINE・端末には出さない）
 * - 画像は保存しない。リンク（7 日）は「どの店のどの写真か / どこの地図か」だけを指し、開かれるたびに取り直す
 * - 取れなければ 404（カードは写真なしの形で出ている前提。作った画像では代えない）
 * - 取りに行く回数は、店の写真・地図それぞれ月の上限を数える
 */
import { createHash, randomBytes } from 'node:crypto';
import { sql } from 'kysely';
import { withIdentity, withTenant, type DbHandle } from '@genie/db';

const LINK_DAYS = 7;
const MAX_BYTES = 5_000_000;
const hash = (token: string) => createHash('sha256').update(token).digest('hex');
const PHOTO_NAME = /^places\/[A-Za-z0-9_-]+\/photos\/[A-Za-z0-9_-]+$/;

export type MediaRef =
  | { readonly kind: 'place_photo'; readonly placeId: string; readonly photoName: string }
  | {
      readonly kind: 'static_map';
      readonly markers: readonly {
        readonly lat: number;
        readonly lng: number;
        readonly label: string;
      }[];
    };

export interface MediaDeps {
  readonly db: DbHandle;
  readonly apiKey: string | null;
  /** 公開の先頭（GENIE_PUBLIC_URL）。無ければ画像のリンクは作らない。 */
  readonly publicUrl: string | null;
  readonly monthlyPhotos: number;
  readonly monthlyMaps: number;
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => Date;
}

export class MediaResolver {
  constructor(private readonly deps: MediaDeps) {}

  get available(): boolean {
    return Boolean(this.deps.apiKey && this.deps.publicUrl);
  }

  /** 画像のリンク（LINE が取りに来る https の URL）。作れなければ null。 */
  async link(tenantId: string, ref: MediaRef): Promise<string | null> {
    if (!this.available) return null;
    if (ref.kind === 'place_photo' && !PHOTO_NAME.test(ref.photoName)) return null;
    if (ref.kind === 'static_map' && ref.markers.length === 0) return null;
    // 写真の名前がその店のものか（places/<店>/photos/…）。違えば作らない
    if (ref.kind === 'place_photo' && !ref.photoName.startsWith(`places/${ref.placeId}/`))
      return null;
    const token = randomBytes(24).toString('base64url');
    const now = this.deps.now?.() ?? new Date();
    await withTenant(this.deps.db, tenantId, (tx) =>
      tx
        .insertInto('channel_media')
        .values({
          token_hash: hash(token),
          tenant_id: tenantId,
          kind: ref.kind,
          ref: JSON.stringify(
            ref.kind === 'place_photo'
              ? { place_id: ref.placeId, photo_name: ref.photoName }
              : { markers: ref.markers.slice(0, 9) },
          ),
          source_entity_id: ref.kind === 'place_photo' ? ref.placeId : 'search',
          expires_at: new Date(now.getTime() + LINK_DAYS * 86_400_000),
        })
        .execute(),
    );
    return `${this.deps.publicUrl}/v1/channels/media/${token}`;
  }

  /** LINE が画像を取りに来た。Google から取り直して返す。取れなければ null。 */
  async fetch(token: string): Promise<{ bytes: Uint8Array; contentType: string } | null> {
    if (!this.deps.apiKey) return null;
    const row = await withIdentity(this.deps.db, (tx) =>
      tx
        .selectFrom('channel_media')
        .select(['tenant_id', 'kind', 'ref', 'source_entity_id'])
        .where('token_hash', '=', hash(token))
        .where('expires_at', '>', sql<Date>`now()`)
        .executeTakeFirst(),
    );
    if (!row) return null;
    const ref = row.ref as { place_id?: string; photo_name?: string; markers?: MarkerRow[] };
    let url: string;
    let headers: Record<string, string> = {};
    if (row.kind === 'place_photo') {
      const name = ref.photo_name ?? '';
      if (!PHOTO_NAME.test(name) || !name.startsWith(`places/${row.source_entity_id}/`))
        return null;
      if (!(await this.#spend(row.tenant_id, 'places.photo', this.deps.monthlyPhotos))) return null;
      url = `https://places.googleapis.com/v1/${name}/media?maxWidthPx=800`;
      headers = { 'x-goog-api-key': this.deps.apiKey };
    } else {
      const markers = (ref.markers ?? []).filter(validMarker).slice(0, 9);
      if (markers.length === 0) return null;
      if (!(await this.#spend(row.tenant_id, 'maps.static', this.deps.monthlyMaps))) return null;
      url = staticMapUrl(markers, this.deps.apiKey);
    }
    try {
      const res = await (this.deps.fetchImpl ?? fetch)(url, {
        headers,
        redirect: 'follow',
        signal: AbortSignal.timeout(10_000),
      });
      const type = res.headers.get('content-type') ?? '';
      if (!res.ok || !/^image\/(jpeg|png|webp)/.test(type)) return null;
      const bytes = new Uint8Array(await res.arrayBuffer());
      if (bytes.byteLength === 0 || bytes.byteLength > MAX_BYTES) return null;
      return { bytes, contentType: type.split(';')[0]! };
    } catch {
      return null;
    }
  }

  async #spend(tenantId: string, kind: string, limit: number): Promise<boolean> {
    const month = (this.deps.now?.() ?? new Date()).toISOString().slice(0, 7);
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
}

interface MarkerRow {
  lat: number;
  lng: number;
  label: string;
}

function validMarker(m: MarkerRow): boolean {
  return (
    typeof m.lat === 'number' &&
    typeof m.lng === 'number' &&
    Math.abs(m.lat) <= 90 &&
    Math.abs(m.lng) <= 180 &&
    /^[1-9]$/.test(m.label)
  );
}

/** 番号つきの地図（Maps Static API）。送るのは候補の緯度経度と番号だけ。 */
export function staticMapUrl(markers: readonly MarkerRow[], key: string): string {
  const params = new URLSearchParams({ size: '600x390', scale: '2', language: 'ja', region: 'JP' });
  for (const m of markers)
    params.append(
      'markers',
      `color:0x0A7D5A|label:${m.label}|${m.lat.toFixed(6)},${m.lng.toFixed(6)}`,
    );
  params.append('key', key);
  return `https://maps.googleapis.com/maps/api/staticmap?${params.toString()}`;
}
