/**
 * 本人が決めた保留（受け入れ項目書 2026-10-29 の T07・E2E-03）。
 *
 *   「デザインは来週まで保留」「genie は 11/5 まで保留。理由は仕様待ち」 → 保留を作る
 *   「デザインの保留を解除して」「デザインを再開して」                    → 解除する
 *
 * 保留の名前（subject）は、本人の呼び方のまま残し、次のものに当てる:
 *   - Claude Code のセッション … フォルダ名が同じ、または最初の頼みの頭に名前を含む → 知らせない（held）
 *   - 予約                     … 名前に含む → 止める（解除で、まだ止まっているものだけ戻す）
 *   - 「終わったら〇〇して」    … 頼みの文に含む → 始めない（task-followups）
 *
 * **勝手に再開しない。**保留の日が来たら「再開しますか」と 1 回知らせるだけで、解除は本人の言葉で行う。
 * 保留の日を書かなかったものは、解除するまで続く。
 */
import { uuidv7 } from '@genie/contracts';
import { withTenant, type DbHandle } from '@genie/db';
import { sql } from 'kysely';
import { nextRunAfter, wallClock, type ScheduleStore } from '@genie/service-schedule';
import { checkAfterFor, type AgentState, type UserPolicy } from './agent-sessions.js';

export interface WorkHold {
  readonly id: string;
  readonly subject: string;
  readonly reason: string | null;
  /** YYYY-MM-DD（本人のタイムゾーンの日付）。null は解除するまで。 */
  readonly untilDate: string | null;
  readonly createdAt: Date;
}

const DAY_MS = 24 * 3600_000;
const WEEKDAY = '日月火水木金土';

/** その日付（UTC の 0 時として数える）。月・日は溢れてよい。 */
const ymd = (year: number, month: number, day: number): string =>
  new Date(Date.UTC(year, month - 1, day)).toISOString().slice(0, 10);

/**
 * 「来週」「明日」「11/5」「金曜」→ 保留を終える日（その日に「再開しますか」と聞く）。分からなければ undefined。
 * 「来週まで」は来週の月曜。週は月曜に始める。
 */
export function holdUntil(phrase: string, nowMs: number, tz: string): string | undefined {
  const w = wallClock(nowMs, tz);
  const today = Date.UTC(w.year, w.month - 1, w.day);
  const plus = (days: number) => new Date(today + days * DAY_MS).toISOString().slice(0, 10);
  // 月曜を 0 とした今日の曜日
  const fromMonday = (w.weekday + 6) % 7;
  const p = phrase.replace(/\s+/g, '');
  if (/^明後日|^あさって/.test(p)) return plus(2);
  if (/^明日|^あした/.test(p)) return plus(1);
  if (/^再来週/.test(p)) return plus(14 - fromMonday);
  if (/^来週(?!の?[月火水木金土日]曜)/.test(p)) return plus(7 - fromMonday);
  // 週末は土曜（日曜に言われたら次の土曜）
  if (/^(?:今週末|週末)/.test(p)) return plus(fromMonday === 6 ? 6 : 5 - fromMonday);
  if (/^来月/.test(p)) return ymd(w.year, w.month + 1, 1);
  const md = /^(\d{1,2})(?:\/|月)(\d{1,2})日?/.exec(p);
  if (md) {
    const month = Number(md[1]);
    const day = Number(md[2]);
    if (month < 1 || month > 12 || day < 1 || day > 31) return undefined;
    const thisYear = Date.UTC(w.year, month - 1, day);
    return ymd(thisYear < today ? w.year + 1 : w.year, month, day);
  }
  const dayOnly = /^(\d{1,2})日/.exec(p);
  if (dayOnly) {
    const day = Number(dayOnly[1]);
    if (day < 1 || day > 31) return undefined;
    return day >= w.day ? ymd(w.year, w.month, day) : ymd(w.year, w.month + 1, day);
  }
  const wd = /^(来週の?)?([月火水木金土日])曜/.exec(p);
  if (wd) {
    const target = WEEKDAY.indexOf(wd[2]!);
    // 「金曜」は次の金曜（今日が金曜なら来週）。「来週の金曜」は来週の月曜から数える
    return plus(wd[1] ? 7 - fromMonday + ((target + 6) % 7) : (target - w.weekday + 7) % 7 || 7);
  }
  return undefined;
}

/** 「11/5（水）」 */
export function describeDate(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  return `${String(d.getUTCMonth() + 1)}/${String(d.getUTCDate())}（${WEEKDAY[d.getUTCDay()]!}）`;
}

/** 保留の名前が、このセッション・予約・頼みに当たるか（大文字小文字は見ない）。 */
export function matchesHold(
  subject: string,
  texts: readonly (string | null | undefined)[],
): boolean {
  const s = subject.toLowerCase();
  return texts.some((t) => !!t && t.toLowerCase().includes(s));
}

type HoldRow = {
  id: string;
  subject: string;
  reason: string | null;
  until_date: Date | string | null;
  created_at: Date | string;
};

const toHold = (r: HoldRow): WorkHold => ({
  id: r.id,
  subject: r.subject,
  reason: r.reason,
  untilDate:
    r.until_date === null
      ? null
      : typeof r.until_date === 'string'
        ? r.until_date.slice(0, 10)
        : // date 型は UTC の 0 時で返る（pg の型変換）。ずれないよう地方時で組み直す
          ymd(r.until_date.getFullYear(), r.until_date.getMonth() + 1, r.until_date.getDate()),
  createdAt: new Date(r.created_at),
});

export interface HoldResult {
  readonly hold: WorkHold;
  /** 静かにした Claude Code のセッションの数。 */
  readonly sessions: number;
  /** 止めた予約の名前。 */
  readonly schedules: readonly string[];
}

export class WorkHoldStore {
  constructor(
    private readonly db: DbHandle,
    private readonly schedules: ScheduleStore | null,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async active(tenantId: string, userId: string): Promise<WorkHold[]> {
    const rows = await withTenant(this.db, tenantId, (tx) =>
      tx
        .selectFrom('work_holds')
        .select(['id', 'subject', 'reason', 'until_date', 'created_at'])
        .where('user_id', '=', userId)
        .where('status', '=', 'active')
        .orderBy('created_at', 'desc')
        .execute(),
    );
    return rows.map(toHold);
  }

  /** 保留にする（同じ名前の保留があれば、日付と理由を書き換える）。 */
  async hold(
    tenantId: string,
    userId: string,
    input: { subject: string; reason: string | null; untilDate: string | null },
  ): Promise<HoldResult> {
    const now = this.now();
    const { hold, sessions } = await withTenant(this.db, tenantId, async (tx) => {
      const existing = await tx
        .selectFrom('work_holds')
        .select('id')
        .where('user_id', '=', userId)
        .where('status', '=', 'active')
        .where(sql`lower(subject)`, '=', input.subject.toLowerCase())
        .forUpdate()
        .executeTakeFirst();
      const row = existing
        ? await tx
            .updateTable('work_holds')
            .set({
              reason: input.reason,
              until_date: input.untilDate,
              due_noticed_at: null,
            })
            .where('id', '=', existing.id)
            .returning(['id', 'subject', 'reason', 'until_date', 'created_at'])
            .executeTakeFirstOrThrow()
        : await tx
            .insertInto('work_holds')
            .values({
              id: uuidv7(),
              tenant_id: tenantId,
              user_id: userId,
              subject: input.subject,
              reason: input.reason,
              until_date: input.untilDate,
            })
            .returning(['id', 'subject', 'reason', 'until_date', 'created_at'])
            .executeTakeFirstOrThrow();
      // 開いているセッションのうち、この名前に当たるもの（本人がすでに止めたものはそのまま）
      const s = input.subject.toLowerCase();
      const held = await tx
        .updateTable('agent_sessions')
        .set({ held_by: row.id, user_policy: 'paused_by_user', check_after: null, updated_at: now })
        .where('user_id', '=', userId)
        .where('ended_at', 'is', null)
        .where('held_by', 'is', null)
        .where('user_policy', '=', 'watch')
        .where((eb) =>
          eb.or([
            eb(sql`strpos(lower(coalesce(project, '')), ${s})`, '>', 0),
            eb(sql`strpos(lower(coalesce(title, '')), ${s})`, '>', 0),
          ]),
        )
        .executeTakeFirst();
      return { hold: toHold(row), sessions: Number(held.numUpdatedRows) };
    });
    // 名前に当たる動いている予約を止める（解除で戻すために id を残す）
    const paused: { id: string; name: string }[] = [];
    if (this.schedules) {
      for (const job of await this.schedules.list(tenantId, userId)) {
        if (job.status !== 'active' || !matchesHold(input.subject, [job.name])) continue;
        if (await this.schedules.setStatus(tenantId, userId, job.id, 'paused'))
          paused.push({ id: job.id, name: job.name });
      }
      if (paused.length > 0)
        await withTenant(this.db, tenantId, (tx) =>
          tx
            .updateTable('work_holds')
            .set({
              paused_schedule_ids: sql`array(select distinct unnest(paused_schedule_ids || ${sql.val(paused.map((p) => p.id))}::uuid[]))`,
            })
            .where('id', '=', hold.id)
            .execute(),
        );
    }
    return { hold, sessions, schedules: paused.map((p) => p.name) };
  }

  /** 保留を解除する。名前に当たる保留が無ければ null。 */
  async release(
    tenantId: string,
    userId: string,
    subject: string,
  ): Promise<{ hold: WorkHold; sessions: number; schedules: readonly string[] } | null> {
    const now = this.now();
    const released = await withTenant(this.db, tenantId, async (tx) => {
      const row = await tx
        .updateTable('work_holds')
        .set({ status: 'released', released_at: now })
        .where('user_id', '=', userId)
        .where('status', '=', 'active')
        .where(sql`lower(subject)`, '=', subject.toLowerCase())
        .returning(['id', 'subject', 'reason', 'until_date', 'created_at', 'paused_schedule_ids'])
        .executeTakeFirst();
      if (!row) return null;
      // 保留で静かにしていたセッションを見守りに戻す。まだ待っているものは、また知らせの対象にする
      // （保留の前に一度知らせていても、解除のあとにもう一度知らせる。前の知らせの印は消す）
      const sessions = await tx
        .updateTable('agent_sessions')
        .set({ held_by: null, user_policy: 'watch', notified_key: null, updated_at: now })
        .where('held_by', '=', row.id)
        .returning(['id', 'state', 'state_since', 'last_activity_at'])
        .execute();
      for (const s of sessions)
        await tx
          .updateTable('agent_sessions')
          .set({
            check_after: checkAfterFor({
              state: s.state as AgentState,
              userPolicy: 'watch' as UserPolicy,
              stateSince: new Date(s.state_since),
              lastActivityAt: new Date(s.last_activity_at),
            }),
          })
          .where('id', '=', s.id)
          .execute();
      return { row, sessions: sessions.length };
    });
    if (!released) return null;
    // 保留で止めた予約のうち、まだ止まっているものだけ戻す（本人がそのあと取り消したものは戻さない）
    const resumed: string[] = [];
    if (this.schedules) {
      for (const id of released.row.paused_schedule_ids ?? []) {
        const job = await this.schedules.get(tenantId, userId, id);
        if (job?.status !== 'paused') continue;
        const next = nextRunAfter(job.schedule, now.getTime());
        if (next === null) continue;
        if (await this.schedules.setStatus(tenantId, userId, id, 'active', new Date(next)))
          resumed.push(job.name);
      }
    }
    return { hold: toHold(released.row), sessions: released.sessions, schedules: resumed };
  }
}
