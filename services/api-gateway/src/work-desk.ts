/**
 * 仕事の見通し（受け入れ項目書 2026-10-29）。各 AI の画面を巡回しなくても、判断すべきことだけが分かるようにする。
 *
 *   「今の作業どうなってる？」「今日の作業を教えて」 … Genie の仕事・Claude Code・予約・保留をまとめて答える
 *                                                    （返事が要るものを先に。推した状態は推したと言う）
 *   「デザインは来週まで保留」「デザインの保留を解除して」 … work-holds.ts
 *   「止まっているものを全部進めて」                 … 何も勝手に動かさない。保留は進めないと言い、
 *                                                    本人の手が要るものを挙げる
 *   「これが終わったら統合テストを実行して」          … 前の仕事が COMPLETED になったときだけ始める
 *   「genie の完了条件は〜」「genie はどこまで進んだ？」 … work-ledger.ts（仕事の台帳）
 *   「仕事のホームを開いて」                        … work-home.ts（LINE から開くページのリンク）
 *
 * Claude Code へは何も送らない（ターミナルに打ち込まない）。Claude Code の頼みの頭はチャットに出さない
 * （フォルダ名と状態だけ）。
 */
import { isTerminal, uuidv7, type TaskListItem, type TaskStatus } from '@genie/contracts';
import { withIdentity, withTenant, type DbHandle } from '@genie/db';
import {
  formatWhen,
  wallClock,
  type ScheduleStore,
  type ScheduledJob,
} from '@genie/service-schedule';
import type { LibraryService } from '@genie/service-library';
import type { TaskService } from '@genie/service-task';
import { sql } from 'kysely';
import {
  AgentSessionStore,
  attentionFor,
  type AgentSession,
  type Attention,
} from './agent-sessions.js';
import { WorkLedger } from './work-ledger.js';
import {
  WorkHoldStore,
  describeDate,
  holdUntil,
  matchesHold,
  type WorkHold,
} from './work-holds.js';
// ホームと同じ並びでカードを作る（work-home.ts は composeOverview を使う。関数の中でだけ呼ぶので循環しても読める）
import { composeHome, workCardBody } from './work-home.js';

export interface WaitingFollowup {
  readonly id: string;
  readonly request: string;
  readonly afterTitle: string | null;
}

export interface OverviewInput {
  readonly tasks: readonly TaskListItem[];
  readonly sessions: readonly AgentSession[];
  readonly holds: readonly WorkHold[];
  readonly schedules: readonly ScheduledJob[];
  readonly followups: readonly WaitingFollowup[];
  readonly now: number;
  readonly tz: string;
}

export interface Overview {
  readonly counts: {
    readonly running: number;
    readonly needsUser: number;
    readonly suspected: number;
    readonly held: number;
    readonly doneToday: number;
  };
  /** 返事が要るものを先に、1 行ずつ。 */
  readonly attention: readonly string[];
  readonly text: string;
}

const tool = (s: AgentSession) => (s.source === 'claude_code' ? 'Claude Code' : s.source);
/** 「Claude Code（genie）」。頼みの頭は出さない（チャットを通るため）。 */
const sessionName = (s: AgentSession) => (s.project ? `${tool(s)}（${s.project}）` : tool(s));
const taskName = (t: TaskListItem) => `「${t.title ?? '名前のない仕事'}」`;
const minutes = (ms: number) => {
  const m = Math.max(1, Math.round(ms / 60_000));
  return m < 60 ? `${String(m)} 分` : `${String(Math.round(m / 60))} 時間`;
};
/** 3 つまで並べ、残りは数で言う。 */
const few = (names: readonly string[]) =>
  names.length <= 3
    ? names.join('、')
    : `${names.slice(0, 3).join('、')} ほか ${String(names.length - 3)} 件`;

const sameDay = (a: number, b: number, tz: string) => {
  const x = wallClock(a, tz);
  const y = wallClock(b, tz);
  return x.year === y.year && x.month === y.month && x.day === y.day;
};

/** いまの仕事のまとめ。話し言葉で、返事が要るものを先に。 */
export function composeOverview(input: OverviewInput): Overview {
  const { now, tz } = input;
  const attention: string[] = [];
  const suspected: string[] = [];
  const running: string[] = [];
  const done: string[] = [];
  const unknown: string[] = [];

  for (const s of input.sessions) {
    const a: Attention = attentionFor(s, now);
    const name = sessionName(s);
    const since = minutes(now - s.stateSince.getTime());
    switch (a) {
      case 'needs_user':
        attention.push(
          s.state === 'error'
            ? `${name}がうまくいかずに止まりました`
            : `${name}が${s.waitingReason === 'permission' ? '承認' : 'あなたの返事'}を待っています（${since}前から）`,
        );
        break;
      case 'stalled_suspected':
        suspected.push(
          `${name}は ${minutes(now - s.lastActivityAt.getTime())}動きがありません（止まっているかもしれません。推測です）`,
        );
        break;
      case 'unknown':
        unknown.push(name);
        break;
      case 'working':
        running.push(name);
        break;
      case 'idle':
        // 応答を終えただけ。変えたあとテストが通ったときだけ「確かめ済み」と言う
        if (s.checkState === 'failed')
          attention.push(`${name}は応答を終えましたが、最後のテストが失敗しています`);
        else if (sameDay(s.lastActivityAt.getTime(), now, tz))
          done.push(
            s.checkState === 'passed'
              ? `${name}（テストが通っています）`
              : s.checkState === 'changed'
                ? `${name}（変更をまだテストで確かめていません）`
                : `${name}（応答を終えました）`,
          );
        break;
      default:
        break;
    }
  }

  const mine = input.tasks;
  for (const t of mine) {
    const status = t.status as TaskStatus;
    const updated = Date.parse(t.updated_at);
    if (status === 'WAITING_APPROVAL') attention.push(`${taskName(t)}があなたの承認を待っています`);
    else if (status === 'FAILED' && sameDay(updated, now, tz))
      attention.push(`${taskName(t)}は終わりませんでした`);
    else if (status === 'RUNNING' || status === 'PENDING' || status === 'CANCELLING')
      running.push(taskName(t));
    else if (status === 'PAUSED_HOST_OFFLINE')
      running.push(`${taskName(t)}（Mac が戻るのを待っています）`);
    else if (status === 'COMPLETED' && sameDay(updated, now, tz)) done.push(taskName(t));
  }

  for (const j of input.schedules)
    if (j.status === 'disabled')
      attention.push(`予約「${j.name}」は続けて失敗したので止まっています`);

  const lines: string[] = [];
  const nothing =
    attention.length +
      suspected.length +
      running.length +
      done.length +
      unknown.length +
      input.holds.length +
      input.followups.length ===
    0;
  if (nothing) lines.push('いま動いている仕事も、待っているものもありません。');
  else if (attention.length === 0) lines.push('いま確かめてほしいものはありません。');
  else {
    lines.push(`いま確かめてほしいのは ${String(attention.length)} 件です。`);
    for (const a of attention) lines.push(`・${a}`);
  }
  for (const s of suspected) lines.push(`・${s}`);
  if (running.length > 0)
    lines.push(`動いているもの（${String(running.length)} 件）: ${few(running)}`);
  if (unknown.length > 0)
    lines.push(
      `しばらく何も届いていないので、いまの状態が分からないもの: ${few(unknown)}（終わったとは数えていません）`,
    );
  if (done.length > 0) lines.push(`今日終わったもの（${String(done.length)} 件）: ${few(done)}`);
  if (input.followups.length > 0)
    lines.push(
      `前の仕事が終わったら始めるもの: ${few(input.followups.map((f) => `「${f.request}」`))}`,
    );
  if (input.holds.length > 0)
    lines.push(
      `保留中（進めません）: ${few(
        input.holds.map(
          (h) => `${h.subject}${h.untilDate ? `（${describeDate(h.untilDate)}まで）` : ''}`,
        ),
      )}`,
    );
  const next = input.schedules
    .filter((j) => j.status === 'active' && j.nextRunAt)
    .sort((a, b) => a.nextRunAt!.getTime() - b.nextRunAt!.getTime())[0];
  if (next && !nothing)
    lines.push(`次の予約: ${formatWhen(next.nextRunAt!.getTime(), tz)}「${next.name}」`);

  return {
    counts: {
      running: running.length,
      needsUser: attention.length,
      suspected: suspected.length,
      held: input.holds.length,
      doneToday: done.length,
    },
    attention,
    text: lines.join('\n'),
  };
}

/** 決まった言い方。 */
export const STATUS =
  /(?:今|いま)の?(?:作業|仕事|タスク)(?:は|って|の(?:状況|様子|進み具合|進捗))?.*(?:どう|教えて|ある|状況|進捗|[?？])|(?:今日|きょう)の(?:作業|仕事|タスク)(?:を|は)?(?:教えて|どう|[?？])|(?:作業|仕事|タスク)の(?:状況|進み具合|進捗)|(?:止まって|待って)(?:いる|る)(?:仕事|作業|タスク|もの)は|保留(?:中|して(?:いる|る))の(?:もの|仕事|作業)?は/;
export const HOLD =
  /^(?:(.+?)(?:ので|から)、?\s*)?(.+?)\s*(?:は|を|も)、?\s*(?:(.+?)\s*まで\s*)?(?:保留(?!中|を?\s*(?:解除|やめ|外))|(?<=まで\s*)(?:進めないで|止めて|とめて))/;
const RELEASE =
  /^(.+?)\s*の?\s*(?:保留\s*を?\s*(?:解除|やめ|終わりに|終え|外し|取り消|取りやめ)|保留解除)|^(.+?)\s*を\s*再開して/;
const RESUME_ALL =
  /(?:全部|ぜんぶ|すべて|全て|まとめて)\s*(?:進めて|再開して|続けて|動かして)|進められる(?:もの|仕事)は(?:全部)?進めて/;
const FOLLOW =
  /^(?:これ|それ|今の|いまの|この仕事|その仕事|今の仕事|いまの仕事)?\s*(?:が|を)?\s*(?:終わったら|おわったら|済んだら|完了したら|片付いたら|終わり次第)、?\s*(.{2,}?)[。.！!]?\s*$/;
const DEICTIC = /^(?:この|その|あの|今の|いまの)?(?:案件|仕事|作業|タスク|件|これ|それ|あれ)$/;
/** ホームを開く（work-home.ts）。 */
export const OPEN_HOME =
  /^(?:仕事の|しごとの)?(?:ホーム|マイページ)\s*(?:を|が)?\s*(?:開いて|ひらいて|見せて|みせて|出して|ちょうだい|見たい)?[。.!！]?$|^(?:仕事|作業|タスク)の?(?:一覧|リスト|ホーム|画面)\s*(?:を|が)?\s*(?:開いて|ひらいて|見せて|みせて|出して|見たい)[。.!！]?$/;
const REASON = /理由は\s*(.+?)(?:[。.]|$)/;
const ONLY = /([^\s。、]+?)\s*だけ(?:は)?\s*(?:進めて|続けて)/;

export interface WorkDeskDeps {
  readonly db: DbHandle;
  readonly tasks: Pick<TaskService, 'list' | 'get' | 'listInstructions' | 'approvalHistory'>;
  readonly library: Pick<LibraryService, 'list'>;
  readonly schedules: ScheduleStore | null;
  readonly tz: string;
  readonly now?: () => Date;
  /** 「仕事のホームを開いて」への答え（work-home.ts の openHomeAnswer）。無ければ受けない。 */
  readonly openHome?: (principal: { tenantId: string; userId: string }) => Promise<string>;
  /** 見通しのカードに付ける仕事のホームのリンク（作れなければ null。カードはボタン無し）。 */
  readonly homeLink?: (principal: { tenantId: string; userId: string }) => Promise<string | null>;
}

/** 答えの文と、見通しを聞かれたときだけ LINE のカード（genie.work/v1）。 */
export interface DeskAnswer {
  readonly text: string;
  readonly card?: string;
}

export class WorkDesk {
  readonly holds: WorkHoldStore;
  readonly ledger: WorkLedger;
  readonly #sessions: AgentSessionStore;

  constructor(private readonly deps: WorkDeskDeps) {
    this.holds = new WorkHoldStore(deps.db, deps.schedules, deps.now);
    this.ledger = new WorkLedger(deps);
    this.#sessions = new AgentSessionStore(deps.db, deps.now);
  }

  #now(): number {
    return (this.deps.now?.() ?? new Date()).getTime();
  }

  /** 本人の仕事（この 50 件から）。 */
  async #tasks(tenantId: string, userId: string): Promise<TaskListItem[]> {
    const listed = await this.deps.tasks.list(tenantId, 50).catch(() => ({ items: [] }));
    return listed.items.filter((t) => t.created_by === userId);
  }

  async followups(tenantId: string, userId: string): Promise<WaitingFollowup[]> {
    const rows = await withTenant(this.deps.db, tenantId, (tx) =>
      tx
        .selectFrom('task_followups as f')
        .leftJoin('tasks as t', 't.id', 'f.after_task_id')
        .select(['f.id', 'f.request', 't.title'])
        .where('f.user_id', '=', userId)
        .where('f.status', '=', 'waiting')
        .orderBy('f.created_at')
        .execute(),
    );
    return rows.map((r) => ({ id: r.id, request: r.request, afterTitle: r.title }));
  }

  /** 見通しの材料（片方が落ちても、取れたほうで答える）。 */
  async gather(tenantId: string, userId: string): Promise<OverviewInput> {
    const [tasks, sessions, holds, schedules, followups] = await Promise.all([
      this.#tasks(tenantId, userId),
      this.#sessions.list(tenantId, userId).catch(() => []),
      this.holds.active(tenantId, userId).catch(() => []),
      this.deps.schedules?.list(tenantId, userId).catch(() => []) ?? Promise.resolve([]),
      this.followups(tenantId, userId).catch(() => []),
    ]);
    return { tasks, sessions, holds, schedules, followups, now: this.#now(), tz: this.deps.tz };
  }

  async overview(tenantId: string, userId: string): Promise<Overview> {
    return composeOverview(await this.gather(tenantId, userId));
  }

  /** 決まった言い方なら答える。それ以外は null（いつもどおり）。 */
  async command(
    principal: { tenantId: string; userId: string },
    conversationId: string,
    text: string,
  ): Promise<string | null> {
    const said = await this.#reply(principal, conversationId, text);
    return typeof said === 'string' || said === null ? said : said.text;
  }

  /**
   * command と同じ答えに、見通しを聞かれたときだけカードを添える（LINE はカード、Slack・通知は文）。
   * カードの中身はホームと同じ（確認が必要なもの → 件数 → 仕事 5 件）。頼みの頭は出さない。
   */
  async answer(
    principal: { tenantId: string; userId: string },
    conversationId: string,
    text: string,
  ): Promise<DeskAnswer | null> {
    const said = await this.#reply(principal, conversationId, text);
    if (said === null) return null;
    if (typeof said === 'string') return { text: said };
    const home = composeHome(said.input);
    const homeUrl = (await this.deps.homeLink?.(principal).catch(() => null)) ?? null;
    return { text: said.text, card: JSON.stringify(workCardBody(home, said.text, homeUrl)) };
  }

  async #reply(
    principal: { tenantId: string; userId: string },
    conversationId: string,
    text: string,
  ): Promise<string | { text: string; input: OverviewInput } | null> {
    const t = text.trim();
    if (this.deps.openHome && OPEN_HOME.test(t)) return this.deps.openHome(principal);
    // 完了条件と「〇〇はどこまで進んだ？」（work-ledger.ts）。条件の文に「保留」などが入っても取り違えないよう先に見る
    const ledger = await this.ledger.command(principal, t);
    if (ledger !== null) return ledger;
    const release = RELEASE.exec(t);
    if (release) {
      const subject = (release[1] ?? release[2] ?? '').trim();
      const done = subject
        ? await this.holds.release(principal.tenantId, principal.userId, subject)
        : null;
      // 「〇〇を再開して」は保留が無ければほかの話（予約の再開など）
      if (!done && release[2]) return null;
      if (!done) {
        const active = await this.holds.active(principal.tenantId, principal.userId);
        return active.length > 0
          ? `「${subject}」という保留はありません。いまの保留は ${active.map((h) => `「${h.subject}」`).join('、')} です。`
          : 'いま保留にしているものはありません。';
      }
      const parts = [`「${done.hold.subject}」の保留を解除しました。`];
      if (done.sessions > 0)
        parts.push(`Claude Code のセッション ${String(done.sessions)} 件の見守りを戻しました。`);
      if (done.schedules.length > 0)
        parts.push(`予約${done.schedules.map((n) => `「${n}」`).join('、')}を再開しました。`);
      return parts.join('');
    }

    const hold = HOLD.exec(t);
    if (hold) {
      const subject = (hold[2] ?? '').trim().replace(/^(?:じゃあ|では|あと)、?\s*/, '');
      if (!subject || DEICTIC.test(subject)) {
        const open = (await this.#sessions.list(principal.tenantId, principal.userId))
          .filter((s) => s.state !== 'ended' && s.project)
          .map((s) => s.project!);
        const names = [...new Set(open)].slice(0, 5);
        return [
          'どれを保留にするか、名前で教えてください（例:「genie は来週まで保留」）。',
          names.length > 0 ? `いま開いている Claude Code のフォルダ: ${names.join('、')}` : '',
        ]
          .filter(Boolean)
          .join('\n');
      }
      const untilPhrase = hold[3]?.trim();
      const untilDate = untilPhrase ? holdUntil(untilPhrase, this.#now(), this.deps.tz) : undefined;
      const reason = (REASON.exec(t)?.[1] ?? hold[1] ?? '').trim().slice(0, 200) || null;
      const made = await this.holds.hold(principal.tenantId, principal.userId, {
        subject: subject.slice(0, 80),
        reason,
        untilDate: untilDate ?? null,
      });
      const parts = [
        untilDate
          ? `承知しました。「${made.hold.subject}」は ${describeDate(untilDate)}まで保留にします。`
          : untilPhrase
            ? `「${untilPhrase}」がいつか分からなかったので、「${made.hold.subject}」は解除するまで保留にします。`
            : `承知しました。「${made.hold.subject}」は解除するまで保留にします。`,
      ];
      if (made.sessions > 0)
        parts.push(`Claude Code のセッション ${String(made.sessions)} 件は知らせを止めました。`);
      if (made.schedules.length > 0)
        parts.push(`予約${made.schedules.map((n) => `「${n}」`).join('、')}を止めました。`);
      parts.push(
        untilDate
          ? `勝手には再開しません。${describeDate(untilDate)}に、再開するか伺います。`
          : '勝手には再開しません。再開するときは「' +
              made.hold.subject +
              'の保留を解除して」と言ってください。',
      );
      const only = ONLY.exec(t)?.[1];
      if (only && !matchesHold(made.hold.subject, [only]))
        parts.push(`「${only}」は止めていません。`);
      return parts.join('');
    }

    if (RESUME_ALL.test(t)) return this.#resumeAll(principal);

    const follow = FOLLOW.exec(t);
    if (follow) return this.#follow(principal, conversationId, follow[1]!.trim());

    if (STATUS.test(t)) {
      const input = await this.gather(principal.tenantId, principal.userId);
      return { text: composeOverview(input).text, input };
    }
    return null;
  }

  /** 「全部進めて」。**何も勝手に動かさない。**保留は進めないと言い、本人の手が要るものを挙げる。 */
  async #resumeAll(principal: { tenantId: string; userId: string }): Promise<string> {
    const now = this.#now();
    const [tasks, sessions, holds, followups] = await Promise.all([
      this.#tasks(principal.tenantId, principal.userId),
      this.#sessions.list(principal.tenantId, principal.userId),
      this.holds.active(principal.tenantId, principal.userId),
      this.followups(principal.tenantId, principal.userId),
    ]);
    const lines: string[] = [];
    for (const s of sessions) {
      const a = attentionFor(s, now);
      if (a === 'needs_user')
        lines.push(
          `・${sessionName(s)}は${s.state === 'error' ? '止まっています' : s.waitingReason === 'permission' ? '承認を待っています' : 'あなたの返事を待っています'}。Claude Code にはターミナルで答えてください（Genie からは押しません）。`,
        );
      else if (a === 'stalled_suspected' || a === 'unknown')
        lines.push(
          `・${sessionName(s)}は動きが届いていません。ターミナルで様子を見てください（Genie からは打ち込みません）。`,
        );
    }
    for (const t of tasks) {
      if (t.status === 'WAITING_APPROVAL')
        lines.push(`・${taskName(t)}はあなたの承認を待っています。Task Dock で確かめてください。`);
      if (t.status === 'PAUSED_HOST_OFFLINE')
        lines.push(`・${taskName(t)}は Mac が戻れば続きます。`);
    }
    for (const f of followups) lines.push(`・「${f.request}」は前の仕事が終わったら始めます。`);
    const head =
      lines.length > 0
        ? '自分から進められるものは、いまはありません。進めるには次のことが要ります。'
        : '止まっているもの・待っているものはありません。';
    const held =
      holds.length > 0
        ? `保留中の${holds.map((h) => `「${h.subject}」`).join('、')}は進めません。進めるときは「〇〇の保留を解除して」と言ってください。`
        : '';
    return [head, ...lines, held].filter(Boolean).join('\n');
  }

  /** 「これが終わったら〇〇して」。いま動いている本人の仕事のうち、いちばん新しいものの後に置く。 */
  async #follow(
    principal: { tenantId: string; userId: string },
    conversationId: string,
    request: string,
  ): Promise<string> {
    const holds = await this.holds.active(principal.tenantId, principal.userId);
    const held = holds.find((h) => matchesHold(h.subject, [request]));
    if (held)
      return `「${held.subject}」は保留中なので、この頼みは受けていません。進めるなら、先に「${held.subject}の保留を解除して」と言ってください。`;
    const open = (await this.#tasks(principal.tenantId, principal.userId)).find(
      (t) => !isTerminal(t.status as TaskStatus),
    );
    if (!open)
      return `いま動いている仕事がないので、待つものがありません。すぐ「${request}」を頼むなら、そのまま送ってください。`;
    await withTenant(this.deps.db, principal.tenantId, (tx) =>
      tx
        .insertInto('task_followups')
        .values({
          id: uuidv7(),
          tenant_id: principal.tenantId,
          user_id: principal.userId,
          conversation_id: conversationId,
          after_task_id: open.id,
          request: request.slice(0, 2000),
        })
        .execute(),
    );
    return `承知しました。${taskName(open)}が終わったら「${request}」を始めます。終わらなかったときは始めずにお知らせします。`;
  }
}

/** 前の仕事が終わったときの頼みの動かし方（handleTurn を本人として呼ぶ）。 */
export type FollowupRun = (input: {
  tenantId: string;
  userId: string;
  conversationId: string;
  text: string;
  turnId: string;
}) => Promise<{ taskId: string | null; answer: string | null }>;

export interface WorkDeskWatchDeps {
  readonly db: DbHandle;
  readonly tz: string;
  readonly run: FollowupRun;
  /** 本人のチャットへ（conversationId が null なら本人の LINE へ）。 */
  readonly notifyChat?: (
    tenantId: string,
    userId: string,
    conversationId: string | null,
    text: string,
  ) => Promise<void>;
  readonly now?: () => Date;
  readonly log?: (event: string, detail: Record<string, unknown>) => void;
}

/**
 * 見回り（15 秒ごと）: 保留の日が来たら「再開しますか」と 1 回知らせる。前の仕事が終わった頼みを始める。
 */
export class WorkDeskWatch {
  #timer: NodeJS.Timeout | null = null;
  #running = false;

  constructor(private readonly deps: WorkDeskWatchDeps) {}

  #now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  start(intervalMs = 15_000): void {
    if (this.#timer) return;
    this.#timer = setInterval(() => void this.tick(), intervalMs);
    this.#timer.unref?.();
    void this.tick();
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
  }

  async tick(): Promise<{ holds: number; followups: number }> {
    if (this.#running) return { holds: 0, followups: 0 };
    this.#running = true;
    try {
      return {
        holds: await this.#holdsDue().catch((error: unknown) => {
          this.deps.log?.('work_desk.holds_failed', { error: (error as Error).message });
          return 0;
        }),
        followups: await this.#followups().catch((error: unknown) => {
          this.deps.log?.('work_desk.followups_failed', { error: (error as Error).message });
          return 0;
        }),
      };
    } finally {
      this.#running = false;
    }
  }

  /** 保留の日が来た（本人のタイムゾーンで今日以前）。1 回だけ知らせ、解除はしない。 */
  async #holdsDue(): Promise<number> {
    const now = this.#now();
    const w = wallClock(now.getTime(), this.deps.tz);
    const today = `${String(w.year)}-${String(w.month).padStart(2, '0')}-${String(w.day).padStart(2, '0')}`;
    const due = await withIdentity(this.deps.db, (tx) =>
      tx
        .selectFrom('work_holds')
        .select(['id', 'tenant_id'])
        .where('status', '=', 'active')
        .where('due_noticed_at', 'is', null)
        .where('until_date', '<=', sql<Date>`${today}::date`)
        .limit(20)
        .execute(),
    );
    let sent = 0;
    for (const row of due) {
      const found = await withTenant(this.deps.db, row.tenant_id, async (tx) => {
        const hold = await tx
          .updateTable('work_holds')
          .set({ due_noticed_at: now })
          .where('id', '=', row.id)
          .where('status', '=', 'active')
          .where('due_noticed_at', 'is', null)
          .returning(['user_id', 'subject'])
          .executeTakeFirst();
        if (!hold) return null;
        await tx
          .insertInto('user_notices')
          .values({
            id: uuidv7(),
            tenant_id: row.tenant_id,
            user_id: hold.user_id,
            kind: 'work_hold',
            title: `「${hold.subject}」の保留の日になりました`.slice(0, 200),
            body: `再開するなら「${hold.subject}の保留を解除して」と話しかけてください。何もしなければ保留のままです。`.slice(
              0,
              2000,
            ),
          })
          .execute();
        return hold;
      });
      if (!found) continue;
      sent += 1;
      await this.deps
        .notifyChat?.(
          row.tenant_id,
          found.user_id,
          null,
          `🔔 保留にしていた「${found.subject}」の日になりました。再開するなら「${found.subject}の保留を解除して」と送ってください。何もしなければ保留のままです。`,
        )
        .catch(() => undefined);
    }
    return sent;
  }

  /** 前の仕事が終わった頼み。COMPLETED なら始め、それ以外（失敗・取り消し）なら始めずに知らせる。 */
  async #followups(): Promise<number> {
    const tenants = await withIdentity(this.deps.db, (tx) =>
      tx
        .selectFrom('task_followups')
        .select('tenant_id')
        .distinct()
        .where('status', '=', 'waiting')
        .limit(50)
        .execute(),
    );
    let decided = 0;
    for (const { tenant_id: tenantId } of tenants) {
      // 決めるのは 1 回だけ（行を取ったものだけが動かす）。頼みを動かすのは取ったあと、外で
      const claimed = await withTenant(this.deps.db, tenantId, async (tx) => {
        const rows = await tx
          .selectFrom('task_followups as f')
          .innerJoin('tasks as t', 't.id', 'f.after_task_id')
          .select([
            'f.id',
            'f.user_id',
            'f.conversation_id',
            'f.request',
            't.status as after_status',
            't.title as after_title',
          ])
          .where('f.status', '=', 'waiting')
          .where('t.status', 'in', ['COMPLETED', 'FAILED', 'CANCELLED'])
          .forUpdate('f')
          .skipLocked()
          .limit(10)
          .execute();
        const out = [];
        for (const r of rows) {
          const holds = await tx
            .selectFrom('work_holds')
            .select('subject')
            .where('user_id', '=', r.user_id)
            .where('status', '=', 'active')
            .execute();
          const heldBy = holds.find((h) => matchesHold(h.subject, [r.request]))?.subject ?? null;
          const status = r.after_status !== 'COMPLETED' ? 'skipped' : heldBy ? 'held' : 'started';
          await tx
            .updateTable('task_followups')
            .set({ status, decided_at: this.#now() })
            .where('id', '=', r.id)
            .execute();
          out.push({ ...r, status, heldBy });
        }
        return out;
      });
      for (const f of claimed) {
        decided += 1;
        const before = `「${f.after_title ?? '前の仕事'}」`;
        let title: string;
        let body = `「${f.request}」`;
        let taskId: string | null = null;
        if (f.status === 'skipped') {
          title = `${before}が終わらなかったので、続きは始めていません`;
        } else if (f.status === 'held') {
          title = `「${f.heldBy!}」が保留中なので、続きは始めていません`;
        } else {
          // 頼みの id で動かす（同じ頼みから仕事を二度作らない。handleTurn の冪等キー turn:<id>）
          const result = await this.deps
            .run({
              tenantId,
              userId: f.user_id,
              conversationId: f.conversation_id,
              text: f.request,
              turnId: f.id,
            })
            .catch((error: unknown) => {
              this.deps.log?.('work_desk.followup_failed', {
                id: f.id,
                error: (error as Error).message,
              });
              return null;
            });
          taskId = result?.taskId ?? null;
          if (taskId)
            await withTenant(this.deps.db, tenantId, (tx) =>
              tx
                .updateTable('task_followups')
                .set({ started_task_id: taskId })
                .where('id', '=', f.id)
                .execute(),
            );
          title = result
            ? `${before}が終わったので、続きを始めました`
            : `${before}は終わりましたが、続きを始められませんでした`;
          if (result?.answer && !taskId) body = `「${f.request}」: ${result.answer}`;
        }
        await withTenant(this.deps.db, tenantId, (tx) =>
          tx
            .insertInto('user_notices')
            .values({
              id: uuidv7(),
              tenant_id: tenantId,
              user_id: f.user_id,
              kind: 'task_followup',
              title: title.slice(0, 200),
              body: body.slice(0, 2000),
              task_id: taskId,
            })
            .execute(),
        );
        await this.deps
          .notifyChat?.(tenantId, f.user_id, f.conversation_id, `🔔 ${title}。${body}`)
          .catch(() => undefined);
      }
    }
    return decided;
  }
}
