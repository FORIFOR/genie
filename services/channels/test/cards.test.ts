/**
 * 答えに合わせた LINE の表示（仕様 v1.0 §3）。予定・天気・ニュースのカードと、承認の確認カード。
 */
import { describe, expect, it } from 'vitest';
import { channelMessages, lineMessages } from '../src/index.js';
import { approvalCard, cardFor, newsCategory } from '../src/cards.js';

const AGENDA = JSON.stringify({
  schema: 'genie.agenda/v1',
  text: '明日の予定は 2 件です。',
  label: '明日',
  events: [
    {
      id: 'e1',
      title: '定例ミーティング',
      start: '2026-10-28T10:00:00+09:00',
      end: '2026-10-28T11:00:00+09:00',
      allDay: false,
    },
    { id: 'e2', title: '誕生日', start: '2026-10-28', end: '2026-10-29', allDay: true },
  ],
});
const WEATHER = JSON.stringify({
  schema: 'genie.info/v1',
  kind: 'weather',
  text: '東京の明日は晴れ、最高 22℃です。',
  data: {
    place: '東京',
    current: null,
    days: [
      {
        label: '明日(水)',
        summary: '晴れ',
        high: 22.4,
        low: 14.1,
        precipitation: 10,
        code: 1,
        date: '2026-10-28',
      },
    ],
  },
  sources: [],
  fetched_at: '2026-10-27T00:00:00Z',
});
const NEWS = JSON.stringify({
  schema: 'genie.info/v1',
  kind: 'news',
  text: '主なニュースは 2 件です。',
  data: {
    topic: null,
    items: [
      {
        title: '見出し1',
        url: 'https://example.com/1',
        source: 'NHK',
        published_at: '2026-10-26T23:30:00Z',
        summary: '配信元のリード文。',
      },
      { title: '見出し2', url: 'http://insecure.example/2', source: null },
    ],
  },
  sources: [{ name: 'NHK', url: 'https://news.web.nhk/' }],
  fetched_at: '2026-10-27T00:00:00Z',
});

const flat = (x: unknown) => JSON.stringify(x);

describe('cards for answers', () => {
  it('draws the agenda with times and titles, and the spoken text as altText', () => {
    const card = cardFor(AGENDA)!;
    expect(card).toMatchObject({ type: 'flex', altText: '明日の予定は 2 件です。' });
    expect(flat(card)).toContain('明日の予定（2 件）');
    expect(flat(card)).toContain('10:00–11:00');
    expect(flat(card)).toContain('終日');
  });

  it('draws weather by day, and news with open buttons only for https links', () => {
    expect(flat(cardFor(WEATHER))).toContain('晴れ　22° / 14°　☂ 10%');
    const news = cardFor(NEWS)!;
    // 1 記事 1 枚: 出典と公開日時、見出し、配信元のリード文。取得した日時は別に出す。写真は出さない
    expect(flat(news)).toContain('"NHK · 10/27 08:30 公開"');
    expect(flat(news)).toContain('1. 見出し1');
    expect(flat(news)).toContain('配信元のリード文。');
    expect(flat(news)).toContain('見出し・リード文は NHK の配信です。10/27 09:00 に取得しました。');
    expect(flat(news)).not.toContain('"type":"image"');
    expect(flat(news).match(/"type":"uri"/g)).toHaveLength(1);
  });

  it('shows a place’s own Google Maps photo with its credit, never a made-up one, and the board button', () => {
    const card = cardFor(
      JSON.stringify({
        schema: 'genie.places/v1',
        text: '新宿のお店の候補',
        when: '今日 18:00',
        board: 'https://genie.test/v1/channels/board/' + 'B'.repeat(32),
        places: [
          {
            name: '新宿酒場',
            mapsUri: 'https://maps.google.com/?cid=1',
            photo: { uri: 'https://lh3.googleusercontent.com/p/abc', attribution: '山田 太郎' },
          },
          { name: '写真なし食堂', photo: { uri: 'http://insecure.example/x.jpg' } },
        ],
      }),
    )!;
    const [withPhoto, without, note] = (card['contents'] as { contents: Record<string, unknown>[] })
      .contents;
    expect(withPhoto!['hero']).toMatchObject({
      type: 'image',
      url: 'https://lh3.googleusercontent.com/p/abc',
      action: { type: 'uri', uri: 'https://maps.google.com/?cid=1' },
    });
    expect(JSON.stringify(withPhoto)).toContain('写真: 山田 太郎（Google マップ）');
    // https でない・無い写真は出さない（ほかの画像で代えない）
    expect(without!['hero']).toBeUndefined();
    expect(JSON.stringify(without)).not.toContain('写真:');
    expect(JSON.stringify(note)).toContain('みんなの計画を見る');
  });

  it('puts the numbered Google map first when there is one', () => {
    const card = cardFor(
      JSON.stringify({
        schema: 'genie.places/v1',
        text: '候補',
        map: 'https://genie.test/v1/channels/media/' + 'M'.repeat(32),
        places: [{ name: 'A' }],
      }),
    )!;
    const [first, second] = (card['contents'] as { contents: Record<string, unknown>[] }).contents;
    expect(first!['hero']).toMatchObject({
      type: 'image',
      url: expect.stringContaining('/media/'),
    });
    expect(JSON.stringify(first)).toContain('地図: Google');
    expect(JSON.stringify(second)).toContain('1. A');
    // https でない地図は出さない
    const plain = cardFor(
      JSON.stringify({ schema: 'genie.places/v1', map: 'http://x/y', places: [{ name: 'A' }] }),
    )!;
    expect(JSON.stringify(plain)).not.toContain('地図で見る');
  });

  it('falls back to text for other shapes', () => {
    expect(cardFor('ただの文')).toBeNull();
    expect(cardFor('{"schema":"other"}')).toBeNull();
    expect(lineMessages({ text: '予定です', card: '{"schema":"other"}' })).toEqual([
      { type: 'text', text: '予定です' },
    ]);
    expect(lineMessages({ text: '明日の予定は 2 件です。', card: AGENDA })[0]).toMatchObject({
      type: 'flex',
    });
  });

  it('shows what changes and the signed buttons on the confirmation card', () => {
    const [m] = lineMessages({
      text: '確認してください：予定を変更します',
      buttons: [
        { label: '変更する', value: 'a1.x.y', style: 'primary' },
        { label: 'やめる', value: 'a1.x.n', style: 'danger' },
      ],
      approval: {
        summary: '予定「定例」を 10:00〜11:00 → 14:00〜15:00 に変更します',
        details: [
          { label: '変更前', value: '10:00〜11:00' },
          { label: '変更後', value: '14:00〜15:00' },
        ],
        note: '押すまで実行しません。',
      },
    }) as Record<string, unknown>[];
    expect(m).toMatchObject({ type: 'flex' });
    expect(flat(m)).toContain('"data":"a1.x.y"');
    expect(flat(m)).toContain('変更後');
    expect(approvalCard({ summary: 's', details: [] }, [], 'n')).toMatchObject({ type: 'flex' });
  });
});

describe('the call result card', () => {
  const report = {
    outcome: 'succeeded' as const,
    headline: '資料をお送りすることについて、相手に確かめました。',
    note: '会話の中で確かめたことです。契約や予定の確定（ほかのシステムへの登録）までは含みません。',
    target: '田中',
    product: 'デモ商品',
    turns: 6,
  };

  it('puts the outcome first, then who and what, and keeps the transcript out', () => {
    const url = 'https://liff.line.me/1-a/w/' + 'T'.repeat(32);
    const message = channelMessages.callResult(report, url);
    expect(message.text.split('\n')[0]).toBe(
      '電話が終わりました：会話で確認済み。資料をお送りすることについて、相手に確かめました。',
    );
    const card = cardFor(message.card!)!;
    const json = JSON.stringify(card);
    const body = (card['contents'] as { body: { contents: { text?: string }[] } }).body.contents;
    expect(body[0]!.text).toBe('会話で確認済み');
    expect(json).toContain('"田中"');
    expect(json).toContain('"デモ商品"');
    expect(json).toContain('会話 6 発言');
    expect(json).toContain(url);
    // 予約・成約したとは書かない（Oathra の判定と、こちらの説明だけ）
    expect(json).not.toMatch(/予約しました|成約/);
  });

  it('says declined and needs-review plainly, and drops a non-https link', () => {
    for (const [outcome, label] of [
      ['declined', '相手が辞退'],
      ['needs_review', '要確認'],
    ] as const) {
      const card = cardFor(
        channelMessages.callResult({ ...report, outcome }, 'javascript:alert(1)').card!,
      )!;
      const body = (card['contents'] as { body: { contents: { text?: string }[] } }).body.contents;
      expect(body[0]!.text).toBe(label);
      expect(JSON.stringify(card)).not.toContain('javascript:');
    }
    expect(cardFor(JSON.stringify({ schema: 'genie.call/v1', outcome: 'booked' }))).toBeNull();
  });
});

describe('the work overview card', () => {
  const body = {
    schema: 'genie.work/v1',
    text: '確認が必要なものが 1 件あります。',
    counts: { running: 2, needsUser: 1, doneToday: 3 },
    attention: ['Claude Code（genie）が承認を待っています（3 分）'],
    items: [
      { name: 'Claude Code（genie）', state: '確認が必要', tone: 'needs' },
      { name: '「請求書の整理」', state: '進めています', tone: 'moving' },
    ],
    homeUrl: 'https://liff.line.me/1-a/w/' + 'T'.repeat(32),
  };

  it('leads with what needs the user, then counts, items and the home button', () => {
    const card = cardFor(JSON.stringify(body))!;
    const json = JSON.stringify(card);
    expect(json.indexOf('あなたの確認が必要（1 件）')).toBeLessThan(json.indexOf('動いている'));
    expect(json.indexOf('動いている')).toBeLessThan(json.indexOf('「請求書の整理」'));
    expect(json).toContain('仕事のホームを開く');
    expect(json).toContain(body.homeUrl);
  });

  it('says plainly when nothing needs the user, and refuses a broken body', () => {
    const json = JSON.stringify(
      cardFor(JSON.stringify({ ...body, attention: [], homeUrl: 'http://x.example/' })),
    );
    expect(json).toContain('確認が必要なものはありません。');
    expect(json).not.toContain('仕事のホームを開く');
    expect(cardFor(JSON.stringify({ schema: 'genie.work/v1', counts: {} }))).toBeNull();
  });
});

describe('news images and topic icons', () => {
  const news = (item: Record<string, unknown>, topic: string | null = null) =>
    JSON.stringify({
      schema: 'genie.info/v1',
      kind: 'news',
      text: 'ニュースです。',
      data: {
        topic,
        items: [{ title: '見出し', url: 'https://example.com/1', source: 'NHK', ...item }],
      },
      sources: [{ name: 'NHK', url: 'https://news.web.nhk/' }],
      fetched_at: '2026-10-27T00:00:00Z',
    });
  const ledger = [
    {
      id: 'lic-1',
      provider: 'Example Wire',
      imageHosts: ['images.example-wire.com'],
      allowedUses: ['line_distribution'] as const,
      attribution: 'Example Wire',
      validUntil: null,
    },
  ];
  const media = {
    image_url: 'https://images.example-wire.com/a.jpg',
    provider: 'Example Wire',
    license_id: 'lic-1',
  };
  const now = new Date('2026-10-29T00:00:00Z');
  const firstBubble = (card: Record<string, unknown> | null) =>
    (card!['contents'] as { contents: Record<string, unknown>[] }).contents[0]!;

  it('labels the topic from the feed or the asked topic, never from the headline', () => {
    expect(newsCategory('経済', null)).toEqual({ label: '経済', icon: '💹' });
    expect(newsCategory(null, '株価')).toEqual({ label: '経済', icon: '💹' });
    expect(newsCategory('地域', null)).toEqual({ label: '地域', icon: '📰' });
    expect(newsCategory(null, null)).toEqual({ label: 'ニュース', icon: '📰' });
    // 見出しに「株」があっても、分野は推し量らない
    const card = cardFor(news({ title: '株価が大きく下落' }));
    expect(flat(card)).toContain('📰 ニュース');
    expect(flat(cardFor(news({ category: '国際' })))).toContain('🌐 国際');
  });

  it('shows a photo with its credit only when the ledger allows LINE distribution', () => {
    const shown = firstBubble(cardFor(news({ media }), 'Asia/Tokyo', { ledger, now }));
    expect(shown['hero']).toMatchObject({ type: 'image', url: media.image_url, aspectMode: 'fit' });
    expect(flat(shown)).toContain('写真: Example Wire');

    // 台帳に無い・ほかの置き場所・既定の空の台帳 → 写真なし（アイコン）
    for (const card of [
      cardFor(news({ media }), 'Asia/Tokyo', { ledger: [], now }),
      cardFor(
        news({ media: { ...media, image_url: 'https://evil.example/a.jpg' } }),
        'Asia/Tokyo',
        {
          ledger,
          now,
        },
      ),
      cardFor(news({ media })),
    ]) {
      expect(firstBubble(card)['hero']).toBeUndefined();
      expect(flat(card)).not.toContain('images.example-wire.com');
      expect(flat(card)).toContain('📰 ニュース');
    }
  });
});

describe('the earthquake chart from JMA data', () => {
  const body = (official: unknown) =>
    JSON.stringify({
      schema: 'genie.info/v1',
      kind: 'news',
      text: '「地震」のニュースです。',
      data: {
        topic: '地震',
        items: [{ title: '見出し', url: 'https://example.com/1', source: '共同' }],
        official,
      },
      sources: [{ name: 'Google ニュース', url: 'https://news.google.com/' }],
      fetched_at: '2026-10-29T00:00:00Z',
    });
  const official = {
    kind: 'quakes',
    source: { name: '気象庁', url: 'https://www.jma.go.jp/bosai/map.html#contents=earthquake_map' },
    fetched_at: '2026-10-29T00:00:00Z',
    items: [
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
    ],
  };
  const bubbles = (card: Record<string, unknown> | null) =>
    (card!['contents'] as { contents: Record<string, unknown>[] }).contents;

  it('puts a chart made only from JMA numbers first, and says it is not the article figure', () => {
    const first = flat(bubbles(cardFor(body(official)))[0]);
    expect(first).toContain('最近の地震（気象庁の発表）');
    expect(first).toContain('千葉県北東部 M5.1');
    expect(first).toContain('震度5弱');
    expect(first).toContain('震度2');
    // 5弱は 9 段の 5 番目
    expect(first).toContain('"width":"56%"');
    expect(first).toContain('記事の図ではありません');
    expect(first).toContain('気象庁で見る');
  });

  it('draws no chart without official JMA data', () => {
    for (const bad of [
      undefined,
      { ...official, source: { name: 'どこか', url: 'https://x.example' } },
      { ...official, items: [{ at: 'x', place: 'y', max_intensity: '9' }] },
    ])
      expect(flat(cardFor(body(bad)))).not.toContain('最近の地震');
  });
});

describe('the typhoon chart from JMA data', () => {
  const official = {
    kind: 'typhoons',
    source: { name: '気象庁', url: 'https://www.jma.go.jp/bosai/map.html#contents=typhoon' },
    fetched_at: '2026-10-29T15:00:00Z',
    items: [
      {
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
            pressure_hpa: 950,
            wind_ms: 40,
            intensity: null,
          },
        ],
      },
    ],
  };
  const card = (o: unknown) =>
    cardFor(
      JSON.stringify({
        schema: 'genie.info/v1',
        kind: 'news',
        text: '「台風」のニュースです。',
        data: {
          topic: '台風',
          items: [{ title: '見出し', url: 'https://example.com/1' }],
          official: o,
        },
        sources: [],
        fetched_at: '2026-10-29T15:00:00Z',
      }),
    );

  it('marks the analysis and the forecasts, with wind bars and the issue time', () => {
    const first = flat((card(official)!['contents'] as { contents: unknown[] }).contents[0]);
    expect(first).toContain('台風第31号（インファ）（気象庁の発表）');
    expect(first).toContain('実況 10/29 21:00 南鳥島近海');
    expect(first).toContain('予報 10/30 09:00 マリアナ諸島');
    expect(first).toContain('940hPa · 最大風速45m/s · 非常に強い');
    expect(first).toContain('"width":"64%"');
    expect(first).toContain('記事の図ではありません');
    expect(first).toContain('10/29 21:45 発表');
  });

  it('draws nothing from a non-JMA or malformed source', () => {
    expect(flat(card({ ...official, source: { name: 'x' } }))).not.toContain('台風第');
    expect(flat(card({ ...official, items: [{ number: '31', points: [] }] }))).not.toContain(
      '台風第',
    );
  });
});
