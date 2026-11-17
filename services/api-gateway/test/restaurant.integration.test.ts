/**
 * お店探しから予約の手前まで（本人の合格基準 2026-10-27）:
 *   「新橋あたりでいい店ある？」→「今日18時」→「2人」→「予約したい」→「1番目」
 * 最初から説明し直さずに、実際の店の検索（Google Places の代役）と予約の準備まで進む。同じことを聞き返さない。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type TokenResponse, uuidv7 } from '@genie/contracts';
import { PlacesSearch } from '../src/places.js';
import { RestaurantGoals, restaurantTurn, type RestaurantDeps } from '../src/restaurant.js';
import { makeTestApp, makeTokens, testDbConfig, type TestApp } from './support.js';

const url = process.env['TEST_DATABASE_URL'];
// 2026-10-27（火）09:30 JST
const NOW = new Date('2026-10-27T00:30:00Z');

const place = (
  id: string,
  name: string,
  open: { from: number; to: number } | null,
  extra: Record<string, unknown> = {},
) => ({
  id,
  displayName: { text: name },
  shortFormattedAddress: '港区新橋2丁目',
  rating: 4.1,
  userRatingCount: 520,
  priceRange: { startPrice: { units: '3000' }, endPrice: { units: '4000' } },
  googleMapsUri: `https://maps.google.com/?cid=${id}`,
  websiteUri: `https://example.com/${id}`,
  nationalPhoneNumber: '03-1234-5678',
  reservable: true,
  primaryTypeDisplayName: { text: '居酒屋' },
  ...(open
    ? {
        regularOpeningHours: {
          periods: [
            {
              open: { day: 2, hour: open.from, minute: 0 },
              close: { day: 2, hour: open.to, minute: 0 },
            },
          ],
        },
      }
    : {}),
  ...extra,
});

describe.skipIf(!url)('finding a restaurant and getting ready to book', () => {
  let h: TestApp;
  let principal: { tenantId: string; userId: string };
  let conversationId: string;
  const queries: string[] = [];
  let deps: RestaurantDeps;
  let access: string;

  beforeAll(async () => {
    h = await makeTestApp({
      dbConfig: testDbConfig(url!, process.env['TEST_IDENTITY_DATABASE_URL']),
      tokens: await makeTokens(),
    });
    access = (
      await h.app.inject({
        method: 'POST',
        url: '/v1/auth/dev/token',
        payload: { email: `shop-${uuidv7()}@example.com`, display_name: 'Shop' },
      })
    ).json<TokenResponse>().access_token;
    const claims = JSON.parse(Buffer.from(access.split('.')[1]!, 'base64url').toString()) as {
      tid: string;
      sub: string;
    };
    principal = { tenantId: claims.tid, userId: claims.sub };
    conversationId = (
      await h.app.inject({
        method: 'POST',
        url: '/v1/conversations',
        headers: { authorization: `Bearer ${access}` },
        payload: {},
      })
    ).json<{ id: string }>().id;
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { textQuery: string };
      queries.push(body.textQuery);
      return Response.json({
        places: [
          place('p1', '焼き鳥 とり新', { from: 17, to: 23 }),
          place('p2', '昼だけ食堂', { from: 11, to: 15 }),
          place('p3', '新橋酒場', null, { reservable: false }),
        ],
      });
    }) as typeof fetch;
    deps = {
      goals: new RestaurantGoals(h.db),
      places: new PlacesSearch({ apiKey: 'test-key', monthlySearches: 300, db: h.db, fetchImpl }),
      timeZone: 'Asia/Tokyo',
      now: () => NOW,
    };
  });
  afterAll(async () => {
    await h?.close();
  });

  const say = (text: string) => restaurantTurn(deps, principal, conversationId, text);

  it('searches first, carries each short reply forward, and never asks the same thing twice', async () => {
    // 1. エリアだけで、すぐ探す（ジャンル・人数・予算を先に聞かない）
    const first = await say('新橋あたりでいい店ある？');
    expect(queries).toEqual(['新橋 駅 おすすめ 飲食店']);
    expect(first!.answer).toContain('新橋でお店を探したよ！');
    expect(first!.answer).toContain('何時ごろ行く？');
    expect(first!.answer).not.toMatch(/天気|降水/);
    expect(first!.choices).toEqual(['今日18時', '今日19時', '明日19時']);
    expect(JSON.parse(first!.card!)).toMatchObject({
      schema: 'genie.places/v1',
      places: [{ name: '焼き鳥 とり新' }, {}, {}],
    });

    // 2. 「今日18時」だけで、同じ目的の条件になり、その時刻に開いている店で探し直す。次は人数だけ聞く
    const second = await say('今日18時');
    expect(queries).toHaveLength(2);
    expect(second!.answer).toContain('今日 18:00に開いているお店を探したよ！');
    expect(second!.answer).toContain('何人で行く？');
    expect(second!.answer).not.toMatch(/ジャンル|予算|エリア/);
    const places = (
      JSON.parse(second!.card!) as { places: { name: string; openAt: boolean | null }[] }
    ).places;
    expect(places.map((p) => p.name)).toEqual(['焼き鳥 とり新', '新橋酒場']);
    expect(places[0]!.openAt).toBe(true);

    // 3. 人数は覚えるだけ（探し直さない）
    const third = await say('2人');
    expect(queries).toHaveLength(2);
    expect(third!.answer).toBe('2人ね！予約するなら、お店を選んで「予約したい」って送ってね。');

    // 4. 予約したい → 店を選んでもらう → 日時と人数を引き継いだ予約の準備（予約したとは言わない）
    const fourth = await say('予約したい');
    expect(fourth!.answer).toContain('どのお店で予約する？');
    expect(fourth!.choices).toEqual(['1番目', '2番目']);
    const fifth = await say('1番目');
    expect(fifth!.answer).toBe(
      '焼き鳥 とり新に今日 18:00・2人で予約するなら、下の予約ページか電話からどうぞ。Genie はまだ予約していないよ。',
    );
    expect(JSON.parse(fifth!.card!)).toMatchObject({
      schema: 'genie.booking/v1',
      when: '今日 18:00',
      party: 2,
      place: { id: 'p1' },
    });
    expect(queries).toHaveLength(2);

    // 目的の途中でも、関係ない話は普段の答えへ
    expect(await say('明日の天気は？')).toBeNull();
  });

  it('starts over for a new area, and says honestly when it cannot search', async () => {
    await say('渋谷で焼肉ある？');
    expect(queries.at(-1)).toBe('渋谷 駅 焼肉');
    const noKey: RestaurantDeps = {
      ...deps,
      places: new PlacesSearch({ apiKey: null, monthlySearches: 300, db: h.db }),
    };
    const reply = await restaurantTurn(noKey, principal, uuidv7(), '新宿でいい店ある？').catch(
      () => null,
    );
    // 会話の行が無い id でも、答えは「探せない」で止まる（店の名前は作らない）
    expect(reply === null || /いまはお店の候補を出せません/.test(reply.answer)).toBe(true);
    expect(await restaurantTurn(deps, principal, conversationId, 'おはよう')).toBeNull();
  });

  it('shows each shop’s own photo with its credit, sends the key only as a header, and keeps no photo URL', async () => {
    const asked: { url: string; key: string | null }[] = [];
    const photoFetch = (async (target: string, init?: RequestInit) => {
      const key = new Headers(init?.headers).get('x-goog-api-key');
      asked.push({ url: target, key });
      if (target.includes('/media'))
        return target.includes('places/p1/')
          ? Response.json({ name: 'x', photoUri: 'https://lh3.googleusercontent.com/p/p1-photo' })
          : new Response('', { status: 403 });
      return Response.json({
        places: [
          place('p1', '写真のある店', null, {
            photos: [
              { name: 'places/p1/photos/AAA', authorAttributions: [{ displayName: '撮った人' }] },
            ],
          }),
          place('p2', '写真が取れない店', null, { photos: [{ name: 'places/p2/photos/BBB' }] }),
          place('p3', '写真のない店', null),
        ],
      });
    }) as typeof fetch;
    const photoDeps: RestaurantDeps = {
      ...deps,
      places: new PlacesSearch({
        apiKey: 'test-key',
        monthlySearches: 300,
        db: h.db,
        fetchImpl: photoFetch,
      }),
    };
    const photoConversation = (
      await h.app.inject({
        method: 'POST',
        url: '/v1/conversations',
        headers: { authorization: `Bearer ${access}` },
        payload: {},
      })
    ).json<{ id: string }>().id;
    const reply = await restaurantTurn(
      photoDeps,
      principal,
      photoConversation,
      '新橋でいい店ある？',
    );
    const shown = (JSON.parse(reply!.card!) as { places: { name: string; photo?: unknown }[] })
      .places;
    expect(shown.map((p) => [p.name, p.photo ?? null])).toEqual([
      [
        '写真のある店',
        { uri: 'https://lh3.googleusercontent.com/p/p1-photo', attribution: '撮った人' },
      ],
      ['写真が取れない店', null],
      ['写真のない店', null],
    ]);
    // キーは見出しだけ（URL に載せない）。写真の名前以外は送らない
    expect(asked.every((a) => a.key === 'test-key' && !a.url.includes('test-key'))).toBe(true);
    expect(asked.filter((a) => a.url.includes('/media')).map((a) => a.url)).toEqual([
      'https://places.googleapis.com/v1/places/p1/photos/AAA/media?maxWidthPx=800&skipHttpRedirect=true',
      'https://places.googleapis.com/v1/places/p2/photos/BBB/media?maxWidthPx=800&skipHttpRedirect=true',
    ]);
    // 目的に残す候補には、写真の URL を入れない
    const kept = await photoDeps.goals.get(principal.tenantId, photoConversation, NOW);
    expect(JSON.stringify(kept)).not.toContain('googleusercontent');
  });
});
