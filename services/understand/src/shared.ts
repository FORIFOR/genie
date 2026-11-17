/**
 * 共有スペースの言い方（買い物リスト・TODO・日程の候補・写真の扱い）を読む。
 *
 * 予約・辞書と同じく **決まった言い方だけ** を読む（モデルは使わない。家族のグループの発言を外へ出さない）。
 * household が null のときは本人の個人のリスト（1:1 のトーク・Task Dock）。日程の候補はグループだけ。
 *
 *   買い物: 「牛乳を追加」「牛乳と卵を買い物リストに」「卵が切れた」「牛乳買った」「買ったよ」「買い物リスト」
 *   TODO  : 「ゴミ出しをTODOに追加」「ゴミ出しを私の担当にして」「ゴミ出し終わった」「TODO」
 *   日程  : 「旅行の日程調整 11/3 11/4 11/5」「3日と5日ならOK」「4日は無理」「日程どう？」「決めて」
 *   写真  : 「レシートを自動で読んで」「写真は読まないで」
 */
import {
  HouseholdStore,
  PollStore,
  ShoppingStore,
  TodoStore,
  normalize,
  type DatePoll,
  type ListScope,
} from './household.js';

export interface SharedContext extends ListScope {
  /** 話した人（LINE の userId と表示名）。個人のときは null でよい。 */
  readonly speaker: { readonly id: string; readonly name: string | null } | null;
}

export interface SharedSpaceDeps {
  readonly shopping: Pick<ShoppingStore, 'add' | 'open' | 'bought'>;
  readonly todos: Pick<TodoStore, 'add' | 'open' | 'find' | 'assign' | 'done'>;
  readonly polls: Pick<PollStore, 'create' | 'open' | 'vote' | 'tally' | 'close'>;
  readonly households: Pick<HouseholdStore, 'setAutoReceipts'>;
  readonly timeZone: string;
  readonly now?: () => number;
}

const END = /[。．.！!\s]+$/;
const LIST_SPLIT = /\s*(?:と|、|,|，|・|\s|&|＆)\s*/;

const SHOP_LIST =
  /^(?:買い物リスト|かいものリスト|買い物|買うもの|買う物|何(?:を)?買えば(?:いい)?)(?:を|は)?(?:見せて|教えて|出して|確認して)?[？?]?$/;
const SHOP_ADD_LIST =
  /^(.+?)(?:を|も)?[、,\s]*(?:買い物リスト|かいものリスト|リスト)に(?:追加|入れ|足し)?(?:て|して)?(?:おいて|といて)?[。!！]?$/;
/** 「買い物リストに卵と牛乳」（リストの名前が先。評価 2026-10-27 で届いていなかった）。 */
const SHOP_ADD_FRONT =
  /^(?:買い物リスト|かいものリスト)(?:に|へ)[、,\s]*(.+?)(?:を|も)?(?:追加|入れ|足し)?(?:て|して)?(?:おいて|といて)?[。!！]?$/;
const SHOP_ADD = /^(.+?)(?:を|も)(?:追加|足し)(?:て|して)?(?:おいて|といて)?$/;
const SHOP_OUT =
  /^(.+?)(?:が|も)?(?:ない|無い|切れた|切れてる|切れてた|なくなった|無くなった)(?:よ|わ|かも)?$/;
const SHOP_BOUGHT = /^(?:(.+?)(?:を|は|も)?)?(?:買った|買いました|かった|購入した)(?:よ|わ)?$/;
const TODO_LIST =
  /^(?:TODO|ToDo|todo|Todo|やること|タスク)(?:リスト)?(?:を|は)?(?:見せて|教えて|一覧)?[？?]?$/;
const TODO_ADD =
  /^(.+?)(?:を)?(?:TODO|ToDo|todo|Todo|やること)(?:リスト)?に(?:追加|入れ|し)(?:て|して)?(?:おいて|といて)?$/;
/** 「TODOに区役所で住民票」（リストの名前が先）。 */
const TODO_ADD_FRONT =
  /^(?:TODO|ToDo|todo|Todo|やること)(?:リスト)?(?:に|へ)[、,\s]*(.+?)(?:を)?(?:追加|入れ)?(?:て|して)?(?:おいて|といて)?[。!！]?$/;
const TODO_ASSIGN = /^(.+?)(?:を|は)(.+?)の(?:担当|当番)(?:に|で)(?:して|する)?$/;
const TODO_DONE =
  /^(.+?)(?:は|を|も)?(?:終わった|終わりました|おわった|やった|やりました|済んだ|済ませた|完了)(?:よ|わ)?$/;
const SELF = /^(?:私|わたし|僕|ぼく|俺|おれ|自分|あたし)$/;
const POLL_CREATE = /日程(?:調整|を決めたい|を決めよう|決め)/;
const POLL_DECIDE = /^(?:日程|日にち|日)?(?:を)?決めて$/;
const POLL_STATUS = /^(?:日程|候補|日程調整)(?:の)?(?:集計|状況|どう|どうなった)[？?]?$/;
const POLL_YES = /(?:OK|ok|オーケー|行ける|いける|行けます|大丈夫|空いてる|あいてる|参加|◯|○|可)/;
const POLL_NO = /(?:無理|むり|ダメ|だめ|行けない|いけない|NG|ng|✕|×|不可)/;
const POLL_ALL = /(?:全部|ぜんぶ|どれでも|いつでも)/;
const RECEIPTS_ON = /^(?:レシート|写真)(?:を|は)?自動で(?:読んで|登録して|付けて)$/;
const RECEIPTS_OFF = /^(?:レシート|写真)(?:を|は)?(?:読まないで|自動で読まないで|読むのをやめて)$/;
const HELP = /^(?:使い方|ヘルプ|help|何ができる[？?]?|なにができる[？?]?)$/i;

export const SHARED_HELP = [
  'このグループでは、次のことができます（@Genie を付けて送ってください）。',
  '・買い物: 「牛乳を追加」「卵が切れた」「牛乳買った」「買い物リスト」',
  '・TODO: 「ゴミ出しをTODOに追加」「ゴミ出しを私の担当にして」「ゴミ出し終わった」「TODO」',
  '・日程: 「旅行の日程調整 11/3 11/4 11/5」「3日と5日ならOK」「日程どう？」「決めて」',
  '・家計簿: レシートの写真、「家計簿を見せて」「食費の予算を6万円にして」',
  '・写真: 「レシートを自動で読んで」（@ なしの写真もレシートとして読みます）',
  '個人のメール・予定・ファイルは、このグループからは使いません。',
].join('\n');

export class SharedSpaceService {
  readonly #now: () => number;

  constructor(private readonly deps: SharedSpaceDeps) {
    this.#now = deps.now ?? Date.now;
  }

  /** 共有スペースの言い方なら答えを返す。違えば null。 */
  async handle(ctx: SharedContext, raw: string): Promise<string | null> {
    const text = raw.trim().replace(END, '');
    if (!text) return null;
    const by = ctx.speaker?.name ?? null;
    const group = ctx.householdId !== null;

    if (group && HELP.test(text)) return SHARED_HELP;
    if (group && RECEIPTS_ON.test(text)) {
      await this.deps.households.setAutoReceipts(ctx.tenantId, ctx.householdId!, true);
      return 'これから、このグループに送られた写真がレシートなら家計簿に付けます。やめるときは「@Genie 写真は読まないで」。';
    }
    if (group && RECEIPTS_OFF.test(text)) {
      await this.deps.households.setAutoReceipts(ctx.tenantId, ctx.householdId!, false);
      return '写真は、@Genie を付けて送られたときだけ読みます。';
    }

    // TODO（買い物より先に。「〜をTODOに追加」を買い物にしない）
    if (TODO_LIST.test(text)) return this.#todoList(ctx);
    const todoAdd = TODO_ADD.exec(text) ?? TODO_ADD_FRONT.exec(text);
    if (todoAdd) {
      const todo = await this.deps.todos.add(ctx, clean(todoAdd[1]!), null, by);
      return `TODO に「${todo.title}」を足しました。`;
    }
    const assign = TODO_ASSIGN.exec(text);
    if (assign) {
      const title = clean(assign[1]!);
      const who = SELF.test(clean(assign[2]!)) ? (by ?? 'わたし') : clean(assign[2]!);
      const found = await this.deps.todos.find(ctx, title);
      if (found) await this.deps.todos.assign(ctx, found.id, who);
      else await this.deps.todos.add(ctx, title, who, by);
      return `「${found?.title ?? title}」は${who}さんの担当にしました。`;
    }

    // 買い物
    if (SHOP_LIST.test(text)) return this.#shoppingList(ctx);
    const bought = SHOP_BOUGHT.exec(text);
    if (bought) {
      const said = bought[1] ? clean(bought[1]) : '';
      const all = !said || POLL_ALL.test(said);
      const names = await this.deps.shopping.bought(ctx, all ? null : items(said), by);
      if (names.length === 0) return all ? '買い物リストは空です。' : null;
      const rest = await this.deps.shopping.open(ctx);
      return `${names.join('・')}を買ったことにしました。${rest.length ? `残り: ${rest.map((i) => i.name).join('・')}` : '買い物リストは空になりました。'}`;
    }
    const add =
      SHOP_ADD_LIST.exec(text) ??
      SHOP_ADD_FRONT.exec(text) ??
      SHOP_OUT.exec(text) ??
      SHOP_ADD.exec(text);
    if (add) {
      const names = items(clean(add[1]!));
      if (names.length === 0) return null;
      const added = await this.deps.shopping.add(ctx, names, by);
      const open = await this.deps.shopping.open(ctx);
      return `${added.length ? `${added.join('・')}を買い物リストに足しました。` : 'もう買い物リストにあります。'}（${open.length} 件）`;
    }

    // 日程の候補（グループだけ）
    if (group) {
      const poll = await this.#poll(ctx, text);
      if (poll) return poll;
    }

    // 済んだ TODO（済んでいない TODO の名前と合うときだけ。「〜やった」を何でも TODO にしない）
    const done = TODO_DONE.exec(text);
    if (done) {
      const found = await this.deps.todos.find(ctx, clean(done[1]!));
      if (found) {
        await this.deps.todos.done(ctx, found.id, by);
        return `「${found.title}」を済みにしました。${by ? `ありがとう、${by}さん。` : ''}`;
      }
    }
    return null;
  }

  async #shoppingList(ctx: SharedContext): Promise<string> {
    const open = await this.deps.shopping.open(ctx);
    if (open.length === 0) return '買い物リストは空です。「牛乳を追加」のように送ると足します。';
    return [`買い物リスト（${open.length} 件）`, ...open.map((i) => `・${i.name}`)].join('\n');
  }

  async #todoList(ctx: SharedContext): Promise<string> {
    const open = await this.deps.todos.open(ctx);
    if (open.length === 0)
      return 'TODO はありません。「ゴミ出しをTODOに追加」のように送ると足します。';
    return [
      `TODO（${open.length} 件）`,
      ...open.map((t) => `・${t.title}${t.assignee ? `（${t.assignee}）` : ''}`),
    ].join('\n');
  }

  async #poll(ctx: SharedContext, text: string): Promise<string | null> {
    const householdId = ctx.householdId!;
    if (POLL_CREATE.test(text)) {
      const dates = parseDates(text, this.#today());
      if (dates.length < 2)
        return '候補の日を 2 つ以上付けてください（例: 「旅行の日程調整 11/3 11/4 11/5」）。';
      const title = clean(text.split(POLL_CREATE)[0]!.replace(/の$/, '')) || '日程';
      const poll = await this.deps.polls.create(
        ctx.tenantId,
        householdId,
        title,
        dates,
        ctx.speaker?.name ?? null,
      );
      return [
        `「${poll.title}」の候補: ${dates.map(dayLabel).join('、')}`,
        '行ける日を「@Genie 3日と5日ならOK」のように送ってください。集まったら「@Genie 決めて」。',
      ].join('\n');
    }
    const poll = await this.deps.polls.open(ctx.tenantId, householdId);
    if (!poll) return null;
    if (POLL_STATUS.test(text)) return this.#tallyText(ctx, poll);
    if (POLL_DECIDE.test(text)) {
      const { rows, voters } = await this.deps.polls.tally(ctx.tenantId, poll);
      if (voters === 0) return 'まだ誰も答えていません。行ける日を送ってもらってから決めます。';
      const best = [...rows].sort((a, b) => b.names.length - a.names.length)[0]!;
      if (best.names.length === 0)
        return 'どの候補も行ける人がいません。候補を出し直してください。';
      await this.deps.polls.close(ctx.tenantId, poll.id, best.date);
      return `「${poll.title}」は ${dayLabel(best.date)} に決めました（${best.names.length}/${voters} 人: ${best.names.join('・')}）。`;
    }
    const yes = POLL_YES.test(text);
    const no = POLL_NO.test(text);
    if (!yes && !no && !POLL_ALL.test(text)) return null;
    const said = matchCandidates(text, poll.candidates);
    let available: string[];
    if (POLL_ALL.test(text) && !no) available = [...poll.candidates];
    else if (no && !yes)
      available = said.length ? poll.candidates.filter((d) => !said.includes(d)) : [];
    else if (said.length) available = said;
    else return null;
    await this.deps.polls.vote(
      ctx.tenantId,
      poll.id,
      ctx.speaker?.id ?? 'unknown',
      ctx.speaker?.name ?? null,
      available,
    );
    return `${ctx.speaker?.name ? `${ctx.speaker.name}さん: ` : ''}${available.length ? `${available.map(dayLabel).join('、')} OK` : 'どれも難しい'}、と記録しました。`;
  }

  async #tallyText(ctx: SharedContext, poll: DatePoll): Promise<string> {
    const { rows, voters } = await this.deps.polls.tally(ctx.tenantId, poll);
    return [
      `「${poll.title}」（${voters} 人が回答）`,
      ...rows.map(
        (r) =>
          `・${dayLabel(r.date)}: ${r.names.length} 人${r.names.length ? `（${r.names.join('・')}）` : ''}`,
      ),
    ].join('\n');
  }

  #today(): string {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: this.deps.timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date(this.#now()));
  }
}

const clean = (s: string) =>
  s
    .trim()
    .replace(/^[「『"“]+|[」』"”]+$/g, '')
    .replace(/^(?:あと|それと|それから)\s*/, '')
    .trim();

/** 「牛乳と卵、パン」→ ["牛乳","卵","パン"]。 */
function items(s: string): string[] {
  const seen = new Set<string>();
  return s
    .split(LIST_SPLIT)
    .map((x) => clean(x))
    .filter((x) => x.length > 0 && x.length <= 100)
    .filter((x) => !seen.has(normalize(x)) && seen.add(normalize(x)));
}

/** 文の中の日付（11/3、11月3日、3日）を YYYY-MM-DD に。今日より前の月日は来年とみなす。 */
export function parseDates(text: string, today: string): string[] {
  const [ty, tm, td] = today.split('-').map(Number) as [number, number, number];
  const out: string[] = [];
  const push = (m: number, d: number) => {
    if (m < 1 || m > 12 || d < 1 || d > 31) return;
    let y = ty;
    if (m < tm || (m === tm && d < td)) y += 1;
    const iso = `${String(y)}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    if (!out.includes(iso)) out.push(iso);
  };
  const t = text.normalize('NFKC');
  const used: [number, number][] = [];
  for (const m of t.matchAll(/(\d{1,2})\s*[/月]\s*(\d{1,2})\s*日?/g)) {
    push(Number(m[1]), Number(m[2]));
    used.push([m.index, m.index + m[0].length]);
  }
  for (const m of t.matchAll(/(\d{1,2})\s*日/g)) {
    if (used.some(([a, b]) => m.index >= a && m.index < b)) continue;
    const d = Number(m[1]);
    // 日だけなら今月（今日より前なら来月）
    const month = d < td ? (tm % 12) + 1 : tm;
    push(month, d);
  }
  return out;
}

/** 候補のうち、文で言われた日（「3日」「11/3」）。 */
function matchCandidates(text: string, candidates: readonly string[]): string[] {
  const t = text.normalize('NFKC');
  return candidates.filter((iso) => {
    const [, m, d] = iso.split('-').map(Number) as [number, number, number];
    return (
      new RegExp(`(?:^|[^\\d])${String(m)}\\s*[/月]\\s*${String(d)}(?:[^\\d]|$)`).test(t) ||
      new RegExp(`(?:^|[^\\d/月])${String(d)}\\s*日`).test(t)
    );
  });
}

const WEEK = ['日', '月', '火', '水', '木', '金', '土'];
/** 2026-11-03 → 11/3（火） */
export function dayLabel(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number];
  const w = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return `${String(m)}/${String(d)}（${WEEK[w]!}）`;
}
