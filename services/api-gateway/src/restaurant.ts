/**
 * お店探しから予約の手前まで（仕様 v1.0 ⑯ Goal Manager・② 質問を減らす・⑨ 表示の切替）。
 *
 *   「新橋でいい店ある？」 → 目的を作り、エリアがあればすぐ探す（ジャンル・人数・予算が無くても探す）
 *   「今日18時」          → 同じ目的の条件を足して、その時刻に開いている店で探し直す
 *   「2人」               → 人数を覚える（探し直さない）
 *   「予約したい」        → 日時と人数を引き継ぎ、店を選んでもらい、予約ページ・電話を出す（予約はまだしていないと言う）
 *
 * 目的は会話に 1 つ（conversation_goals、6 時間）。答えは短く、店はカード、次の一手はボタン（Quick Reply）。
 * 店の情報は Google Places から取ったものだけ。取れなければ、取れなかったと言う（作らない）。
 */
import { withTenant, type DbHandle } from '@genie/db';
import type { Place, PlacesSearch } from './places.js';

export interface RestaurantSlots {
  readonly area?: string;
  readonly date?: string;
  readonly time?: string;
  readonly party?: number;
  readonly budget?: number;
  readonly genre?: string;
  readonly privateRoom?: boolean;
  readonly chosen?: string;
  readonly wantsBooking?: boolean;
}

export interface RestaurantReply {
  readonly answer: string;
  readonly needsClarification: boolean;
  /** カードにする JSON（genie.places/v1・genie.booking/v1）。 */
  readonly card?: string;
  /** 次の一手のボタン（LINE の Quick Reply）。 */
  readonly choices?: readonly string[];
}

const GENRES = [
  '焼き鳥',
  '焼鳥',
  '居酒屋',
  '寿司',
  '鮨',
  'ラーメン',
  '焼肉',
  'イタリアン',
  'フレンチ',
  '中華',
  '和食',
  'カフェ',
  'バー',
  '蕎麦',
  'そば',
  'うどん',
  '天ぷら',
  'おでん',
  'もつ鍋',
  '韓国料理',
  'タイ料理',
  'ステーキ',
  'ハンバーガー',
  '定食',
  '海鮮',
  'ビストロ',
  'スペイン料理',
  'インド料理',
  'カレー',
  '鍋',
  'しゃぶしゃぶ',
  'すき焼き',
  'ワインバー',
];
const SHOP = new RegExp(
  `(?:いい|良い|よい|おすすめ|オススメ|美味しい|おいしい|うまい|安い|雰囲気の?いい)?\\s*(?:店|お店|おみせ|飲み屋|レストラン|ランチ|ディナー|飲める所|食べる所|${GENRES.join('|')})`,
);
const ASKING =
  /(ある|ない|教えて|探して|どこ|知らない|ないかな|ありますか|ない？|紹介|おすすめ|オススメ)/;
const WANT = /(飲みたい|食べたい|飲み行きたい|ご飯行きたい|ごはん行きたい)/;
const AREA = new RegExp(
  `([ぁ-んァ-ヶー一-龯A-Za-z0-9]{1,10}?)(?:駅)?\\s*(?:の?(?:あたり|周辺|付近|近く|界隈|辺))?\\s*(?:で|の)(?=\\s*(?:いい|良い|おすすめ|オススメ|美味しい|おいしい|安い|雰囲気|店|お店|飲み|食べ|ランチ|ディナー|ご飯|ごはん|${GENRES.join('|')}|[ぁ-んァ-ヶー一-龯]{0,6}(?:店|屋|料理)))`,
);
/** 店探しの途中でも、ほかの頼み（天気・ニュース・予定など）は、いつもの振り分けへ。 */
const OTHER =
  /(天気|気温|雨|ニュース|株|予定|スケジュール|家計簿|メール|リマインド|教えて.*(?:天気|ニュース))/;
const NOT_AREA = /^(?:今日|明日|今夜|今晩|夜|昼|近く|この辺|ここ|いい|どこか|どっか|なんか|何か)$/;
const BOOK =
  /(予約(?:したい|して|できる|お願い|する|取って|とって|可能)|予約で|席(?:取って|とって|空いて|ある))/;
const CANCEL = /^(?:やめる|やめた|やっぱいい|もういい|キャンセル|中止)[。!！\s]*$/;
const KANJI_NUM: Record<string, number> = {
  一: 1,
  二: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
  十: 10,
};

export interface ReadMessage {
  readonly start: boolean;
  readonly slots: Partial<RestaurantSlots>;
  readonly book: boolean;
  readonly cancel: boolean;
  readonly choose: number | string | null;
  readonly order: 'cheap' | 'reservable' | null;
}

const ymd = (d: { y: number; mo: number; d: number }) =>
  `${String(d.y)}-${String(d.mo).padStart(2, '0')}-${String(d.d).padStart(2, '0')}`;

/** 本人の時間帯の今日（年月日）。 */
export function todayIn(now: Date, timeZone: string) {
  const [y, mo, d] = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
    .format(now)
    .split('-')
    .map(Number) as [number, number, number];
  return { y, mo, d };
}

/** 1 通から、店探しの条件と動きを読む。純粋関数。 */
export function readRestaurantMessage(
  text: string,
  now: Date,
  timeZone: string,
  active: boolean,
): ReadMessage {
  const t = text.normalize('NFKC').trim();
  const slots: { -readonly [K in keyof RestaurantSlots]?: RestaurantSlots[K] } = {};
  const start =
    (SHOP.test(t) && (ASKING.test(t) || WANT.test(t) || /[？?]$/.test(t))) || WANT.test(t);
  if (start || active) {
    const area = AREA.exec(t)?.[1];
    if (area && !NOT_AREA.test(area) && !GENRES.includes(area)) slots.area = area;
  }
  const genre = GENRES.find((g) => t.includes(g));
  if (genre) slots.genre = genre === '焼鳥' ? '焼き鳥' : genre === '鮨' ? '寿司' : genre;
  if (/個室/.test(t)) slots.privateRoom = true;

  // 日時（「今日18時」「明日19時半」「今夜」「18:30」）
  const today = todayIn(now, timeZone);
  const shiftDay = (n: number) => {
    const d = new Date(Date.UTC(today.y, today.mo - 1, today.d + n));
    return ymd({ y: d.getUTCFullYear(), mo: d.getUTCMonth() + 1, d: d.getUTCDate() });
  };
  const weekday = /(月|火|水|木|金|土|日)\s*曜/.exec(t);
  if (weekday) {
    // 「土曜」は次の土曜（今日が土曜なら今日）
    const want = ['日', '月', '火', '水', '木', '金', '土'].indexOf(weekday[1]!);
    const dow = new Date(Date.UTC(today.y, today.mo - 1, today.d)).getUTCDay();
    slots.date = shiftDay((want - dow + 7) % 7);
  } else if (/明後日|あさって/.test(t)) slots.date = shiftDay(2);
  else if (/明日|あした|あす/.test(t)) slots.date = shiftDay(1);
  else if (/今日|きょう|今夜|今晩|今から/.test(t)) slots.date = shiftDay(0);
  const hm = /(\d{1,2})\s*(?:時|:)\s*(半|(\d{1,2})\s*分?)?/.exec(t);
  if (hm && !/(\d{1,2})\s*時間/.test(t)) {
    let h = Number(hm[1]);
    if (h <= 11 && /(夜|夕方|午後|pm)/i.test(t)) h += 12;
    const m = hm[2] === '半' ? 30 : hm[3] ? Number(hm[3]) : 0;
    if (h <= 23 && m <= 59)
      slots.time = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  } else if (/今夜|今晩/.test(t)) slots.time = '19:00';
  else if (/夕方/.test(t)) slots.time = '17:00';
  else if (/(?<!今)夜/.test(t)) slots.time = '19:00';
  else if (/お昼|ランチ|昼/.test(t)) slots.time = '12:00';
  if (slots.time && !slots.date) slots.date = shiftDay(0);

  // 人数（「2人」「ふたり」「3〜4人」「二名」）
  const people = /(\d{1,2})\s*(?:〜|~|-|ー)?\s*(\d{1,2})?\s*(?:人|名)/.exec(t);
  if (people) slots.party = Number(people[2] ?? people[1]);
  else if (/ひとり|一人|1人|おひとり/.test(t)) slots.party = 1;
  else if (/ふたり|二人/.test(t)) slots.party = 2;
  else {
    const k = /([一二三四五六七八九十])\s*(?:人|名)/.exec(t);
    if (k && KANJI_NUM[k[1]!] !== undefined) slots.party = KANJI_NUM[k[1]!]!;
  }

  // 予算（「5000円くらい」「予算5千円」「1万円」）
  const yen = /([\d,]+)\s*円/.exec(t);
  const sen = /(\d+)\s*千円/.exec(t);
  const man = /(\d+)\s*万円?/.exec(t);
  if (yen) slots.budget = Number(yen[1]!.replace(/,/g, ''));
  else if (sen) slots.budget = Number(sen[1]) * 1000;
  else if (man && /予算|円|くらい|まで/.test(t)) slots.budget = Number(man[1]) * 10000;

  const choose = /(\d)\s*(?:番目?|つ目|件目)/.exec(t);
  return {
    start,
    slots,
    book: BOOK.test(t),
    cancel: active && CANCEL.test(t),
    choose: choose ? Number(choose[1]) : null,
    order: /安い順|安い店|安いところ/.test(t)
      ? 'cheap'
      : /予約できる/.test(t) && !BOOK.test(t.replace(/予約できる店/, ''))
        ? 'reservable'
        : null,
  };
}

/** 探すときの語。ジャンルが無ければ「おすすめの飲食店」、個室・予算は語に添える。 */
export function queryFor(s: RestaurantSlots): string {
  return [
    s.area,
    s.area && /駅$/.test(s.area) ? '' : '駅',
    s.genre === '遊べるスポット' ? '遊べる スポット' : (s.genre ?? 'おすすめ 飲食店'),
    s.privateRoom ? '個室' : '',
  ]
    .filter(Boolean)
    .join(' ');
}

const WEEK = ['日', '月', '火', '水', '木', '金', '土'];
export function whenLabel(s: RestaurantSlots, now: Date, timeZone: string): string {
  if (!s.date && !s.time) return '';
  const today = ymd(todayIn(now, timeZone));
  const [y, mo, d] = (s.date ?? today).split('-').map(Number) as [number, number, number];
  const dow = WEEK[new Date(Date.UTC(y, mo - 1, d)).getUTCDay()]!;
  const day = s.date === today ? '今日' : `${String(mo)}/${String(d)}（${dow}）`;
  return `${day}${s.time ? ` ${s.time.replace(/^0/, '')}` : ''}`;
}

/** 店の並びと絞り込み（開いていない店は外す。全部外れるなら残して、そう言う）。 */
function arrange(places: readonly Place[], s: RestaurantSlots, order: ReadMessage['order']) {
  let list = [...places];
  const open = list.filter((p) => p.openAt !== false);
  const closedAll = open.length === 0 && list.length > 0;
  if (!closedAll) list = open;
  if (s.budget) {
    const fit = list.filter((p) => p.priceFrom === null || p.priceFrom <= s.budget!);
    if (fit.length > 0) list = fit;
  }
  if (order === 'cheap') list.sort((a, b) => (a.priceFrom ?? 1e9) - (b.priceFrom ?? 1e9));
  if (order === 'reservable') {
    const r = list.filter((p) => p.reservable === true);
    if (r.length > 0) list = r;
  }
  return { list: list.slice(0, 5), closedAll };
}

interface Goal {
  readonly slots: RestaurantSlots;
  readonly results: readonly Place[];
}

export class RestaurantGoals {
  constructor(private readonly db: DbHandle) {}

  async get(tenantId: string, conversationId: string, now: Date): Promise<Goal | null> {
    const row = await withTenant(this.db, tenantId, (tx) =>
      tx
        .selectFrom('conversation_goals')
        .select(['slots', 'results', 'expires_at', 'status'])
        .where('conversation_id', '=', conversationId)
        .where('kind', '=', 'restaurant')
        .executeTakeFirst(),
    );
    if (!row || row.status !== 'active' || new Date(row.expires_at).getTime() < now.getTime())
      return null;
    return { slots: row.slots as RestaurantSlots, results: row.results as unknown as Place[] };
  }

  async save(
    tenantId: string,
    conversationId: string,
    goal: Goal,
    now: Date,
    status: 'active' | 'cancelled' = 'active',
  ) {
    const values = {
      tenant_id: tenantId,
      conversation_id: conversationId,
      kind: 'restaurant',
      status,
      slots: JSON.stringify(goal.slots),
      // 写真の URL は短命で、残さない（Google の条件。カードを出すときに取り直す）
      results: JSON.stringify(goal.results.map(({ photo: _photo, ...place }) => place)),
      expires_at: new Date(now.getTime() + 6 * 3600_000),
      updated_at: now,
    };
    await withTenant(this.db, tenantId, (tx) =>
      tx
        .insertInto('conversation_goals')
        .values(values)
        .onConflict((oc) =>
          oc.columns(['tenant_id', 'conversation_id']).doUpdateSet({
            kind: values.kind,
            status: values.status,
            slots: values.slots,
            results: values.results,
            expires_at: values.expires_at,
            updated_at: values.updated_at,
          }),
        )
        .execute(),
    );
  }
}

export interface RestaurantDeps {
  readonly goals: RestaurantGoals;
  readonly places: PlacesSearch;
  /** カードの地図・写真の中継（media.ts）。無ければ地図は付けない。 */
  readonly media?: Pick<import('./media.js').MediaResolver, 'link'>;
  readonly timeZone: string;
  readonly now?: () => Date;
}

/** 店探しの会話を 1 通進める。店探しでなければ null（いつもの振り分け）。 */
export async function restaurantTurn(
  deps: RestaurantDeps,
  principal: { tenantId: string; userId: string },
  conversationId: string,
  text: string,
  options: {
    /** グループの会話から拾った条件（「土曜」「夕方」「新宿」）。始めるときの下地にする。 */
    readonly seed?: Partial<RestaurantSlots>;
    /** 人数は、会話にいる人数から仮に置いた（答えでそう言う）。 */
    readonly partyAssumed?: boolean;
    /** 呼ばれた頼みなので、店の言葉が無くても（「いい感じの場所探して」）始める。 */
    readonly start?: boolean;
  } = {},
): Promise<RestaurantReply | null> {
  const now = deps.now?.() ?? new Date();
  const tz = deps.timeZone;
  const goal = await deps.goals.get(principal.tenantId, conversationId, now);
  const raw = readRestaurantMessage(text, now, tz, goal !== null);
  const read = options.start ? { ...raw, start: true } : raw;
  if (!goal && !read.start) return null;
  // 次の一手のボタン（Quick Reply）で送られてくる言葉
  const noBooking = /予約は?(?:不要|いらない|しない|なし)/.test(text);
  const otherShops = /(?:ほか|他|別)の(?:お)?店/.test(text);
  const otherArea = /(?:ほか|他|別)の(?:エリア|場所|駅)/.test(text);
  const changeTime = /時間を?変え/.test(text);
  const touched =
    Object.keys(read.slots).length > 0 ||
    read.book ||
    read.cancel ||
    read.choose !== null ||
    read.order ||
    noBooking ||
    otherShops ||
    otherArea ||
    changeTime;
  // 目的があっても、店探しと関係ない文（「明日の天気は？」）は、いつもの振り分けへ
  if (goal && !read.start && (!touched || OTHER.test(text))) return null;

  if (read.cancel) {
    await deps.goals.save(principal.tenantId, conversationId, goal!, now, 'cancelled');
    return { answer: 'お店探しはやめておくね。', needsClarification: false };
  }

  if (goal && noBooking)
    return {
      answer: 'りょうかい、予約なしだね。ほかにも探すときは言ってね。',
      needsClarification: false,
    };
  if (goal && otherArea)
    return {
      answer: 'どのあたりで探す？',
      needsClarification: true,
      choices: ['新橋', '新宿', '渋谷', '東京駅'],
    };
  if (goal && changeTime)
    return {
      answer: '何時にする？',
      needsClarification: true,
      choices: ['今日18時', '今日19時', '今日20時', '明日19時'],
    };
  if (goal && otherShops && goal.results.length > 0)
    return {
      answer: 'ほかの候補はこちら。',
      needsClarification: false,
      card: JSON.stringify({
        schema: 'genie.places/v1',
        text: `${goal.slots.area ?? ''}のお店の候補`,
        when: whenLabel(goal.slots, now, tz),
        party: goal.slots.party ?? null,
        places: goal.results.filter((p) => p.id !== goal.slots.chosen),
      }),
      choices: ['予約したい', '安い順', '個室がある店'],
    };

  // 新しく頼まれたら条件を作り直す（エリアが違う・始めの言葉がある）。続きなら足す
  const restart =
    read.start && (!goal || (read.slots.area !== undefined && read.slots.area !== goal.slots.area));
  const base: RestaurantSlots = restart ? { ...(options.seed ?? {}) } : (goal?.slots ?? {});
  const slots: RestaurantSlots = {
    ...base,
    ...read.slots,
    ...(read.book ? { wantsBooking: true } : {}),
  };
  let results = restart ? [] : (goal?.results ?? []);

  // 選んだ店（「2番目」「〇〇にする」）
  let chosen = slots.chosen;
  const pick = read.choose;
  if (typeof pick === 'number' && results[pick - 1]) chosen = results[pick - 1]!.id;
  const named = results.find(
    (p) => text.includes(p.name) || (p.name.length > 4 && text.includes(p.name.slice(0, 5))),
  );
  if (named) chosen = named.id;
  const next: RestaurantSlots = { ...slots, ...(chosen ? { chosen } : {}) };

  if (!next.area) {
    await deps.goals.save(principal.tenantId, conversationId, { slots: next, results }, now);
    return {
      answer: 'いいね！どのあたりで探す？（例:「新橋」「渋谷駅の近く」）',
      needsClarification: true,
      choices: ['新橋', '新宿', '渋谷', '東京駅'],
    };
  }

  // 探し直すのは、探す条件（エリア・ジャンル・個室・日時・予算）が変わったときだけ。人数・予約・選択では探さない
  const searchChanged =
    results.length === 0 ||
    ['area', 'genre', 'privateRoom', 'date', 'time', 'budget'].some(
      (k) =>
        (read.slots as Record<string, unknown>)[k] !== undefined &&
        (read.slots as Record<string, unknown>)[k] !== (base as Record<string, unknown>)[k],
    ) ||
    read.order !== null;
  const when = whenLabel(next, now, tz);
  if (searchChanged) {
    const at = next.time
      ? (() => {
          const [y, mo, d] = (next.date ?? ymd(todayIn(now, tz))).split('-').map(Number) as [
            number,
            number,
            number,
          ];
          const [h, m] = next.time.split(':').map(Number) as [number, number];
          return { weekday: new Date(Date.UTC(y, mo - 1, d)).getUTCDay(), minutes: h * 60 + m };
        })()
      : null;
    const found = await deps.places.search(principal.tenantId, {
      query: queryFor(next),
      month: ymd(todayIn(now, tz)).slice(0, 7),
      at,
    });
    if (found.kind !== 'ok') {
      await deps.goals.save(principal.tenantId, conversationId, { slots: next, results }, now);
      const why =
        found.reason === 'no_key'
          ? 'お店を探す設定（Google マップのキー）がまだ無いため、'
          : found.reason === 'limit'
            ? '今月のお店検索の上限に達したため、'
            : 'お店の検索がうまくいかなかったため、';
      return {
        answer: `${why}いまはお店の候補を出せません。お店の名前を作ることはしないので、時間をおいてもう一度送ってね。`,
        needsClarification: false,
      };
    }
    const { list, closedAll } = arrange(found.places, next, read.order);
    results = list;
    if (list.length === 0) {
      await deps.goals.save(principal.tenantId, conversationId, { slots: next, results }, now);
      return {
        answer: `${next.area}で${next.genre ?? 'お店'}が見つからなかったよ。ジャンルかエリアを変えてみる？`,
        needsClarification: true,
        choices: ['居酒屋', '焼き鳥', '和食', '別のエリア'],
      };
    }
    await deps.goals.save(principal.tenantId, conversationId, { slots: next, results }, now);
    const play = next.genre === '遊べるスポット';
    const lead = play
      ? `${next.area}で${when ? `${when}に` : ''}遊べる場所を探したよ！`
      : `${next.area}${next.genre ? `の${next.genre}` : ''}で${when ? `${when}に` : ''}${closedAll ? '' : when ? '開いている' : ''}お店を探したよ！`;
    const assumed =
      options.partyAssumed && next.party && restart
        ? `（人数は、この会話にいる ${String(next.party)} 人で仮に置いたよ。違ったら教えてね）`
        : '';
    const note = closedAll
      ? `（${when}に開いているか分かる店が無かったので、営業時間を確かめてね）`
      : '';
    // 候補の位置に番号を打った地図（gateway が中継する本物の地図。作れなければ付けない）
    const marked = list
      .map((p, i) => (p.location ? { ...p.location, label: String(i + 1) } : null))
      .filter((m): m is { lat: number; lng: number; label: string } => m !== null);
    const map =
      deps.media && marked.length > 0
        ? await deps.media
            .link(principal.tenantId, { kind: 'static_map', markers: marked })
            .catch(() => null)
        : null;
    const ask = !next.time
      ? { q: '何時ごろ行く？', c: ['今日18時', '今日19時', '明日19時'] }
      : !next.party
        ? { q: '何人で行く？', c: ['1人', '2人', '3〜4人', '予約は不要'] }
        : {
            q: '気になるお店があれば「予約したい」って送ってね。',
            c: ['予約したい', '安い順', '個室がある店'],
          };
    return {
      answer: `${lead}${note}${assumed}\n${ask.q}`,
      needsClarification: !next.time || !next.party,
      card: JSON.stringify({
        schema: 'genie.places/v1',
        text: lead,
        when,
        party: next.party ?? null,
        places: list,
        ...(map ? { map } : {}),
      }),
      choices: ask.c,
    };
  }

  // 予約（日時・人数を引き継ぐ。店が決まっていなければ選んでもらう）
  await deps.goals.save(principal.tenantId, conversationId, { slots: next, results }, now);
  if (next.wantsBooking) {
    if (!next.chosen) {
      const names = results.slice(0, 4).map((p, i) => `${String(i + 1)}. ${p.name}`);
      return {
        answer: `どのお店で予約する？\n${names.join('\n')}`,
        needsClarification: true,
        choices: results.slice(0, 4).map((_, i) => `${String(i + 1)}番目`),
      };
    }
    if (!next.party)
      return {
        answer: '何人で予約する？',
        needsClarification: true,
        choices: ['1人', '2人', '3人', '4人'],
      };
    const place = results.find((p) => p.id === next.chosen)!;
    const what = `${place.name}に${when ? `${when}・` : ''}${String(next.party)}人`;
    return {
      answer: `${what}で予約するなら、下の予約ページか電話からどうぞ。Genie はまだ予約していないよ。`,
      needsClarification: false,
      card: JSON.stringify({
        schema: 'genie.booking/v1',
        text: `${what}で予約`,
        place,
        when,
        party: next.party,
      }),
      choices: ['ほかのお店', '時間を変える'],
    };
  }
  if (read.slots.party !== undefined)
    return {
      answer: `${String(next.party)}人ね！予約するなら、お店を選んで「予約したい」って送ってね。`,
      needsClarification: false,
      choices: ['予約したい', ...results.slice(0, 3).map((_, i) => `${String(i + 1)}番目`)],
    };
  if (chosen && chosen !== base.chosen) {
    const place = results.find((p) => p.id === chosen)!;
    return {
      answer: `${place.name}だね！予約する？`,
      needsClarification: true,
      choices: ['予約したい', 'ほかのお店'],
    };
  }
  return null;
}
