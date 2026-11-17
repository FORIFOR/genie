/**
 * カードの画像の中継（Media Resolver）。Google は代役。
 *
 * 見ること:
 *   - 店の写真・地図は、gateway のリンク（https://<公開の先頭>/v1/channels/media/…）で出す。Google のキーは外へ出ない
 *   - 写真はその店のものだけ（店の ID と写真の名前が合わなければリンクを作らない）。保存せず、開かれるたびに取り直す
 *   - 画像でない・取れない・上限を超えたら 404（作った画像では代えない）
 *   - お店探しのカードに、番号つきの地図と、その店の写真のリンクが付く
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type TokenResponse, uuidv7 } from '@genie/contracts';
import { MediaResolver } from '../src/media.js';
import { PlacesSearch } from '../src/places.js';
import { RestaurantGoals, restaurantTurn } from '../src/restaurant.js';
import { makeTestApp, makeTokens, testDbConfig, type TestApp } from './support.js';

const url = process.env['TEST_DATABASE_URL'];
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);

describe.skipIf(!url)('card images through the gateway', () => {
  let h: TestApp;
  let tenantId: string;
  let userId: string;
  let conversationId: string;
  const asked: { url: string; key: string | null }[] = [];
  let photoType = 'image/jpeg';
  const google = (async (target: string, init?: RequestInit) => {
    asked.push({ url: target, key: new Headers(init?.headers).get('x-goog-api-key') });
    if (target.startsWith('https://places.googleapis.com/v1/places:searchText'))
      return Response.json({
        places: [
          {
            id: 'shopA',
            displayName: { text: '炭火 A' },
            location: { latitude: 35.6662, longitude: 139.7583 },
            photos: [
              { name: 'places/shopA/photos/PH1', authorAttributions: [{ displayName: '撮影者' }] },
            ],
          },
          {
            id: 'shopB',
            displayName: { text: '酒場 B' },
            location: { latitude: 35.667, longitude: 139.759 },
          },
        ],
      });
    if (target.includes('/media') || target.startsWith('https://maps.googleapis.com/'))
      return new Response(JPEG, { headers: { 'content-type': photoType } });
    return new Response('', { status: 404 });
  }) as typeof fetch;
  let resolver: MediaResolver;

  beforeAll(async () => {
    h = await makeTestApp({
      dbConfig: testDbConfig(url!, process.env['TEST_IDENTITY_DATABASE_URL']),
      tokens: await makeTokens(),
      media: { fetchImpl: google, monthlyPhotos: 3 },
    });
    const access = (
      await h.app.inject({
        method: 'POST',
        url: '/v1/auth/dev/token',
        payload: { email: `media-${uuidv7()}@example.com`, display_name: 'Media' },
      })
    ).json<TokenResponse>().access_token;
    const claims = JSON.parse(Buffer.from(access.split('.')[1]!, 'base64url').toString()) as {
      tid: string;
      sub: string;
    };
    tenantId = claims.tid;
    userId = claims.sub;
    conversationId = (
      await h.app.inject({
        method: 'POST',
        url: '/v1/conversations',
        headers: { authorization: `Bearer ${access}` },
        payload: {},
      })
    ).json<{ id: string }>().id;
    resolver = new MediaResolver({
      db: h.db,
      apiKey: 'test-key',
      publicUrl: 'https://genie.test',
      monthlyPhotos: 3,
      monthlyMaps: 300,
      fetchImpl: google,
    });
  });
  afterAll(async () => {
    await h?.close();
  });

  const get = (link: string) => h.app.inject({ method: 'GET', url: new URL(link).pathname });

  it('serves a shop’s own photo, fetched again each time, with the key only in the header to Google', async () => {
    const link = (await resolver.link(tenantId, {
      kind: 'place_photo',
      placeId: 'shopA',
      photoName: 'places/shopA/photos/PH1',
    }))!;
    expect(link).toMatch(/^https:\/\/genie\.test\/v1\/channels\/media\/[A-Za-z0-9_-]{32}$/);
    const before = asked.length;
    const res = await get(link);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('image/jpeg');
    expect(new Uint8Array(res.rawPayload)).toEqual(JPEG);
    expect(asked.slice(before)).toEqual([
      {
        url: 'https://places.googleapis.com/v1/places/shopA/photos/PH1/media?maxWidthPx=800',
        key: 'test-key',
      },
    ]);
    // もう一度開くと、もう一度取りに行く（保存していない）
    await get(link);
    expect(asked.length).toBe(before + 2);
  });

  it('refuses a photo that does not belong to the shop, non-images, unknown links, and past the monthly limit', async () => {
    expect(
      await resolver.link(tenantId, {
        kind: 'place_photo',
        placeId: 'shopB',
        photoName: 'places/shopA/photos/PH1',
      }),
    ).toBeNull();
    expect(
      (await h.app.inject({ method: 'GET', url: `/v1/channels/media/${'Q'.repeat(32)}` }))
        .statusCode,
    ).toBe(404);
    const link = (await resolver.link(tenantId, {
      kind: 'place_photo',
      placeId: 'shopA',
      photoName: 'places/shopA/photos/PH1',
    }))!;
    photoType = 'text/html';
    expect((await get(link)).statusCode).toBe(404);
    photoType = 'image/jpeg';
    // 月の上限（3 回）。上の 2 回 + HTML の 1 回で使い切った
    expect((await get(link)).statusCode).toBe(404);
  });

  it('draws a numbered Google map and keeps the key out of the link', async () => {
    const link = (await resolver.link(tenantId, {
      kind: 'static_map',
      markers: [
        { lat: 35.6662, lng: 139.7583, label: '1' },
        { lat: 35.667, lng: 139.759, label: '2' },
      ],
    }))!;
    expect(link).not.toContain('key');
    const before = asked.length;
    expect((await get(link)).statusCode).toBe(200);
    const map = new URL(asked[before]!.url);
    expect(map.origin + map.pathname).toBe('https://maps.googleapis.com/maps/api/staticmap');
    expect(map.searchParams.getAll('markers')).toEqual([
      'color:0x0A7D5A|label:1|35.666200,139.758300',
      'color:0x0A7D5A|label:2|35.667000,139.759000',
    ]);
  });

  it('puts the map and the shop’s photo link on the places card', async () => {
    const reply = await restaurantTurn(
      {
        goals: new RestaurantGoals(h.db),
        media: resolver,
        places: new PlacesSearch({
          apiKey: 'test-key',
          monthlySearches: 300,
          db: h.db,
          fetchImpl: google,
          photoLink: (t, placeId, photoName) =>
            resolver.link(t, { kind: 'place_photo', placeId, photoName }),
        }),
        timeZone: 'Asia/Tokyo',
      },
      { tenantId, userId },
      conversationId,
      '新橋でいい店ある？',
    );
    const card = JSON.parse(reply!.card!) as {
      map?: string;
      places: { name: string; photo?: { uri: string; attribution: string | null } }[];
    };
    expect(card.map).toMatch(/^https:\/\/genie\.test\/v1\/channels\/media\//);
    expect(card.places[0]!.photo).toEqual({
      uri: expect.stringMatching(/^https:\/\/genie\.test\/v1\/channels\/media\//),
      attribution: '撮影者',
    });
    expect(card.places[1]!.photo).toBeUndefined();
    // 短命の写真 URL は取りに行かない（中継が LINE から呼ばれたときに取る）
    expect(asked.some((a) => a.url.includes('skipHttpRedirect'))).toBe(false);
  });
});
