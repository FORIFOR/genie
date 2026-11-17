/**
 * グループの会話を文脈として覚え、呼ばれたときだけ、その流れを踏まえて答える（本人の設計 2026-10-28）。
 *
 *   読む     … 使い始めたグループの発言は、すべて Webhook で届く
 *   覚える   … 設定が「覚える（context）」のときだけ。期限（既定 7 日）・送信の取り消し・「忘れて」で消す
 *   発言する … 呼ばれたときだけ（@Genie・「ジーニー、」で始まる・Genie の返事への引用返信）
 *
 * 覚えるのは本文と送り主の ID と時刻だけ。モデルは呼ばれたときだけ動かす（ふだんの発言は保存だけ）。
 * 個人の予定・メール・家計簿はグループの答えに使わない（材料はこのグループの会話だけ）。
 */
import { withTenant, type DbHandle } from '@genie/db';
import { syncOuting, type Board, type BoardStore } from './board.js';
import {
  readRestaurantMessage,
  restaurantTurn,
  type RestaurantDeps,
  type RestaurantReply,
  type RestaurantSlots,
} from './restaurant.js';

/** context: 会話を覚えて使う / mentions: 呼ばれた発言だけを使う（招かれた直後はこちら）。一時停止は別に持つ。 */
export type ContextMode = 'context' | 'mentions';

/** 「ジーニー、」「Genie」「@Genie」で始まる呼びかけ。 */
const NAME =
  /^\s*(?:@\s*)?(?:genie|ジーニー|じーにー|ジニー|ぢーにー)\s*(?:さん|くん)?[、,，:：\s!！]*/i;

const PAUSE = /(一時停止|黙って|だまって|静かに|休んで)/;
const RESUME = /(再開|戻って)/;
/** 会話の文脈を使う（覚え始める）。グループの誰かが決め、その返事で全員に知らせる。 */
const CONTEXT_ON = /(文脈を使|文脈理解|会話を覚えて|覚えていい|覚えてOK|流れを覚えて)/;
const SETTINGS = /^\s*(?:グループの?)?設定(?:を?(?:見せて|見る|教えて|確認))?\s*[？?]?$/;
/** 覚えていないと答えられない頼み（「さっきの話まとめて」）。 */
const PAST_TALK =
  /(さっき|今の話|いまの話|これまで|ここまで|今までの|みんなの話|会話を?まとめ|話をまとめ)/;
/** 本人の持ち物（予定・メール）。グループでは使わず、1:1 へ案内する。 */
const PERSONAL = /(メール|私の予定|自分の予定|僕の予定|俺の予定|カレンダー|スケジュール)/;
const FORGET = /(忘れて|わすれて|消して(?!.*(?:予定|リスト|TODO)))/;
const MENTIONS_ONLY = /(呼ばれたときだけ|呼んだときだけ|覚えないで)/;
const DAYS = /覚えるのは\s*(24\s*時間|1\s*日|7\s*日|一週間|1\s*週間|30\s*日|1\s*か月|ひと月)/;
const SUMMARY = /(まとめて|要約|整理して|おさらい)/;
const PLACE =
  /(場所|スポット|店|お店|飲み|ご飯|ごはん|ランチ|ディナー|遊べ|遊び|行くとこ|行く所|行くところ|どこ行|探して|さがして)/;
const PLAY = /(遊び|遊べ|遊ぶ|出かけ|でかけ|スポット|行くとこ|行く所|行くところ)/;

export interface GroupLine {
  readonly senderId: string;
  readonly text: string;
  readonly genie: boolean;
  readonly at: number;
}

export class GroupContextStore {
  constructor(private readonly db: DbHandle) {}

  async settings(tenantId: string, householdId: string) {
    const row = await withTenant(this.db, tenantId, (tx) =>
      tx
        .selectFrom('households')
        .select(['context_mode', 'context_days', 'context_paused', 'conversation_id'])
        .where('id', '=', householdId)
        .executeTakeFirst(),
    );
    return {
      mode: (row?.context_mode === 'context' ? 'context' : 'mentions') as ContextMode,
      days: row?.context_days ?? 7,
      paused: row?.context_paused ?? false,
      conversationId: row?.conversation_id ?? null,
    };
  }

  async set(
    tenantId: string,
    householdId: string,
    patch: { mode?: ContextMode; days?: 1 | 7 | 30; paused?: boolean; conversationId?: string },
  ) {
    await withTenant(this.db, tenantId, (tx) =>
      tx
        .updateTable('households')
        .set({
          ...(patch.mode ? { context_mode: patch.mode } : {}),
          ...(patch.days ? { context_days: patch.days } : {}),
          ...(patch.paused !== undefined ? { context_paused: patch.paused } : {}),
          ...(patch.conversationId ? { conversation_id: patch.conversationId } : {}),
        })
        .where('id', '=', householdId)
        .execute(),
    );
  }

  async remember(
    tenantId: string,
    householdId: string,
    line: {
      messageId: string;
      senderId: string;
      text: string;
      quotedId: string | null;
      at: number;
      genie: boolean;
    },
    days: number,
  ) {
    await withTenant(this.db, tenantId, (tx) =>
      tx
        .insertInto('group_messages')
        .values({
          tenant_id: tenantId,
          household_id: householdId,
          message_id: line.messageId.slice(0, 64),
          sender_id: line.senderId.slice(0, 64),
          text: line.text.slice(0, 2000),
          quoted_message_id: line.quotedId,
          from_genie: line.genie,
          sent_at: new Date(line.at),
          expires_at: new Date(line.at + days * 86_400_000),
        })
        .onConflict((oc) => oc.columns(['tenant_id', 'household_id', 'message_id']).doNothing())
        .execute()
        // 期限が過ぎた発言は、読むときに外すだけでなく消す（覚える期間を本当にする）
        .then(() =>
          tx
            .deleteFrom('group_messages')
            .where('household_id', '=', householdId)
            .where('expires_at', '<=', new Date(line.at))
            .execute(),
        ),
    );
  }

  async isGenie(tenantId: string, householdId: string, messageId: string): Promise<boolean> {
    const row = await withTenant(this.db, tenantId, (tx) =>
      tx
        .selectFrom('group_messages')
        .select('from_genie')
        .where('household_id', '=', householdId)
        .where('message_id', '=', messageId)
        .where('deleted_at', 'is', null)
        .executeTakeFirst(),
    );
    return row?.from_genie === true;
  }

  async forget(tenantId: string, householdId: string, messageId: string | null, now: Date) {
    await withTenant(this.db, tenantId, (tx) => {
      let q = tx
        .updateTable('group_messages')
        .set({ deleted_at: now, text: '' })
        .where('household_id', '=', householdId)
        .where('deleted_at', 'is', null);
      if (messageId) q = q.where('message_id', '=', messageId);
      return q.execute();
    });
  }

  /** 覚えている会話（新しいほうから limit 件を、古い順で）。期限切れ・取り消しは入れない。 */
  async recent(tenantId: string, householdId: string, now: Date, limit = 40): Promise<GroupLine[]> {
    const rows = await withTenant(this.db, tenantId, (tx) =>
      tx
        .selectFrom('group_messages')
        .select(['sender_id', 'text', 'from_genie', 'sent_at'])
        .where('household_id', '=', householdId)
        .where('deleted_at', 'is', null)
        .where('expires_at', '>', now)
        .orderBy('sent_at', 'desc')
        // 同じ時刻なら LINE のメッセージ ID の順（ID は送られた順に増える）
        .orderBy('message_id', 'desc')
        .limit(limit)
        .execute(),
    );
    return rows.reverse().map((r) => ({
      senderId: r.sender_id,
      text: r.text,
      genie: r.from_genie,
      at: new Date(r.sent_at).getTime(),
    }));
  }
}

/**
 * グループの 1 発言を見る。覚える設定なら覚え、呼ばれたか（名前・引用返信・メンション）を返す。
 * 呼びかけ（「ジーニー、」）は本文から外して返す。
 */
export async function observeGroup(
  store: GroupContextStore,
  space: { tenantId: string; householdId: string },
  message: {
    readonly messageId: string;
    readonly senderId: string;
    readonly text: string;
    readonly quotedId: string | null;
    readonly sentAt: number;
    readonly fromGenie: boolean;
    readonly mentioned?: boolean;
  },
): Promise<{ invoked: boolean; paused: boolean; text: string }> {
  const { mode, days, paused } = await store.settings(space.tenantId, space.householdId);
  const named = NAME.test(message.text);
  const text = named ? message.text.replace(NAME, '').trim() || '使い方' : message.text;
  const quotedGenie =
    message.quotedId !== null &&
    (await store.isGenie(space.tenantId, space.householdId, message.quotedId));
  const invoked = !message.fromGenie && (named || quotedGenie || message.mentioned === true);
  if (mode === 'context' && !paused)
    await store.remember(
      space.tenantId,
      space.householdId,
      {
        messageId: message.messageId,
        senderId: message.senderId,
        text: message.text,
        quotedId: message.quotedId,
        at: message.sentAt,
        genie: message.fromGenie,
      },
      days,
    );
  return { invoked, paused, text };
}

export interface GroupSettingReply {
  readonly text: string;
  readonly choices?: readonly string[];
}

const keepLabel = (days: number) => (days === 1 ? '24 時間' : `${String(days)} 日間`);

/** いまの設定（「@Genie 設定」）。誰でも見られ、そのままボタンで変えられる。 */
function settingsView(s: { mode: ContextMode; days: number; paused: boolean }): GroupSettingReply {
  const state = s.paused
    ? '一時停止中（会話を覚えず、話しかけません）'
    : s.mode === 'context'
      ? `会話の文脈を使う（このグループの会話を ${keepLabel(s.days)}覚えて、呼ばれたときに流れを踏まえて答えます）`
      : '呼ばれたときだけ（呼ばれた発言だけを使い、ふだんの会話は覚えません）';
  return {
    text: [
      `このグループの Genie の設定: ${state}`,
      'どの設定でも、話すのは「@Genie」「ジーニー、〜」と呼ばれたときだけです。個人の予定・メールは、このグループでは使いません。',
    ].join('\n'),
    choices: s.paused
      ? ['@Genie 再開']
      : s.mode === 'context'
        ? [
            '@Genie 呼ばれたときだけ',
            '@Genie 覚えるのは24時間',
            '@Genie 覚えるのは30日',
            '@Genie 忘れて',
            '@Genie 一時停止',
          ]
        : ['@Genie 会話の文脈を使う', '@Genie 一時停止'],
  };
}

/** 文脈を使い始めたことを、グループの全員に知らせる文（その返事がそのままグループに出る）。 */
const contextOnNotice = (days: number) =>
  `これからこのグループの会話を ${keepLabel(days)}覚えて、呼ばれたときに流れを踏まえて答えます（呼ばれなければ話しかけません）。止めるときは「@Genie 一時停止」、覚えた会話を消すときは「@Genie 忘れて」、覚えないようにするときは「@Genie 呼ばれたときだけ」。`;

/**
 * グループ設定の言い方（呼ばれたときだけ見る）。グループの誰でも確かめ・止められる。設定の言い方でなければ null。
 * 会話を覚え始めるのは、グループで「会話の文脈を使う」（または期間を決める）と言われたときだけで、そのことを全員に知らせる。
 */
export async function groupSettings(
  store: GroupContextStore,
  space: { tenantId: string; householdId: string },
  text: string,
  now: Date,
): Promise<GroupSettingReply | null> {
  const current = await store.settings(space.tenantId, space.householdId);
  if (SETTINGS.test(text)) return settingsView(current);
  if (MENTIONS_ONLY.test(text)) {
    await store.set(space.tenantId, space.householdId, { mode: 'mentions', paused: false });
    await store.forget(space.tenantId, space.householdId, null, now);
    return {
      text: 'これからは会話を覚えず、呼ばれたときの発言だけを使います。覚えていた会話は消しました。',
      choices: ['@Genie 会話の文脈を使う'],
    };
  }
  if (PAUSE.test(text)) {
    await store.set(space.tenantId, space.householdId, { paused: true });
    return {
      text: '一時停止しました。会話を覚えず、話しかけません。「@Genie 再開」で戻ります。',
      choices: ['@Genie 再開'],
    };
  }
  if (RESUME.test(text) && !CONTEXT_ON.test(text)) {
    await store.set(space.tenantId, space.householdId, { paused: false });
    return current.mode === 'context'
      ? { text: `再開しました。${contextOnNotice(current.days)}` }
      : {
          text: '再開しました。呼ばれたときにお返事します（ふだんの会話は覚えていません）。',
          choices: ['@Genie 会話の文脈を使う'],
        };
  }
  const days = DAYS.exec(text);
  if (days || CONTEXT_ON.test(text)) {
    const d = days
      ? /24|1\s*日/.test(days[1]!)
        ? 1
        : /30|か月|ひと月/.test(days[1]!)
          ? 30
          : 7
      : (current.days as 1 | 7 | 30);
    await store.set(space.tenantId, space.householdId, { mode: 'context', days: d, paused: false });
    return {
      text: contextOnNotice(d),
      choices: ['@Genie 覚えるのは24時間', '@Genie 覚えるのは30日', '@Genie 呼ばれたときだけ'],
    };
  }
  if (FORGET.test(text)) {
    await store.forget(space.tenantId, space.householdId, null, now);
    return { text: '覚えていたこのグループの会話を消しました。' };
  }
  return null;
}

/**
 * 雑談での場所の候補（「新宿か渋谷がいいな」「渋谷あたりどう？」）。候補は希望で、決定ではない。
 * 日時・人数・ふつうの言葉は場所にしない。
 */
const CANDIDATES =
  /([一-龯ァ-ヶー]{2,6}?)(?:駅)?\s*(?:か|と|or|・|、)\s*([一-龯ァ-ヶー]{2,6}?)(?:駅)?\s*(?:が|で|に|かな|あたり|辺り|どう|は|の)/;
const ONE_PLACE =
  /([一-龯ァ-ヶー]{2,6}?)(?:駅)?\s*(?:あたり|辺り|周辺|で|に|が)\s*(?:いい|良い|どう|しよう|集合|行こう|行きたい)/;
const NOT_PLACE =
  /^(?:今日|明日|明後日|今夜|夕方|夜|昼|朝|土曜|日曜|月曜|火曜|水曜|木曜|金曜|週末|来週|今週|場所|お店|店|時間|人数|予算|みんな|全員|ジーニー)$|曜$|日$|時$|人$/;

const DAY_WORD = /(今日|きょう|今夜|今晩|今から|明日|あした|あす|明後日|あさって|曜)/;

function placesIn(text: string): string[] {
  const t = text.normalize('NFKC');
  const two = CANDIDATES.exec(t);
  if (two) {
    const both = [two[1]!, two[2]!].filter((x) => !NOT_PLACE.test(x));
    if (both.length > 0) return both;
  }
  const one = ONE_PLACE.exec(t);
  return one && !NOT_PLACE.test(one[1]!) ? [one[1]!] : [];
}

/**
 * 会話から、場所探しの条件を拾う（古い順に重ねる。あとの発言が前の条件を上書きする）。
 * 場所の候補が複数なら、最初の候補で探し、ほかは候補として返す（決まったことにしない）。
 */
export function slotsFromConversation(lines: readonly GroupLine[], now: Date, timeZone: string) {
  let slots: Partial<RestaurantSlots> = {};
  let areas: string[] = [];
  const people = new Set<string>();
  for (const line of lines) {
    if (line.genie) continue;
    people.add(line.senderId);
    const read: Partial<RestaurantSlots> = readRestaurantMessage(
      line.text,
      now,
      timeZone,
      true,
    ).slots;
    // 「夕方からならいける」は時刻だけ。前の発言の日（「土曜」）を今日で上書きしない
    const { date, ...rest } = read;
    const dated = date !== undefined && (DAY_WORD.test(line.text) || !slots.date);
    slots = { ...slots, ...rest, ...(dated ? { date } : {}) };
    const found = placesIn(line.text);
    if (found.length > 0) areas = found;
  }
  if (!slots.area && areas.length > 0) slots = { ...slots, area: areas[0]! };
  return { slots, people: people.size, areas: slots.area === areas[0] ? areas : [] };
}

export interface GroupAssistantDeps {
  readonly store: GroupContextStore;
  readonly restaurants?: RestaurantDeps;
  /** グループの会話だけを材料にした答え（Claude）。無ければ null。 */
  readonly reply?: (input: {
    request: string;
    transcript: { speaker: string; text: string; genie: boolean }[];
    today: string;
  }) => Promise<string | null>;
  /** グループの目的（お店探しの途中など）を持つ会話。無ければ作る。 */
  readonly conversationFor: (space: {
    tenantId: string;
    householdId: string;
    ownerUserId: string;
  }) => Promise<string>;
  readonly timeZone: string;
  readonly now?: () => Date;
  /** グループの計画（Action Board）。無ければボードは作らない。 */
  readonly boards?: {
    readonly store: BoardStore;
    /** ボードを開くリンク（GENIE_PUBLIC_URL が無ければ null）。 */
    readonly urlFor: (token: string) => string | null;
  };
}

/** 「@Genie ボード」「@Genie 計画見せて」 */
const BOARD =
  /^(?:ボード|計画|みんなの計画)(?:を?(?:見せて|見る|開いて|開く|出して|教えて))?\s*[？?。]?$/;
const BOARD_CLOSE = /(?:計画|ボード)を?(?:終わる|終わりにする|終える|閉じる|やめる)/;
/** 「ジーニー、渋谷で」（候補の言い直し。場所の名前だけ）。 */
const BARE_AREA = /^([一-龯ァ-ヶー]{2,6})(?:駅)?\s*(?:で|に|にして|にしよう)\s*[。！!]?$/;

/** ボードを開くリンク（作れなければ null）。 */
async function boardLink(deps: NonNullable<GroupAssistantDeps['boards']>, board: Board, now: Date) {
  const probe = deps.urlFor('x');
  if (!probe) return null;
  return deps.urlFor(await deps.store.issueLink(board, now));
}

/**
 * 呼ばれた頼みに、このグループの会話を踏まえて答える。場所・お店は実際に探す。それ以外は会話だけを材料に答える。
 * 個人の予定・メール・家計簿は使わない。
 */
export async function groupAssistant(
  deps: GroupAssistantDeps,
  space: { tenantId: string; householdId: string; ownerUserId: string },
  request: string,
): Promise<string | RestaurantReply | null> {
  const now = deps.now?.() ?? new Date();
  // 本人の予定・メールは、グループでは使わない。本人との 1:1 へ案内する（その人の連携が要る）
  if (PERSONAL.test(request) && !PLACE.test(request))
    return {
      answer:
        '個人の予定やメールは、このグループでは使いません。Genie との 1:1 のトークで聞いてください（まだなら、Genie を友だちに追加して連携すると使えます）。',
      needsClarification: false,
    };
  const settings = await deps.store.settings(space.tenantId, space.householdId);
  if (settings.mode !== 'context' && PAST_TALK.test(request))
    return {
      answer:
        'いまは呼ばれた発言だけを使う設定なので、さっきの会話は覚えていません。まとめたい内容を貼って「@Genie まとめて」と送るか、「@Genie 会話の文脈を使う」で会話を覚えるようにできます（グループの全員にお知らせします）。',
      needsClarification: false,
      choices: ['@Genie 会話の文脈を使う'],
    };
  const lines = await deps.store.recent(space.tenantId, space.householdId, now);
  const owner = { tenantId: space.tenantId, userId: space.ownerUserId };

  // ボード（みんなの計画）を開く・終える
  if (deps.boards && (BOARD.test(request) || BOARD_CLOSE.test(request))) {
    const board = await deps.boards.store.current(space.tenantId, space.householdId);
    if (!board)
      return {
        answer:
          'まだ計画はありません。「ジーニー、いい感じの場所探して」や「@Genie 旅行の日程調整 12/5 12/6」で作ります。',
        needsClarification: false,
      };
    if (BOARD_CLOSE.test(request)) {
      await deps.boards.store.save(board, { status: 'closed' }, now);
      await deps.boards.store.event(board, 'closed', '計画を終えました', now);
      return { answer: `「${board.title}」の計画を終えました。`, needsClarification: false };
    }
    const url = await boardLink(deps.boards, board, now);
    return {
      answer: url
        ? `「${board.title}」のボードです。決まったこと・まだのこと・候補をまとめています。\n${url}`
        : 'ボードのリンクを作れません（運営者が GENIE_PUBLIC_URL を設定すると使えます）。',
      needsClarification: false,
    };
  }

  // 探している途中（「2番目にする」「4人」「予約したい」）か、場所・お店を頼まれた
  const asking =
    PLACE.test(request) || readRestaurantMessage(request, now, deps.timeZone, false).start;
  const bare = BARE_AREA.exec(request.normalize('NFKC').trim());
  if (deps.restaurants && (asking || bare || settings.conversationId)) {
    const conversationId = await deps.conversationFor(space);
    const active = await deps.restaurants.goals.get(space.tenantId, conversationId, now);
    // 「渋谷で」は、探し直しの言い方に直す（店探しの読み取りは「〜でいい〜」の形でエリアを読む）
    if (bare && (active || asking)) request = `${bare[1]!}でいい場所探して`;
    const start = asking || Boolean(bare && active);
    if (!start && !active) return groupReplyFrom(deps, lines, request, now);
    const { slots, people, areas } = slotsFromConversation(lines, now, deps.timeZone);
    const playing = PLAY.test(request) || lines.some((l) => !l.genie && PLAY.test(l.text));
    const seed: Partial<RestaurantSlots> = {
      ...slots,
      ...(playing && !slots.genre ? { genre: '遊べるスポット' } : {}),
      ...(slots.party === undefined && people >= 2 ? { party: people } : {}),
    };
    const partyAssumed = start && slots.party === undefined && people >= 2;
    const shop = await restaurantTurn(
      deps.restaurants,
      owner,
      conversationId,
      request,
      start ? { seed, partyAssumed, start: true } : {},
    );
    if (shop) {
      // 「新宿か渋谷」は希望。どちらで探したかと、もう一方への切り替え方を添える
      const others = areas.slice(1);
      const searched = !shop.needsClarification && shop.card !== undefined;
      const spokenArea = readRestaurantMessage(request, now, deps.timeZone, true).slots.area;
      let answer =
        searched && others.length > 0 && !spokenArea
          ? `${shop.answer}\n（${areas.join('か')}の話だったので、まず${areas[0]!}で探したよ。${others[0]!}なら「ジーニー、${others[0]!}で」）`
          : shop.answer;
      let card = shop.card;
      // ボードに映す（条件・候補・選んだ店）。候補のカードには「ボードで見る」を付ける
      const goal = deps.boards
        ? await deps.restaurants.goals.get(space.tenantId, conversationId, now)
        : null;
      if (deps.boards && goal && goal.results.length > 0) {
        const before = await deps.boards.store.current(space.tenantId, space.householdId);
        const board = await syncOuting(
          deps.boards.store,
          space,
          {
            slots: goal.slots,
            results: goal.results,
            areas: spokenArea ? [] : areas,
            partyAssumed,
          },
          now,
        );
        const url = await boardLink(deps.boards, board, now);
        if (url && card) {
          const parsed = JSON.parse(card) as Record<string, unknown>;
          if (parsed['schema'] === 'genie.places/v1')
            card = JSON.stringify({ ...parsed, board: url });
        }
        if (goal.slots.chosen && goal.slots.chosen !== before?.state.chosen)
          answer = `${answer}\n（みんなの計画にも「決まったこと」として載せました。「@Genie ボード」で見られます）`;
      }
      return { ...shop, answer, ...(card ? { card } : {}) };
    }
  }
  return groupReplyFrom(deps, lines, request, now);
}

/** 会話だけを材料に答える（Claude）。名前は「メンバーA」などに置き換える。 */
async function groupReplyFrom(
  deps: GroupAssistantDeps,
  lines: readonly GroupLine[],
  request: string,
  now: Date,
): Promise<string | null> {
  if (!deps.reply) return null;
  const speakers = new Map<string, string>();
  const transcript = lines.map((l) => {
    if (!speakers.has(l.senderId) && !l.genie)
      speakers.set(l.senderId, `メンバー${String.fromCharCode(65 + speakers.size)}`);
    return { speaker: l.genie ? 'Genie' : speakers.get(l.senderId)!, text: l.text, genie: l.genie };
  });
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: deps.timeZone }).format(now);
  const answer = await deps.reply({
    request: SUMMARY.test(request)
      ? `${request}（決まったこと・まだ決まっていないこと・次にやることに分けて）`
      : request,
    transcript,
    today,
  });
  return answer;
}
