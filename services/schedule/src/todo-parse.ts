/**
 * 締切のある「やること」を話し言葉から読む。**純粋関数。規則だけで決める**（モデルに当てさせない）。
 *
 *   「金曜までに見積書を出す」              → 追加「見積書を出す」（金曜まで）
 *   「11/13までに請求書を送らないと」        → 追加「請求書を送る」
 *   「やることに追加: 資料作成 来週水曜まで」 → 追加「資料作成」
 *   「やることは？」「締切の一覧」           → 一覧
 *   「やること 1 終わった」「見積書出した」  → 済み（見積書は、まだ済んでいないやることと照らす）
 *   「やること 2 を消して」                  → 消す
 *
 * 予定（何時から）とは分ける。「金曜までに」は締切で、時刻は持たない（本人の設計 2026-11-05:
 * 「金曜日までに資料を完成させる」はタスクの締切、「木曜の14時から16時に資料を作る」は実行予定）。
 *
 * Genie に頼む言い方（「金曜までに調べて」）は読まない。それは Genie の仕事で、いつもの振り分けに任せる。
 * 読むのは、本人がやることとして言ったとき（「出す」「しないと」）と、「やることに追加」「覚えておいて」と
 * はっきり言ったとき、それに「これを金曜までにやって」（指すものは直前の話。決めるのは TodoService）だけ。
 */
import { normalizeNumbers } from './parse.js';
import { wallClock } from './time.js';

export interface DueDate {
  readonly year: number;
  readonly month: number;
  readonly day: number;
}

export type TodoRequest =
  | { readonly kind: 'add'; readonly title: string; readonly due: DueDate }
  /** 「これを金曜までにやって」: 何をかは直前の話から決める（ここでは決めない） */
  | { readonly kind: 'add-ref'; readonly due: DueDate }
  | { readonly kind: 'list' }
  | { readonly kind: 'done'; readonly ref: number | string }
  | { readonly kind: 'delete'; readonly ref: number };

const WEEKDAY: Readonly<Record<string, number>> = {
  日: 0,
  月: 1,
  火: 2,
  水: 3,
  木: 4,
  金: 5,
  土: 6,
};

const DUE_DAY =
  '今日中?|きょう中?|本日中?|明日中?|あした|あす|明後日|あさって|今週中|週末|月末|来週の?[日月火水木金土]曜日?|今週の?[日月火水木金土]曜日?|[日月火水木金土]曜日?|\\d{1,2}\\s*月\\s*\\d{1,2}\\s*日|\\d{1,2}\\s*/\\s*\\d{1,2}|\\d{1,2}\\s*日';

/** 「金曜までに」「11/13 まで」「明日が締切」「今週中に」 */
const DUE = new RegExp(
  `(?<day>${DUE_DAY})\\s*(?:の)?\\s*(?:(?:まで|迄)\\s*(?:に|には)?|(?:が|は)?\\s*(?:締め?切り?|〆切|期限)(?:で|の)?|(?<=中)\\s*に)`,
);

/** はっきり「やること」として置く言い方 */
const EXPLICIT =
  /(?:やること|ToDo|todo|TODO|タスク)\s*(?:に|へ)\s*(?:追加|入れ|いれ|登録)(?:て|して|しといて|ておいて|とい?て)?|(?:覚えて|おぼえて)(?:おいて|といて|て)|メモして|(?:締め?切り?|期限)\s*(?:を|として)?\s*(?:登録|管理)して/;

/** 本人がやることとして言った終わり方（「出す」「送らないと」「やらなきゃ」）。「〜して」「〜やって」は Genie への頼みなので含めない */
const SELF_ENDING =
  /(?:る|す|つ|う|く|ぐ|む|ぶ|ぬ)(?:こと)?$|(?:しないと|やらないと|ないと|なきゃ|なくちゃ|ねば|なければ(?:ならない|いけない)?|予定|つもり)$/;

/** Genie への頼み（調べて・作って・やって）。これは読まない */
const ASK_GENIE = /(?:て|で)(?:ください|下さい|ね|くれる|ほしい|欲しい)?$|お願い(?:します)?$/;

const DEICTIC = /^(?:これ|それ|あれ|この件|その件|これら|それら)$/;

/** 「これを金曜までにやって」「それ明日までにお願い」: 指すものと、やっておく頼み */
const DEICTIC_ASK =
  /^(?:これ|それ|あれ|この件|その件|これら|それら)\s*(?:を|は|も)?[、,]?\s*(?:やって|やっといて|やっておいて|進めて|片付けて|終わらせて|仕上げて|対応して|やること\s*に\s*(?:入れて|追加して))?\s*(?:おいて|ください|下さい|ね|ほしい)?\s*(?:お願い(?:します)?)?$/;

const LIST =
  /^(?:(?:今週|今日|明日|来週)の)?(?:やること|ToDo|todo|TODO|締め?切り?|〆切|期限)(?:の)?(?:一覧|リスト)?(?:は|を)?\s*(?:[?？]|見せて|みせて|教えて|おしえて|ある[?？]?|何[?？]?|なに[?？]?)?[。\s]*$/;

const DONE_VERB =
  '(?:終わった|おわった|終わりました|完了(?:した|しました)?|済んだ|すんだ|済ませた|済みました|できた|出来た|出した|送った|提出した|やった|片付けた|done)';
const DONE_BY_NUMBER = new RegExp(
  `^(?:やること|ToDo|todo)?\\s*(?<n>\\d{1,2})\\s*(?:番)?\\s*(?:を|は|が|、)?\\s*${DONE_VERB}[。！!\\s]*$`,
);
const DONE_BY_TITLE = new RegExp(
  `^(?<title>.{1,60}?)\\s*(?:を|は|が|、)?\\s*${DONE_VERB}[。！!\\s]*$`,
);
const DELETE =
  /^(?:やること|ToDo|todo)\s*(?<n>\d{1,2})\s*(?:番)?\s*(?:を)?\s*(?:消して|けして|削除して|取り消して|とりけして|やめる|やめて)[。！!\s]*$/;

export interface TodoParseContext {
  readonly now: number;
  readonly tz: string;
}

export function parseTodoRequest(rawText: string, context: TodoParseContext): TodoRequest | null {
  const text = normalizeNumbers(rawText.trim()).replace(/[／]/g, '/');
  if (!text || text.length > 200) return null;
  if (LIST.test(text)) return { kind: 'list' };
  const del = DELETE.exec(text);
  if (del?.groups) return { kind: 'delete', ref: Number(del.groups['n']) };
  const byNumber = DONE_BY_NUMBER.exec(text);
  if (byNumber?.groups) return { kind: 'done', ref: Number(byNumber.groups['n']) };

  const due = DUE.exec(text);
  if (!due?.groups) {
    // 「見積書出した」: 済んだ。どのやることかは、まだ済んでいないものと照らして決める（無ければ読まない）
    const byTitle = DONE_BY_TITLE.exec(text);
    return byTitle?.groups && !/[?？]/.test(text)
      ? { kind: 'done', ref: byTitle.groups['title']!.trim() }
      : null;
  }
  // 問いは頼みではない（「金曜までに出せる？」）
  if (/[?？]/.test(text)) return null;
  const explicit = EXPLICIT.test(text);
  const rest = `${text.slice(0, due.index)} ${text.slice(due.index + due[0].length)}`
    .replace(EXPLICIT, ' ')
    .replace(/[:：]/g, ' ')
    .replace(/[。．.！!、,\s]+$/g, '')
    .trim();
  if (DEICTIC_ASK.test(rest)) {
    const dueDate = resolveDue(due.groups['day']!.replace(/\s/g, ''), context);
    return dueDate ? { kind: 'add-ref', due: dueDate } : null;
  }
  if (!explicit) {
    if (ASK_GENIE.test(rest) || !SELF_ENDING.test(rest)) return null;
  }
  const title = tidyTitle(rest);
  if (!title) return null;
  const dueDate = resolveDue(due.groups['day']!.replace(/\s/g, ''), context);
  if (!dueDate) return null;
  // 「これを金曜までに出す」: 「これ」が何かはこの文に無い。直前の話から決める
  if (
    DEICTIC.test(title) ||
    /^(?:これ|それ|あれ|この件|その件|これら|それら)(?:を|は|も|、)/u.test(title)
  )
    return { kind: 'add-ref', due: dueDate };
  return { kind: 'add', title, due: dueDate };
}

/** 「見積書を送らないと」→「見積書を送る」、「資料作成をやる」→「資料作成をやる」 */
function tidyTitle(rest: string): string {
  return (
    rest
      .replace(/(?:を|の)?\s*(?:やること|ToDo|todo|タスク)$/u, '')
      .replace(/らないと$|らなきゃ$|らなくちゃ$/u, 'る')
      .replace(/さないと$|さなきゃ$|さなくちゃ$/u, 'す')
      .replace(/かないと$|かなきゃ$|かなくちゃ$/u, 'く')
      .replace(/わないと$|わなきゃ$|わなくちゃ$/u, 'う')
      .replace(/たないと$|たなきゃ$|たなくちゃ$/u, 'つ')
      .replace(/しないと$|しなきゃ$|しなくちゃ$/u, 'する')
      .replace(/(?:なければ(?:ならない|いけない)?|ねば)$/u, '')
      .replace(/(?:予定|つもり)$/u, '')
      .replace(/^(?:\s|は|を|に|の|、)+|(?:\s|は|を|に|の|と|、)+$/gu, '')
      // 日本語のあいだの空き（日付を外したあと）は詰める。英数字のあいだは 1 つ残す
      .replace(/\s+/g, ' ')
      .replace(/(?<=[^\x20-\x7e]) | (?=[^\x20-\x7e])/gu, '')
      .trim()
      .slice(0, 120)
  );
}

function resolveDue(word: string, context: TodoParseContext): DueDate | null {
  const now = wallClock(context.now, context.tz);
  const plus = (days: number): DueDate => {
    const d = new Date(Date.UTC(now.year, now.month - 1, now.day + days));
    return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
  };
  const w = word.replace(/中$/, '');
  if (/^(?:今日|きょう|本日)$/.test(w)) return plus(0);
  if (/^(?:明日|あした|あす)$/.test(w)) return plus(1);
  if (/^(?:明後日|あさって)$/.test(w)) return plus(2);
  // 今週中: 金曜（もう土日なら日曜）。週末: 日曜
  if (w === '今週') return plus(now.weekday <= 5 ? 5 - now.weekday : (7 - now.weekday) % 7);
  if (w === '週末') return plus((7 - now.weekday) % 7);
  if (w === '月末') {
    const last = new Date(Date.UTC(now.year, now.month, 0));
    return { year: now.year, month: now.month, day: last.getUTCDate() };
  }
  const weekday = /^(来週|今週)?の?([日月火水木金土])曜日?$/.exec(w);
  if (weekday) {
    const target = WEEKDAY[weekday[2]!]!;
    const monday = -((now.weekday + 6) % 7);
    const fromMonday = (target + 6) % 7;
    if (weekday[1] === '来週') return plus(monday + 7 + fromMonday);
    if (weekday[1] === '今週') return plus(monday + fromMonday);
    return plus((target - now.weekday + 7) % 7);
  }
  const md = /^(\d{1,2})(?:月|\/)(\d{1,2})日?$/.exec(w);
  if (md) {
    const month = Number(md[1]);
    const day = Number(md[2]);
    if (month < 1 || month > 12 || day < 1 || day > 31) return null;
    const passed = month < now.month || (month === now.month && day < now.day);
    return valid({ year: now.year + (passed ? 1 : 0), month, day });
  }
  const d = /^(\d{1,2})日$/.exec(w);
  if (d) {
    const day = Number(d[1]);
    if (day < 1 || day > 31) return null;
    return day < now.day
      ? valid(
          now.month === 12
            ? { year: now.year + 1, month: 1, day }
            : { year: now.year, month: now.month + 1, day },
        )
      : valid({ year: now.year, month: now.month, day });
  }
  return null;
}

/** 2/30 のような無い日は読まない */
function valid(d: DueDate): DueDate | null {
  const t = new Date(Date.UTC(d.year, d.month - 1, d.day));
  return t.getUTCMonth() === d.month - 1 ? d : null;
}

const DOW = ['日', '月', '火', '水', '木', '金', '土'] as const;

/** 「11/13(金)」 */
export function dueLabel(d: DueDate): string {
  const dow = new Date(Date.UTC(d.year, d.month - 1, d.day)).getUTCDay();
  return `${String(d.month)}/${String(d.day)}(${DOW[dow]!})`;
}

/** 'YYYY-MM-DD' */
export function dueIso(d: DueDate): string {
  return `${String(d.year)}-${String(d.month).padStart(2, '0')}-${String(d.day).padStart(2, '0')}`;
}

export function dueFromIso(iso: string): DueDate {
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  return { year: y!, month: m!, day: d! };
}
