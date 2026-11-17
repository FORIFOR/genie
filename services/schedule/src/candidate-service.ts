/**
 * 予定とやることの候補を、拾って見せ、本人が選んだものだけ入れる（本人の設計 2026-11-05
 * 「Genie Schedule Intelligence」: 抽出は自動、登録は承認制、抽出元の証拠を必ず残す）。
 *
 *   議事録を貼る（1 行目が「議事録」「会議メモ」…）、または「この中の予定と締切を拾って」+ 本文
 *     → 候補が 3 件見つかりました（まだ入れていません）
 *       予定 1. 次回の定例（11/11(水) 14:00〜15:00） 元の文:「…」
 *       やること 2. 見積書提出（11/6(金)まで） 元の文:「…」
 *   「全部入れて」「2 を入れて」「1と2を入れて」 → やることはそのまま置く。予定はカレンダーの確かめ（承認カード）へ
 *   「候補はいらない」 → 何も入れない
 *
 * 予定はカレンダーに書く前にいつもの確かめ（承認カード）を通す。1 回に回せる頼みは 1 つなので、
 * 予定は 1 件ずつ回す（2 件以上を選んだときは、やることだけ入れて、予定の番号を 1 つずつ送ってもらう）。
 */
import { extractCandidates, type Candidate } from './extract.js';
import type { CandidateSource, CandidateStore, StoredCandidate } from './candidate-store.js';
import { dueLabel } from './todo-parse.js';
import type { TodoService } from './todo-service.js';

export interface CandidateReply {
  readonly answer: string;
  readonly needsClarification: boolean;
  /** 予定 1 件をカレンダーに入れる頼み（いつもの振り分けで、確かめのカードを出す） */
  readonly request?: string;
}

/** 提案に答えられるあいだ */
export const ANSWER_WINDOW_MS = 24 * 3_600_000;

/** 「議事録」「会議メモ」で始まる貼り付け */
const MINUTES_HEAD =
  /^[\s【[(（]*(?:議事録|議事メモ|会議メモ|会議録|打ち?合わ?せメモ|打合せメモ|ミーティングメモ|MTG\s*メモ|面談メモ|minutes)/iu;
/** 「この中の予定と締切を拾って」 */
const EXTRACT_ASK =
  /(?:予定|やること|タスク|締め?切り?|期限|日程)[^\n]{0,16}?(?:拾って|ひろって|抜き出して|抽出して|見つけて|探して|拾い出して)/u;
const ALL =
  /^(?:候補\s*(?:は|を)?\s*)?(?:全部|ぜんぶ|すべて|全て|両方|どれも)\s*(?:を)?\s*(?:入れて|いれて|追加して|登録して|お願い|おねがい)(?:ください|下さい|おいて)?[。！!\s]*$/u;
const NUMBERS =
  /^(?:候補\s*(?:の)?\s*)?(?<nums>\d{1,2}(?:\s*(?:番)?\s*(?:と|、|,|・|\s|\+)\s*\d{1,2})*)\s*(?:番)?\s*(?:を|も|だけ)?\s*(?:入れて|いれて|追加して|登録して|お願い|おねがい)(?:ください|下さい|おいて)?[。！!\s]*$/u;
const DISMISS =
  /^(?:候補\s*(?:は|を)?\s*(?:いらない|要らない|不要|消して|けして|捨てて)|(?:全部|ぜんぶ|どれも)\s*(?:いらない|要らない|不要))[。！!\s]*$/u;

const DOW = ['日', '月', '火', '水', '木', '金', '土'] as const;

export class CandidateService {
  readonly #tz: string;
  readonly #now: () => number;

  constructor(
    readonly store: CandidateStore,
    readonly todos: Pick<TodoService, 'add'>,
    options: { readonly tz?: string; readonly now?: () => number } = {},
  ) {
    this.#tz = options.tz ?? 'Asia/Tokyo';
    this.#now = options.now ?? Date.now;
  }

  /** 候補の話（貼った議事録・拾っての頼み・提案への答え）なら答える。違えば null。 */
  async handle(
    principal: { tenantId: string; userId: string },
    conversationId: string,
    rawText: string,
  ): Promise<CandidateReply | null> {
    const text = rawText.trim().normalize('NFKC');
    if (!text) return null;
    if (ALL.test(text) || NUMBERS.test(text) || DISMISS.test(text)) {
      const answered = await this.#answer(principal, conversationId, text);
      if (answered) return answered;
    }
    const lines = rawText.trim().split(/\r?\n/);
    const asked = EXTRACT_ASK.test(lines[0] ?? '');
    const minutes = MINUTES_HEAD.test(lines[0] ?? '') && lines.length >= 2;
    if (!asked && !minutes) return null;
    const body = asked ? lines.slice(1).join('\n') || (lines[0] ?? '') : rawText;
    const proposal = await this.propose(principal, conversationId, body, 'text');
    if (proposal) return { answer: proposal, needsClarification: true };
    // 頼まれて見つからなければ、そう言う。貼っただけの議事録なら、いつもの振り分けへ（要約など）
    return asked
      ? {
          answer:
            '日付つきの予定や締切は見つかりませんでした（「来週水曜14時から定例」「金曜までに見積書提出」のような書き方を拾います）。',
          needsClarification: false,
        }
      : null;
  }

  /** 文から候補を拾って置き、見せる文を返す。候補が無ければ null。 */
  async propose(
    principal: { tenantId: string; userId: string },
    conversationId: string,
    text: string,
    source: CandidateSource,
  ): Promise<string | null> {
    const found = extractCandidates(text, { now: this.#now(), tz: this.#tz });
    if (found.length === 0) return null;
    const stored = await this.store.addBatch({
      tenantId: principal.tenantId,
      userId: principal.userId,
      conversationId,
      source,
      candidates: found,
    });
    return proposalText(stored, this.#tz, source);
  }

  async #answer(
    principal: { tenantId: string; userId: string },
    conversationId: string,
    text: string,
  ): Promise<CandidateReply | null> {
    const batch = await this.store.latestBatch(
      principal.tenantId,
      principal.userId,
      conversationId,
      new Date(this.#now() - ANSWER_WINDOW_MS),
    );
    const pending = batch.filter((c) => c.status === 'pending');
    if (pending.length === 0) return null;

    if (DISMISS.test(text)) {
      await this.store.decide(
        principal.tenantId,
        pending.map((c) => c.id),
        'dismissed',
      );
      return { answer: '候補は入れずにおきます。', needsClarification: false };
    }

    let chosen: StoredCandidate[];
    if (ALL.test(text)) chosen = pending;
    else {
      const nums = [
        ...new Set((NUMBERS.exec(text)?.groups?.['nums'] ?? '').match(/\d{1,2}/g)?.map(Number)),
      ];
      const missing = nums.filter((n) => !pending.some((c) => c.position === n));
      if (missing.length > 0)
        return {
          answer: `候補に ${missing.join('・')} はありません（入れられるのは ${pending.map((c) => c.position).join('・')}）。`,
          needsClarification: true,
        };
      chosen = pending.filter((c) => nums.includes(c.position));
    }
    if (chosen.length === 0) return null;

    const events = chosen.filter((c) => c.kind === 'event');
    const todos = chosen.filter((c) => c.kind === 'todo');
    // 予定 1 件だけ: カレンダーの確かめへ回す
    if (events.length === 1 && todos.length === 0) {
      const e = events[0]!;
      await this.store.decide(principal.tenantId, [e.id], 'added');
      return {
        answer: `予定「${e.title}」をカレンダーに入れる確かめを出します。`,
        needsClarification: false,
        request: calendarRequest(e, this.#tz),
      };
    }
    const added: string[] = [];
    for (const t of todos) {
      if (t.kind !== 'todo') continue;
      await this.todos.add(principal, conversationId, t.title, t.due);
      added.push(`・${t.title}（${dueLabel(t.due)}まで）`);
    }
    await this.store.decide(
      principal.tenantId,
      todos.map((t) => t.id),
      'added',
    );
    const lines: string[] = [];
    if (added.length > 0)
      lines.push(
        'やることに入れました（締切の日の 9:00 にこのトークでお知らせします）。',
        ...added,
      );
    if (events.length > 0)
      lines.push(
        `予定は、カレンダーに書く前に 1 件ずつ確かめます。「${String(events[0]!.position)} を入れて」のように、予定の番号を 1 つずつ送ってください（${events.map((e) => e.position).join('・')}）。`,
      );
    return { answer: lines.join('\n'), needsClarification: events.length > 0 };
  }
}

function proposalText(
  stored: readonly StoredCandidate[],
  tz: string,
  source: CandidateSource,
): string {
  const events = stored.filter((c) => c.kind === 'event');
  const todos = stored.filter((c) => c.kind === 'todo');
  const from = source === 'call_minutes' ? '通話の議事録から' : '送られた文から';
  const lines = [
    `${from}、予定とやることの候補が ${String(stored.length)} 件見つかりました（まだ入れていません）。`,
  ];
  const item = (c: StoredCandidate) => [
    `${String(c.position)}. ${c.title}（${c.kind === 'event' ? eventWhen(c.start, c.end, tz) : `${dueLabel(c.due)}まで`}）`,
    `　元の文:「${c.excerpt.replace(/\s+/g, ' ').slice(0, 80)}」`,
  ];
  if (events.length > 0) lines.push('', '■ 予定', ...events.flatMap(item));
  if (todos.length > 0) lines.push('', '■ やること（締切）', ...todos.flatMap(item));
  const first = stored[0]!.position;
  lines.push(
    '',
    stored.length > 1
      ? `入れるものを「全部入れて」「${String(first)} を入れて」「${String(first)}と${String(stored[1]!.position)}を入れて」のように送ってください。いらなければ「候補はいらない」。`
      : `入れるなら「${String(first)} を入れて」、いらなければ「候補はいらない」と送ってください。`,
  );
  return lines.join('\n');
}

/** 「11/11(水) 14:00〜15:00」 */
export function eventWhen(start: number, end: number | null, tz: string): string {
  const parts = (ms: number) => {
    const f = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(ms);
    const g = (t: string) => f.find((p) => p.type === t)!.value;
    return {
      year: Number(g('year')),
      month: Number(g('month')),
      day: Number(g('day')),
      hm: `${g('hour')}:${g('minute')}`,
    };
  };
  const s = parts(start);
  const dow = DOW[new Date(Date.UTC(s.year, s.month - 1, s.day)).getUTCDay()]!;
  return `${String(s.month)}/${String(s.day)}(${dow}) ${s.hm}〜${end ? parts(end).hm : ''}`;
}

/** カレンダーに入れる頼み（写真から読んだ予定と同じ書き方。いつもの振り分けが読む） */
function calendarRequest(c: Candidate & { kind: 'event' }, tz: string): string {
  const f = (ms: number) =>
    new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
      .format(ms)
      .replace(',', '');
  const [date, start] = f(c.start).split(' ');
  const end = c.end ? f(c.end).split(' ')[1] : null;
  return `カレンダーに予定を入れて: ${c.title} ${date!} ${start!}〜${end ?? ''}`;
}
