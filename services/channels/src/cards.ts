/**
 * 答えの中身に合わせた LINE の表示（仕様 v1.0 §3 response_surface）。**純粋関数。**
 *
 *   予定の一覧（genie.agenda/v1）   → 予定カード（時刻と題名を並べる）
 *   天気（genie.info/v1 weather）   → 天気カード（日ごとの空・最高/最低・降水確率）
 *   ニュース（genie.info/v1 news）  → 見出しの一覧と、開くボタン（3 つまで）
 *   仕事の見通し（genie.work/v1）   → 確認が必要なもの → 件数 → 仕事 5 件 → ホームを開くボタン
 *   電話の結果（genie.call/v1）     → 結果を先頭に（会話で確認済み・相手が辞退・要確認）、相手・商品
 *   承認（送信・変更の前）          → 確認カード（何がどう変わるか・押すボタン）
 *
 * 作れないとき（形が違う・大きすぎる）は null。呼ぶ側は文のメッセージに戻す。
 * 色は答えの吹き出し（rich.ts）と同じ暗い面。
 */

import {
  NEWS_MEDIA_LICENSES,
  resolveNewsImage,
  type MediaLicense,
  type NewsMedia,
} from '@genie/contracts';

const C = {
  background: '#2C2C2E',
  text: '#FFFFFF',
  muted: '#AEAEB2',
  accent: '#8AB4F8',
  rule: '#48484A',
  danger: '#FF6B6B',
} as const;

const MAX_BYTES = 20_000;
const text = (value: string, extra: Record<string, unknown> = {}) => ({
  type: 'text',
  text: value.trim() || ' ',
  wrap: true,
  color: C.text,
  ...extra,
});
const row = (left: string, right: string, extra: Record<string, unknown> = {}) => ({
  type: 'box',
  layout: 'horizontal',
  spacing: 'md',
  margin: 'md',
  contents: [
    text(left, { flex: 0, color: C.muted, size: 'sm', wrap: false }),
    text(right, { flex: 1, size: 'sm' }),
  ],
  ...extra,
});
const bubble = (
  title: string,
  body: Record<string, unknown>[],
  footer: Record<string, unknown>[] | null = null,
) => ({
  type: 'bubble',
  size: 'mega',
  styles: {
    header: { backgroundColor: C.background },
    body: { backgroundColor: C.background },
    ...(footer
      ? { footer: { backgroundColor: C.background, separator: true, separatorColor: C.rule } }
      : {}),
  },
  header: {
    type: 'box',
    layout: 'vertical',
    paddingBottom: '0px',
    contents: [text(title, { weight: 'bold', size: 'md' })],
  },
  body: { type: 'box', layout: 'vertical', contents: body },
  ...(footer
    ? { footer: { type: 'box', layout: 'vertical', spacing: 'sm', contents: footer } }
    : {}),
});
const flex = (altText: string, contents: unknown): Record<string, unknown> | null => {
  const message = {
    type: 'flex',
    altText: altText.replace(/\s+/g, ' ').trim().slice(0, 400) || 'Genie',
    contents,
  };
  return Buffer.byteLength(JSON.stringify(message), 'utf8') <= MAX_BYTES ? message : null;
};

const clock = (iso: string, timeZone: string) =>
  new Intl.DateTimeFormat('ja-JP', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(iso));

interface AgendaBody {
  readonly schema?: unknown;
  readonly label?: unknown;
  readonly text?: unknown;
  readonly events?: readonly {
    title?: unknown;
    start?: unknown;
    end?: unknown;
    allDay?: unknown;
  }[];
}

function agendaCard(card: AgendaBody, timeZone: string): Record<string, unknown> | null {
  const label = typeof card.label === 'string' ? card.label : '予定';
  const events = Array.isArray(card.events) ? card.events.slice(0, 12) : [];
  const said = typeof card.text === 'string' ? card.text : `${label}の予定`;
  const rows =
    events.length === 0
      ? [text('予定はありません。', { color: C.muted, size: 'sm' })]
      : events.map((e) => {
          const title = typeof e.title === 'string' && e.title ? e.title : '（題名なし）';
          const when =
            e.allDay === true || typeof e.start !== 'string' || typeof e.end !== 'string'
              ? '終日'
              : `${clock(e.start, timeZone)}–${clock(e.end, timeZone)}`;
          return row(when, title);
        });
  return flex(said, bubble(`${label}の予定（${String(events.length)} 件）`, rows));
}

interface InfoBody {
  readonly schema?: unknown;
  readonly kind?: unknown;
  readonly text?: unknown;
  readonly data?: {
    readonly place?: unknown;
    readonly current?: { temperature?: unknown; summary?: unknown } | null;
    readonly days?: readonly {
      label?: unknown;
      summary?: unknown;
      high?: unknown;
      low?: unknown;
      precipitation?: unknown;
    }[];
    readonly items?: readonly {
      title?: unknown;
      url?: unknown;
      source?: unknown;
      published_at?: unknown;
      summary?: unknown;
      category?: unknown;
      media?: unknown;
    }[];
    readonly topic?: unknown;
    readonly official?: unknown;
  } | null;
  readonly sources?: readonly { name?: unknown }[];
  readonly fetched_at?: unknown;
}

const num = (v: unknown, unit: string) =>
  typeof v === 'number' ? `${String(Math.round(v))}${unit}` : '–';

function weatherCard(info: InfoBody): Record<string, unknown> | null {
  const data = info.data;
  if (!data || !Array.isArray(data.days) || data.days.length === 0) return null;
  const place = typeof data.place === 'string' ? data.place : '';
  const said = typeof info.text === 'string' ? info.text : `${place}の天気`;
  const now =
    data.current && typeof data.current.temperature === 'number'
      ? [
          text(`いま ${num(data.current.temperature, '℃')} ${String(data.current.summary ?? '')}`, {
            size: 'sm',
            color: C.muted,
          }),
        ]
      : [];
  const days = data.days
    .slice(0, 7)
    .map((d) =>
      row(
        String(d.label ?? ''),
        `${String(d.summary ?? '')}　${num(d.high, '°')} / ${num(d.low, '°')}　☂ ${num(d.precipitation, '%')}`,
      ),
    );
  return flex(said, bubble(`${place}の天気`, [...now, ...days]));
}

/** 「10/27 11:51」（日付の時間帯で）。読めなければ null。 */
const stamp = (iso: unknown, timeZone: string): string | null => {
  if (typeof iso !== 'string') return null;
  const at = new Date(iso);
  if (Number.isNaN(at.valueOf())) return null;
  return new Intl.DateTimeFormat('ja-JP', {
    timeZone,
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(at);
};

/**
 * ニュース（本人の方針 2026-10-28）。1 記事 1 枚: 出典・公開日時・見出し・配信元のリード文・原文リンク。
 * 公開日時と、Genie が取りに行った日時を分けて出す。写真は出さない（使ってよいと示された記事画像が無いため。
 * 記事の画像を取って配り直さない）。リード文は配信元が RSS に載せたもので、Genie の要約ではない。
 */
/**
 * ニュースの分野とアイコン。分野は配信元の RSS の category か、本人が聞いた話題の語から。見出しからは推し量らない。
 * アイコンは絵文字（画像を取りに行かない。記事の写真ではないと分かる見た目）。
 */
const NEWS_CATEGORIES: readonly (readonly [RegExp, string, string])[] = [
  [/経済|ビジネス|株|為替|円相場|金利|日銀|景気|物価|決算|市場/, '経済', '💹'],
  [/テクノロジー|IT|ＩＴ|AI|ＡＩ|半導体|スマホ|ネット|技術/, 'テクノロジー', '💻'],
  [/科学|宇宙|医療|健康|文化/, '科学・文化', '🔬'],
  [/国際|海外|世界|アメリカ|米国|中国|欧州|ウクライナ|中東/, '国際', '🌐'],
  [/政治|選挙|国会|内閣|首相|政府/, '政治', '🏛️'],
  [/スポーツ|野球|サッカー|大リーグ|五輪|オリンピック|相撲/, 'スポーツ', '⚽'],
  [/天気|気象|台風|地震|災害|大雨|防災/, '天気・災害', '☂️'],
  [/暮らし|生活|くらし/, '暮らし', '🏠'],
  [/エンタメ|芸能|映画|音楽|ドラマ/, 'エンタメ', '🎬'],
  [/社会|事件|事故/, '社会', '🏙️'],
];

export function newsCategory(category: unknown, topic: unknown): { label: string; icon: string } {
  const from = (value: unknown) => {
    if (typeof value !== 'string' || !value.trim()) return null;
    const hit = NEWS_CATEGORIES.find(([re]) => re.test(value));
    return hit ? { label: hit[1], icon: hit[2] } : null;
  };
  // 配信元の分野が表に無ければ、その言葉のまま出す（言い換えない）
  if (typeof category === 'string' && category.trim())
    return from(category) ?? { label: category.trim().slice(0, 12), icon: '📰' };
  return from(topic) ?? { label: 'ニュース', icon: '📰' };
}

const INTENSITIES = ['1', '2', '3', '4', '5-', '5+', '6-', '6+', '7'] as const;
const intensityLabel = (v: string) => `震度${v.replace('-', '弱').replace('+', '強')}`;
const intensityColor = (rank: number) =>
  rank >= 6 ? C.danger : rank >= 4 ? '#F2B35E' : rank >= 2 ? C.accent : C.muted;

/**
 * 気象庁の最近の地震の図（地震の話題のときだけ）。気象庁の発表の数字（時刻・震央・M・最大震度）だけから作り、
 * 記事の図ではないこと・出典・取得時刻を添える。形が違えば null（図を出さない）。
 */
function quakeBubble(official: unknown, timeZone: string): Record<string, unknown> | null {
  const o = official as {
    kind?: unknown;
    source?: { name?: unknown; url?: unknown };
    fetched_at?: unknown;
    items?: unknown;
  } | null;
  if (!o || o.kind !== 'quakes' || o.source?.name !== '気象庁' || !Array.isArray(o.items))
    return null;
  const rows = o.items
    .map(
      (q) => q as { at?: unknown; place?: unknown; magnitude?: unknown; max_intensity?: unknown },
    )
    .filter(
      (q) =>
        typeof q.at === 'string' &&
        typeof q.place === 'string' &&
        (INTENSITIES as readonly unknown[]).includes(q.max_intensity),
    )
    .slice(0, 6);
  if (rows.length === 0) return null;
  const fetched = stamp(o.fetched_at, timeZone);
  const page = https(o.source.url);
  return {
    type: 'bubble',
    size: 'kilo',
    styles: { body: { backgroundColor: C.background }, footer: { backgroundColor: C.background } },
    body: {
      type: 'box',
      layout: 'vertical',
      spacing: 'md',
      contents: [
        text('🗾 最近の地震（気象庁の発表）', { weight: 'bold', size: 'sm' }),
        ...rows.map((q) => {
          const level = String(q.max_intensity);
          const rank = INTENSITIES.indexOf(level as (typeof INTENSITIES)[number]) + 1;
          const mag = typeof q.magnitude === 'number' ? ` M${q.magnitude.toFixed(1)}` : '';
          return {
            type: 'box',
            layout: 'vertical',
            spacing: 'xs',
            contents: [
              text(`${stamp(q.at, timeZone) ?? ''} ${String(q.place)}${mag}`, {
                size: 'xxs',
                color: C.muted,
              }),
              {
                type: 'box',
                layout: 'horizontal',
                spacing: 'sm',
                contents: [
                  {
                    type: 'box',
                    layout: 'vertical',
                    flex: 3,
                    contents: [
                      {
                        type: 'box',
                        layout: 'vertical',
                        width: `${String(Math.round((rank / INTENSITIES.length) * 100))}%`,
                        height: '10px',
                        cornerRadius: '4px',
                        backgroundColor: intensityColor(rank),
                        contents: [],
                      },
                    ],
                    justifyContent: 'center',
                  },
                  text(intensityLabel(level), { flex: 2, size: 'xs', align: 'end', wrap: false }),
                ],
              },
            ],
          };
        }),
        text(
          `気象庁の発表の数字から Genie が作った図です（記事の図ではありません）。${fetched ? `${fetched} 取得。` : ''}`,
          { size: 'xxs', color: C.muted, margin: 'md' },
        ),
      ],
    },
    ...(page
      ? {
          footer: {
            type: 'box',
            layout: 'vertical',
            contents: [
              {
                type: 'button',
                style: 'link',
                height: 'sm',
                color: C.accent,
                action: { type: 'uri', label: '気象庁で見る', uri: page },
              },
            ],
          },
        }
      : {}),
  };
}

/**
 * 気象庁の台風の図（台風の話題のときだけ）。時刻ごとに最大風速の棒と中心気圧・強さ・位置の地名。
 * 予報は「予報」と書く。気象庁の発表の数字だけから作り、記事の図ではないこと・発表時刻・出典を添える。
 */
function typhoonBubbles(official: unknown, timeZone: string): Record<string, unknown>[] {
  const o = official as {
    kind?: unknown;
    source?: { name?: unknown; url?: unknown };
    items?: unknown;
  } | null;
  if (!o || o.kind !== 'typhoons' || o.source?.name !== '気象庁' || !Array.isArray(o.items))
    return [];
  const page = https(o.source.url);
  return o.items.slice(0, 2).flatMap((raw) => {
    const t = raw as { number?: unknown; name?: unknown; issued_at?: unknown; points?: unknown };
    if (typeof t.number !== 'number' || !Array.isArray(t.points)) return [];
    const points = t.points
      .map(
        (p) =>
          p as {
            hours?: unknown;
            at?: unknown;
            location?: unknown;
            pressure_hpa?: unknown;
            wind_ms?: unknown;
            intensity?: unknown;
          },
      )
      .filter((p) => typeof p.hours === 'number' && typeof p.at === 'string')
      .slice(0, 6);
    if (points.length === 0) return [];
    const issued = stamp(t.issued_at, timeZone);
    const rows = points.map((p) => {
      const wind = typeof p.wind_ms === 'number' ? p.wind_ms : null;
      const facts = [
        typeof p.pressure_hpa === 'number' ? `${String(p.pressure_hpa)}hPa` : null,
        wind !== null ? `最大風速${String(wind)}m/s` : null,
        typeof p.intensity === 'string' ? p.intensity : null,
      ]
        .filter(Boolean)
        .join(' · ');
      return {
        type: 'box',
        layout: 'vertical',
        spacing: 'xs',
        contents: [
          text(
            `${p.hours === 0 ? '実況' : '予報'} ${stamp(p.at, timeZone) ?? ''}${typeof p.location === 'string' ? ` ${p.location}` : ''}`,
            { size: 'xxs', color: C.muted },
          ),
          ...(wind !== null
            ? [
                {
                  type: 'box',
                  layout: 'vertical',
                  width: `${String(Math.max(4, Math.min(100, Math.round((wind / 70) * 100))))}%`,
                  height: '8px',
                  cornerRadius: '4px',
                  // 予報は薄く（実況と見分ける）
                  backgroundColor: p.hours === 0 ? C.danger : '#F2B35E',
                  contents: [],
                },
              ]
            : []),
          ...(facts ? [text(facts, { size: 'xs' })] : []),
        ],
      };
    });
    const name = typeof t.name === 'string' && t.name ? `（${t.name}）` : '';
    return [
      {
        type: 'bubble',
        size: 'kilo',
        styles: {
          body: { backgroundColor: C.background },
          footer: { backgroundColor: C.background },
        },
        body: {
          type: 'box',
          layout: 'vertical',
          spacing: 'md',
          contents: [
            text(`🌀 台風第${String(t.number)}号${name}（気象庁の発表）`, {
              weight: 'bold',
              size: 'sm',
            }),
            ...rows,
            text(
              `気象庁の発表の数字から Genie が作った図です（記事の図ではありません）。${issued ? `${issued} 発表。` : ''}`,
              { size: 'xxs', color: C.muted, margin: 'md' },
            ),
          ],
        },
        ...(page
          ? {
              footer: {
                type: 'box',
                layout: 'vertical',
                contents: [
                  {
                    type: 'button',
                    style: 'link',
                    height: 'sm',
                    color: C.accent,
                    action: { type: 'uri', label: '気象庁で見る', uri: page },
                  },
                ],
              },
            }
          : {}),
      },
    ];
  });
}

export interface CardOptions {
  /** 画像の利用条件の台帳（既定は @genie/contracts の NEWS_MEDIA_LICENSES）。 */
  readonly ledger?: readonly MediaLicense[];
  readonly now?: Date;
}

function newsCard(
  info: InfoBody,
  timeZone: string,
  options: CardOptions = {},
): Record<string, unknown> | null {
  const items = Array.isArray(info.data?.items) ? info.data!.items!.slice(0, 5) : [];
  if (items.length === 0) return null;
  const said = typeof info.text === 'string' ? info.text : 'ニュース';
  const fetched = stamp(info.fetched_at, timeZone);
  const bubbles = items.map((item, i) => {
    const published = stamp(item.published_at, timeZone);
    const source = typeof item.source === 'string' && item.source ? item.source : null;
    const meta = [source, published ? `${published} 公開` : null].filter(Boolean).join(' · ');
    const url = https(item.url);
    const kind = newsCategory(item.category, info.data?.topic);
    // 写真は、台帳で LINE での配布が許された画像だけ。それ以外は分野のアイコン
    const image = resolveNewsImage(
      item.media as NewsMedia | null | undefined,
      'line_distribution',
      options.ledger ?? NEWS_MEDIA_LICENSES,
      options.now ?? new Date(),
    );
    const chip = {
      type: 'box',
      layout: 'horizontal',
      backgroundColor: C.rule,
      cornerRadius: '12px',
      paddingStart: '8px',
      paddingEnd: '8px',
      paddingTop: '2px',
      paddingBottom: '2px',
      width: `${String(Math.min(140, 32 + kind.label.length * 14))}px`,
      contents: [text(`${kind.icon} ${kind.label}`, { size: 'xs', wrap: false })],
    };
    return {
      type: 'bubble',
      size: 'kilo',
      styles: {
        ...(image.display === 'photo' ? { hero: { backgroundColor: C.background } } : {}),
        body: { backgroundColor: C.background },
        footer: { backgroundColor: C.background },
      },
      ...(image.display === 'photo'
        ? {
            hero: {
              type: 'image',
              url: image.url,
              size: 'full',
              aspectRatio: '20:13',
              // 切り抜かない（写真の一部を切ると、許諾の範囲・作者の同一性の問題になりうる。全体を収める）
              aspectMode: 'fit',
            },
          }
        : {}),
      body: {
        type: 'box',
        layout: 'vertical',
        spacing: 'sm',
        contents: [
          chip,
          ...(meta ? [text(meta, { size: 'xs', color: C.muted })] : []),
          text(`${String(i + 1)}. ${String(item.title ?? '')}`, { weight: 'bold', size: 'md' }),
          ...(typeof item.summary === 'string' && item.summary
            ? [text(item.summary, { size: 'sm', color: C.muted })]
            : []),
          ...(image.display === 'photo'
            ? [text(`写真: ${image.attribution}`, { size: 'xxs', color: C.muted, margin: 'md' })]
            : []),
        ],
      },
      ...(url
        ? {
            footer: {
              type: 'box',
              layout: 'vertical',
              contents: [
                {
                  type: 'button',
                  style: 'link',
                  height: 'sm',
                  color: C.accent,
                  action: { type: 'uri', label: '記事を開く', uri: url },
                },
              ],
            },
          }
        : {}),
    };
  });
  const quakes = quakeBubble(info.data?.official, timeZone);
  if (quakes) bubbles.unshift(quakes as (typeof bubbles)[number]);
  bubbles.unshift(...(typhoonBubbles(info.data?.official, timeZone) as typeof bubbles));
  const topic =
    typeof info.data?.topic === 'string' && info.data.topic ? `「${info.data.topic}」の` : '';
  const from = (info.sources ?? [])
    .map((x) => (typeof x.name === 'string' ? x.name : ''))
    .filter(Boolean)
    .join('・');
  bubbles.push({
    type: 'bubble',
    size: 'kilo',
    styles: { body: { backgroundColor: C.background } },
    body: {
      type: 'box',
      layout: 'vertical',
      justifyContent: 'center',
      spacing: 'sm',
      contents: [
        text(`${topic}ニュース`, { weight: 'bold', size: 'sm' }),
        text(
          [
            from
              ? `見出し・リード文は ${from} の配信です。`
              : '見出し・リード文は配信元のものです。',
            fetched ? `${fetched} に取得しました。` : '',
            '詳しくは記事で確かめてください。',
          ].join(''),
          { size: 'xs', color: C.muted },
        ),
      ],
    },
  } as never);
  return flex(said, { type: 'carousel', contents: bubbles });
}

interface PlaceBody {
  readonly id?: unknown;
  readonly name?: unknown;
  readonly kind?: unknown;
  readonly address?: unknown;
  readonly rating?: unknown;
  readonly ratingCount?: unknown;
  readonly priceFrom?: unknown;
  readonly priceTo?: unknown;
  readonly mapsUri?: unknown;
  readonly websiteUri?: unknown;
  readonly phone?: unknown;
  readonly reservable?: unknown;
  readonly openAt?: unknown;
  /** その店の Google マップの写真（gateway の places.ts が取った短命の URL と、撮った人）。 */
  readonly photo?: { readonly uri?: unknown; readonly attribution?: unknown };
}

const yen = (n: number) => `¥${n.toLocaleString('ja-JP')}`;
const https = (v: unknown) => (typeof v === 'string' && /^https:\/\//.test(v) ? v : null);
const tel = (v: unknown) =>
  typeof v === 'string' && /^[\d\-+() ]{6,20}$/.test(v) ? `tel:${v.replace(/[^\d+]/g, '')}` : null;

function placeBubble(p: PlaceBody, index: number, when: string): Record<string, unknown> {
  const facts: string[] = [];
  if (typeof p.rating === 'number')
    facts.push(
      `★${p.rating.toFixed(1)}${typeof p.ratingCount === 'number' ? `（${p.ratingCount.toLocaleString('ja-JP')}件）` : ''}`,
    );
  if (typeof p.priceFrom === 'number')
    facts.push(
      `${yen(p.priceFrom)}${typeof p.priceTo === 'number' ? `〜${yen(p.priceTo)}` : '〜'}`,
    );
  const open =
    p.openAt === true
      ? `${when} 営業時間内`
      : p.openAt === false
        ? `${when} は営業時間外かも`
        : when
          ? '営業時間は未確認'
          : '';
  const buttons = [
    https(p.mapsUri) ? { label: '地図', uri: https(p.mapsUri)! } : null,
    https(p.websiteUri)
      ? { label: p.reservable === true ? '予約ページ' : 'お店のサイト', uri: https(p.websiteUri)! }
      : null,
    tel(p.phone) ? { label: '電話', uri: tel(p.phone)! } : null,
  ].filter((b): b is { label: string; uri: string } => b !== null);
  // 写真は、その店に紐づいた Google マップの写真だけ（無ければ写真なしの札。作った画像では代えない）
  const photo = https(p.photo?.uri);
  const credit =
    photo && typeof p.photo?.attribution === 'string' && p.photo.attribution
      ? `写真: ${p.photo.attribution}（Google マップ）`
      : photo
        ? '写真: Google マップ'
        : null;
  return {
    type: 'bubble',
    size: 'kilo',
    styles: { body: { backgroundColor: C.background }, footer: { backgroundColor: C.background } },
    ...(photo
      ? {
          hero: {
            type: 'image',
            url: photo,
            size: 'full',
            aspectRatio: '20:13',
            aspectMode: 'cover',
            ...(https(p.mapsUri)
              ? { action: { type: 'uri', label: '地図', uri: https(p.mapsUri)! } }
              : {}),
          },
        }
      : {}),
    body: {
      type: 'box',
      layout: 'vertical',
      spacing: 'sm',
      contents: [
        text(`${String(index + 1)}. ${String(p.name ?? '')}`, { weight: 'bold', size: 'md' }),
        ...(typeof p.kind === 'string' ? [text(p.kind, { size: 'xs', color: C.muted })] : []),
        ...(facts.length ? [text(facts.join('　'), { size: 'sm' })] : []),
        ...(open
          ? [text(open, { size: 'xs', color: p.openAt === false ? C.danger : C.muted })]
          : []),
        ...(typeof p.address === 'string' ? [text(p.address, { size: 'xs', color: C.muted })] : []),
        ...(credit ? [text(credit, { size: 'xxs', color: C.muted })] : []),
      ],
    },
    ...(buttons.length
      ? {
          footer: {
            type: 'box',
            layout: 'horizontal',
            spacing: 'sm',
            contents: buttons.map((b) => ({
              type: 'button',
              style: 'link',
              height: 'sm',
              color: C.accent,
              action: { type: 'uri', label: b.label, uri: b.uri },
            })),
          },
        }
      : {}),
  };
}

function placesCard(body: {
  text?: unknown;
  when?: unknown;
  places?: readonly PlaceBody[];
  /** みんなの計画（Action Board）のリンク。グループで探したときだけ。 */
  board?: unknown;
  /** 候補の位置に番号を打った地図（gateway が中継する Google の地図）。 */
  map?: unknown;
}) {
  const places = Array.isArray(body.places) ? body.places.slice(0, 5) : [];
  if (places.length === 0) return null;
  const when = typeof body.when === 'string' ? body.when : '';
  const bubbles = places.map((p, i) => placeBubble(p, i, when));
  // 地図（番号は各カードの番号）。Google の地図そのもので、Genie が描いたものではない
  const map = https(body.map);
  if (map)
    bubbles.unshift({
      type: 'bubble',
      size: 'kilo',
      styles: { body: { backgroundColor: C.background } },
      hero: {
        type: 'image',
        url: map,
        size: 'full',
        aspectRatio: '20:13',
        aspectMode: 'cover',
        ...(https(body.board)
          ? { action: { type: 'uri', label: '計画', uri: https(body.board)! } }
          : {}),
      },
      body: {
        type: 'box',
        layout: 'vertical',
        spacing: 'xs',
        contents: [
          text('地図で見る', { weight: 'bold', size: 'md' }),
          text('番号は、このあとのカードの番号です。地図: Google', { size: 'xs', color: C.muted }),
        ],
      },
    } as never);
  // 情報の出どころ（仕様 v1.0 ⑩）。評価・営業時間は Google マップの情報で、空席は確かめていない
  bubbles.push({
    type: 'bubble',
    size: 'kilo',
    styles: { body: { backgroundColor: C.background } },
    body: {
      type: 'box',
      layout: 'vertical',
      justifyContent: 'center',
      contents: [
        text('評価・価格・営業時間は Google マップの情報です。空席はまだ確かめていません。', {
          size: 'xs',
          color: C.muted,
        }),
      ],
    },
    ...(https(body.board)
      ? {
          footer: {
            type: 'box',
            layout: 'vertical',
            contents: [
              {
                type: 'button',
                style: 'primary',
                height: 'sm',
                color: C.accent,
                action: { type: 'uri', label: 'みんなの計画を見る', uri: https(body.board)! },
              },
            ],
          },
        }
      : {}),
  } as never);
  return flex(typeof body.text === 'string' ? body.text : 'お店の候補', {
    type: 'carousel',
    contents: bubbles,
  });
}

function bookingCard(body: { text?: unknown; place?: PlaceBody; when?: unknown; party?: unknown }) {
  const p = body.place;
  if (!p) return null;
  const when = typeof body.when === 'string' ? body.when : '';
  const rows = [
    row('お店', String(p.name ?? '')),
    ...(when ? [row('日時', when)] : []),
    ...(typeof body.party === 'number' ? [row('人数', `${String(body.party)}人`)] : []),
    text('Genie はまだ予約していません。下から予約してください。', {
      size: 'xs',
      color: C.muted,
      margin: 'lg',
    }),
  ];
  const buttons = [
    https(p.websiteUri)
      ? {
          label: p.reservable === true ? '予約ページを開く' : 'お店のサイトを開く',
          uri: https(p.websiteUri)!,
          primary: true,
        }
      : null,
    tel(p.phone)
      ? { label: '電話で予約', uri: tel(p.phone)!, primary: !https(p.websiteUri) }
      : null,
    https(p.mapsUri) ? { label: '地図', uri: https(p.mapsUri)!, primary: false } : null,
  ]
    .filter((b): b is { label: string; uri: string; primary: boolean } => b !== null)
    .map((b) => ({
      type: 'button',
      style: b.primary ? 'primary' : 'secondary',
      height: 'sm',
      ...(b.primary ? { color: '#0A84FF' } : {}),
      action: { type: 'uri', label: b.label, uri: b.uri },
    }));
  return flex(
    typeof body.text === 'string' ? body.text : '予約',
    bubble('予約の準備', rows, buttons.length ? buttons : null),
  );
}

/** 結果の色。確認済みは緑、辞退は灰、要確認は注意の色（結果は Oathra の判定だけ。記録から推し量らない）。 */
const CALL_TONE: Record<string, string> = {
  succeeded: '#4CC79A',
  declined: C.muted,
  needs_review: '#F2B35E',
};
const CALL_LABEL: Record<string, string> = {
  succeeded: '会話で確認済み',
  declined: '相手が辞退',
  needs_review: '要確認',
};

function callCard(body: {
  text?: unknown;
  outcome?: unknown;
  headline?: unknown;
  note?: unknown;
  target?: unknown;
  product?: unknown;
  turns?: unknown;
  homeUrl?: unknown;
}) {
  const outcome = typeof body.outcome === 'string' ? body.outcome : '';
  if (!CALL_LABEL[outcome] || typeof body.headline !== 'string') return null;
  const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.slice(0, 200) : null);
  const target = str(body.target);
  const product = str(body.product);
  const note = str(body.note);
  const rows = [
    text(CALL_LABEL[outcome]!, { weight: 'bold', size: 'lg', color: CALL_TONE[outcome] }),
    text(body.headline.slice(0, 200), { size: 'sm', margin: 'sm' }),
    ...(target ? [row('相手', target)] : []),
    ...(product ? [row('商品', product)] : []),
    ...(typeof body.turns === 'number' && body.turns > 0
      ? [row('記録', `会話 ${String(body.turns)} 発言（Genie の作業一覧で読めます）`)]
      : []),
    ...(note ? [text(note, { size: 'xs', color: C.muted, margin: 'lg' })] : []),
  ];
  const home = https(body.homeUrl);
  return flex(
    typeof body.text === 'string' ? body.text : '電話の結果',
    bubble(
      '電話の結果',
      rows,
      home
        ? [
            {
              type: 'button',
              style: 'secondary',
              height: 'sm',
              action: { type: 'uri', label: '仕事のホームで見る', uri: home },
            },
          ]
        : null,
    ),
  );
}

const WORK_TONE: Record<string, string> = {
  needs: '#F2B35E',
  moving: C.accent,
  quiet: C.muted,
  done: '#4CC79A',
};

function workCard(body: {
  text?: unknown;
  counts?: { running?: unknown; needsUser?: unknown; doneToday?: unknown };
  attention?: unknown;
  items?: unknown;
  homeUrl?: unknown;
}) {
  const c = body.counts;
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? String(v) : null);
  const [running, needs, done] = [num(c?.running), num(c?.needsUser), num(c?.doneToday)];
  if (running === null || needs === null || done === null) return null;
  const attention = (Array.isArray(body.attention) ? body.attention : [])
    .filter((a): a is string => typeof a === 'string')
    .slice(0, 3);
  const items = (Array.isArray(body.items) ? body.items : [])
    .map((i) => i as { name?: unknown; state?: unknown; tone?: unknown })
    .filter((i) => typeof i.name === 'string' && typeof i.state === 'string')
    .slice(0, 5);
  const count = (value: string, label: string, color: string) => ({
    type: 'box',
    layout: 'vertical',
    flex: 1,
    contents: [
      text(value, { weight: 'bold', size: 'xl', color, align: 'center' }),
      text(label, { size: 'xxs', color: C.muted, align: 'center' }),
    ],
  });
  const rows: Record<string, unknown>[] = [
    // 確認が必要なものを先頭に。無ければ無いと言い切る
    attention.length > 0
      ? {
          type: 'box',
          layout: 'vertical',
          contents: [
            text(`あなたの確認が必要（${String(attention.length)} 件）`, {
              weight: 'bold',
              size: 'sm',
              color: WORK_TONE['needs'],
            }),
            ...attention.map((a) => text(`・${a.slice(0, 120)}`, { size: 'sm', margin: 'sm' })),
          ],
        }
      : text('確認が必要なものはありません。', { size: 'sm', color: WORK_TONE['done'] }),
    {
      type: 'box',
      layout: 'horizontal',
      margin: 'lg',
      contents: [
        count(running, '動いている', C.text),
        count(needs, '確認が必要', needs === '0' ? C.text : WORK_TONE['needs']!),
        count(done, '今日終わった', C.text),
      ],
    },
    ...(items.length > 0 ? [{ type: 'separator', margin: 'lg', color: C.rule }] : []),
    ...items.map((i) => ({
      type: 'box',
      layout: 'horizontal',
      spacing: 'md',
      margin: 'md',
      contents: [
        text(String(i.name).slice(0, 40), { flex: 3, size: 'sm', wrap: true }),
        text(String(i.state).slice(0, 60), {
          flex: 2,
          size: 'xs',
          color: WORK_TONE[String(i.tone)] ?? C.muted,
          align: 'end',
        }),
      ],
    })),
  ];
  const home = https(body.homeUrl);
  return flex(
    typeof body.text === 'string' ? body.text : '仕事の見通し',
    bubble(
      '仕事の見通し',
      rows,
      home
        ? [
            {
              type: 'button',
              style: 'secondary',
              height: 'sm',
              action: { type: 'uri', label: '仕事のホームを開く', uri: home },
            },
          ]
        : null,
    ),
  );
}

/** 成果物（JSON）から、予定・天気・ニュースのカード。違う形なら null。 */
export function cardFor(
  body: string,
  timeZone = 'Asia/Tokyo',
  options: CardOptions = {},
): Record<string, unknown> | null {
  const trimmed = body.trim();
  if (!trimmed.startsWith('{')) return null;
  let parsed: AgendaBody & InfoBody;
  try {
    parsed = JSON.parse(trimmed) as AgendaBody & InfoBody;
  } catch {
    return null;
  }
  if (parsed.schema === 'genie.agenda/v1') return agendaCard(parsed, timeZone);
  if (parsed.schema === 'genie.places/v1') return placesCard(parsed as never);
  if (parsed.schema === 'genie.booking/v1') return bookingCard(parsed as never);
  if (parsed.schema === 'genie.call/v1') return callCard(parsed as never);
  if (parsed.schema === 'genie.work/v1') return workCard(parsed as never);
  if (parsed.schema === 'genie.info/v1' && parsed.kind === 'weather') return weatherCard(parsed);
  if (parsed.schema === 'genie.info/v1' && parsed.kind === 'news')
    return newsCard(parsed, timeZone, options);
  return null;
}

/** 承認の確認カード。何がどう変わるか（details）と、押すボタン（postback・署名つき）。 */
export function approvalCard(
  approval: {
    readonly summary: string;
    readonly details: readonly { label: string; value: string }[];
  },
  buttons: readonly { label: string; value: string; style?: 'primary' | 'danger' }[],
  note: string,
): Record<string, unknown> | null {
  const body = [
    text(approval.summary, { size: 'sm' }),
    ...approval.details.slice(0, 8).map((d) => row(d.label, d.value.slice(0, 200))),
    text(note, { size: 'xs', color: C.muted, margin: 'lg' }),
  ];
  // Claude Code の承認は 5 つ（今回だけ・拒否・指示・セッション・プロジェクト）、質問は 6 つまで
  // （選択肢 4・文で答える・答えない）。Genie の仕事は 2 つ
  const footer = buttons.slice(0, 6).map((b) => ({
    type: 'button',
    style: b.style === 'primary' ? 'primary' : 'secondary',
    height: 'sm',
    ...(b.style === 'primary' ? { color: '#0A84FF' } : {}),
    action: {
      type: 'postback',
      label: b.label.slice(0, 20),
      data: b.value,
      displayText: b.label.slice(0, 20),
    },
  }));
  return flex(`確認してください：${approval.summary}`, bubble('確認してください', body, footer));
}
