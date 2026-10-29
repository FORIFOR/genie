/**
 * 予約を会話で扱う（作る前に確かめる・一覧・取り消し）。handleTurn から呼ばれる。
 *
 *   「明日 9 時に資料の準備をリマインドして」
 *     → 「10/22（木）9:00 に『資料の準備』をお知らせします。よろしいですか？（はい / いいえ）」
 *   「はい」 → 予約しました（次は 10/22（木）9:00）
 *
 * **黙って作らない。**読み違えても、作る前に言い直しで気づける（openclaw の「言い直してから作る」と同じ）。
 * 確かめ中の案は会話ごとに 1 つで、10 分で消える。
 */
import { parseScheduleRequest, type ParseResult, type SchedulePayload } from './parse.js';
import type { ScheduleStore, ScheduledJob } from './store.js';
import { describeSchedule, formatWhen, nextRunAfter, upcomingRuns, type Schedule } from './time.js';

export interface ScheduleReply {
  readonly answer: string;
  /** 返事を待っている（確かめ中）。 */
  readonly needsClarification: boolean;
}

export interface ScheduleServiceOptions {
  /** 利用者のタイムゾーン（既定 Asia/Tokyo）。 */
  readonly tz?: string;
  readonly now?: () => number;
}

const YES =
  /^\s*(?:はい|うん|ええ|お願い(?:します)?|おねがい(?:します)?|それで(?:お願い(?:します)?)?|ok|okay|yes|予約して|大丈夫|いいよ|いいです|よろしく)[。！!\s]*$/i;
const NO =
  /^\s*(?:いいえ|いや|やめて|やめる|やめます|キャンセル|取り消して|取りやめて|no|ちがう|違う|いらない)[。！!\s]*$/i;
const LIST =
  /^\s*(?:予約|リマインダー|リマインド|スケジュール)(?:の)?(?:一覧|リスト)?(?:を)?(?:見せて|教えて|確認して|出して)?[。？?\s]*$|^\s*(?:何|なに)(?:が|を)?予約(?:して|され)(?:る|ている|てる)[？?。\s]*$/;
const CANCEL =
  /^\s*(?:(?<all>全部の|すべての|全ての)?(?:予約|リマインダー|リマインド)(?<n>\d{1,2})?(?:番)?|(?<last>さっきの|今の|最後の)(?:予約|リマインダー|リマインド))\s*(?:を)?\s*(?:取り消して|とりけして|キャンセルして|消して|やめて|止めて|解除して)[。！!\s]*$/;

/** 「平日の 9:00 に」「15 分ごとに」（数字のあとは空けて、語のあとは詰める）。 */
const atWhen = (when: string) => (/ごと$/.test(when) ? `${when}に` : `${when} に`);

/** 予約の言い直し（「平日の 9:00 に『日報を書く』をお知らせ」）。 */
export function scheduleName(schedule: Schedule, payload: SchedulePayload, tz: string): string {
  const when = describeSchedule(schedule, tz);
  return payload.kind === 'reminder'
    ? `${atWhen(when)}「${payload.text}」を${payload.call ? '電話で' : ''}お知らせ`
    : `${atWhen(when)}「${payload.text}」を頼む`;
}

export class ScheduleService {
  readonly #tz: string;
  readonly #now: () => number;

  constructor(
    readonly store: ScheduleStore,
    options: ScheduleServiceOptions = {},
  ) {
    this.#tz = options.tz ?? 'Asia/Tokyo';
    this.#now = options.now ?? Date.now;
  }

  get tz(): string {
    return this.#tz;
  }

  /**
   * 発話が予約の話なら答えを返す。違えば null（いつもの振り分けへ）。
   * 確かめ中の案があって「はい / いいえ」なら、それに答える。
   */
  async handle(
    principal: { tenantId: string; userId: string },
    conversationId: string,
    text: string,
  ): Promise<ScheduleReply | null> {
    const proposal = await this.store.proposalFor(principal.tenantId, conversationId);
    if (proposal && YES.test(text)) return this.#confirm(principal, proposal);
    if (proposal && NO.test(text)) {
      await this.store.setStatus(principal.tenantId, principal.userId, proposal.id, 'cancelled');
      return { answer: '予約はやめました。', needsClarification: false };
    }
    if (LIST.test(text))
      return { answer: await this.#listText(principal), needsClarification: false };
    const cancel = CANCEL.exec(text);
    if (cancel?.groups) return this.#cancel(principal, cancel.groups);

    const parsed = parseScheduleRequest(text, { now: this.#now(), tz: this.#tz });
    if (!parsed) return null;
    return this.#propose(principal, conversationId, parsed);
  }

  async #propose(
    principal: { tenantId: string; userId: string },
    conversationId: string,
    parsed: ParseResult,
  ): Promise<ScheduleReply> {
    if (!parsed.ok) {
      const answer =
        parsed.reason === 'past'
          ? 'その時刻はもう過ぎています。別の時刻で頼んでください。'
          : parsed.reason === 'too_frequent'
            ? '繰り返しは 5 分以上あけてください。'
            : 'その時刻は作れませんでした（時刻の書き方を確かめてください）。';
      return { answer, needsClarification: false };
    }
    const { schedule, payload } = parsed.request;
    const name = scheduleName(schedule, payload, this.#tz);
    await this.store.propose({
      tenantId: principal.tenantId,
      userId: principal.userId,
      conversationId,
      name,
      schedule,
      payload,
      tz: this.#tz,
    });
    const upcoming = upcomingRuns(schedule, this.#now(), schedule.kind === 'at' ? 1 : 3);
    const lines = [
      payload.kind === 'reminder'
        ? payload.call
          ? `${atWhen(describeSchedule(schedule, this.#tz))}「${payload.text}」を電話でお知らせします（LINE に「電話に出る」が届きます）。`
          : `${atWhen(describeSchedule(schedule, this.#tz))}「${payload.text}」をお知らせします。`
        : `${atWhen(describeSchedule(schedule, this.#tz))}「${payload.text}」を頼みます。外への送信などは、そのときに承認カードで確かめます。`,
      ...(schedule.kind === 'at'
        ? []
        : [`次は ${upcoming.map((t) => formatWhen(t, this.#tz)).join('、')}。`]),
      'よろしいですか？（はい / いいえ）',
    ];
    return { answer: lines.join('\n'), needsClarification: true };
  }

  async #confirm(
    principal: { tenantId: string; userId: string },
    proposal: ScheduledJob,
  ): Promise<ScheduleReply> {
    const next = nextRunAfter(proposal.schedule, this.#now());
    if (next === null) {
      await this.store.setStatus(principal.tenantId, principal.userId, proposal.id, 'cancelled');
      return {
        answer: 'その時刻はもう過ぎてしまいました。もう一度、時刻を言って頼んでください。',
        needsClarification: false,
      };
    }
    const job = await this.store.activate(principal.tenantId, proposal.id, new Date(next));
    if (!job) return { answer: 'この予約はもう確かめ済みです。', needsClarification: false };
    return {
      answer: `予約しました。次は ${formatWhen(next, this.#tz)} です。「予約の一覧」で確かめられます。`,
      needsClarification: false,
    };
  }

  async #listText(principal: { tenantId: string; userId: string }): Promise<string> {
    const jobs = await this.store.list(principal.tenantId, principal.userId);
    if (jobs.length === 0) return '予約はありません。';
    const lines = jobs.slice(0, 10).map((job, i) => {
      const state =
        job.status === 'paused'
          ? '（止めています）'
          : job.status === 'disabled'
            ? `（失敗が続いたので止めました${job.lastError ? `: ${job.lastError.slice(0, 60)}` : ''}）`
            : job.nextRunAt
              ? `（次は ${formatWhen(job.nextRunAt.getTime(), job.tz)}）`
              : '';
      return `${String(i + 1)}. ${job.name}${state}`;
    });
    return [
      ...lines,
      jobs.length > 10 ? `ほか ${String(jobs.length - 10)} 件。` : '',
      '取り消すときは「予約 1 を取り消して」のように言ってください。',
    ]
      .filter(Boolean)
      .join('\n');
  }

  async #cancel(
    principal: { tenantId: string; userId: string },
    groups: Record<string, string | undefined>,
  ): Promise<ScheduleReply> {
    const jobs = await this.store.list(principal.tenantId, principal.userId);
    if (jobs.length === 0)
      return { answer: '取り消す予約はありません。', needsClarification: false };
    let targets: ScheduledJob[];
    if (groups['all']) targets = jobs;
    else if (groups['n']) {
      const job = jobs[Number(groups['n']) - 1];
      if (!job)
        return {
          answer: `予約 ${groups['n']} はありません。「予約の一覧」で番号を確かめてください。`,
          needsClarification: false,
        };
      targets = [job];
    } else if (groups['last'] || jobs.length === 1) {
      targets = [[...jobs].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0]!];
    } else {
      return {
        answer: `予約が ${String(jobs.length)} 件あります。どれを取り消しますか？\n${await this.#listText(principal)}`,
        needsClarification: false,
      };
    }
    const done: string[] = [];
    for (const job of targets) {
      if (await this.store.setStatus(principal.tenantId, principal.userId, job.id, 'cancelled'))
        done.push(job.name);
    }
    return {
      answer:
        done.length === 0
          ? '取り消せませんでした（もう終わっているかもしれません）。'
          : `取り消しました：${done.join('、')}`,
      needsClarification: false,
    };
  }
}
