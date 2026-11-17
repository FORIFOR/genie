/**
 * 仕事の台帳（本人の方針 2026-10-29）。1 つの仕事について、依頼・完了条件・経過・判断・成果物・確かめ・
 * 次に要ることを 1 か所にまとめる。仕事は Genie の仕事（tasks）か Claude Code のセッション（agent_sessions）。
 *
 *   「genie の完了条件はテストが通ること、LINE に届くこと」 … 完了条件を覚える（work_criteria）
 *   「genie の完了条件は確かめた」                         … 自動で確かめられない条件を、本人の言葉で満たしたことにする
 *   「genie はどこまで進んだ？」「請求書の経緯を教えて」    … 台帳を話し言葉で答える
 *   GET /v1/work/ledger?session=… / ?task=…                … 台帳そのもの（Mac の画面が読む）
 *
 * 完了条件の確かめ方:
 *   tests  … Claude Code のテストの結果（check_state）で決める。最後のテストが通っていれば満たす、失敗なら満たさない
 *   manual … 自動では確かめられない。本人が「確かめた」と言うまで「まだ確かめていません」と言う
 * 確かめられないものを満たしたとは言わない。
 *
 * Claude Code のセッションは種類と時刻だけを残している（頼みの文・コマンド・ファイルの名前は無い）。
 * チャットへの答えには頼みの頭も出さない（フォルダ名だけ）。画面向けの台帳には頼みの頭を載せる。
 */
import {
  isTerminal,
  uuidv7,
  type Task,
  type TaskInstruction,
  type TaskStatus,
} from '@genie/contracts';
import { withTenant, type DbHandle } from '@genie/db';
import { wallClock } from '@genie/service-schedule';
import type { LibraryService } from '@genie/service-library';
import type { TaskService } from '@genie/service-task';
import {
  AgentSessionStore,
  attentionFor,
  type AgentSession,
  type MarkKind,
} from './agent-sessions.js';

export type CriterionState = 'met' | 'unmet' | 'unchecked';

export interface Criterion {
  readonly id: string;
  readonly text: string;
  readonly kind: 'tests' | 'manual';
  readonly state: CriterionState;
  /** どう確かめたか・なぜまだか。 */
  readonly how: string;
}

export interface LedgerEntry {
  readonly at: string;
  readonly text: string;
}

export interface Ledger {
  readonly subject: { readonly kind: 'agent_session' | 'task'; readonly id: string };
  /** チャットに出してよい名前（Claude Code はフォルダ名だけ）。 */
  readonly name: string;
  /** 元の依頼（画面向け。Claude Code は頼みの頭だけ）。 */
  readonly request: string | null;
  readonly criteria: readonly Criterion[];
  /** 経過（古い順）。 */
  readonly timeline: readonly LedgerEntry[];
  /** 本人の判断（承認・却下・途中の指示・保留）。 */
  readonly decisions: readonly LedgerEntry[];
  readonly artifacts: readonly { readonly id: string; readonly title: string }[];
  /** いまの確かめの状態（1 文）。 */
  readonly verification: string;
  /** 次に要ること（1 文）。 */
  readonly next: string;
  /** 依頼が残っていない・成果物の名前を残していない、などの断り。 */
  readonly notes: readonly string[];
}

export interface CriterionRow {
  readonly id: string;
  readonly text: string;
  readonly kind: 'tests' | 'manual';
  readonly metAt: Date | null;
}

const pad = (n: number) => String(n).padStart(2, '0');
/** 「10/29 14:02」。 */
export function clock(at: Date, tz: string): string {
  const w = wallClock(at.getTime(), tz);
  return `${String(w.month)}/${String(w.day)} ${String(w.hour)}:${pad(w.minute)}`;
}

const sessionName = (s: AgentSession) =>
  s.project ? `Claude Code（${s.project}）` : 'Claude Code';
const taskName = (t: { title: string | null }) => `「${t.title ?? '名前のない仕事'}」`;

const MARK_TEXT: Record<MarkKind, string> = {
  request: '頼まれました',
  instruction: '追加の指示がありました',
  waiting_permission: '承認を待ち始めました',
  waiting_input: 'あなたの返事を待ち始めました',
  changed: 'ファイルを変えました',
  test_passed: 'テストが通りました',
  test_failed: 'テストが失敗しました',
  turn_ended: '応答を終えました',
  error: 'うまくいかずに止まりました',
  ended: 'セッションが終わりました',
};

/** Claude Code のテストの結果で、tests の完了条件を照らす。 */
function testsCriterion(
  s: AgentSession,
  lastTest: { at: Date; passed: boolean } | null,
  tz: string,
): { state: CriterionState; how: string } {
  if (s.checkState === 'passed' && lastTest?.passed)
    return { state: 'met', how: `${clock(lastTest.at, tz)} にテストが通りました` };
  if (s.checkState === 'failed' && lastTest && !lastTest.passed)
    return { state: 'unmet', how: `${clock(lastTest.at, tz)} のテストが失敗しています` };
  if (s.checkState === 'changed')
    return { state: 'unchecked', how: '変えたあと、まだテストを走らせていません' };
  return { state: 'unchecked', how: 'まだテストを走らせていません' };
}

function manualCriterion(c: CriterionRow, tz: string): { state: CriterionState; how: string } {
  return c.metAt
    ? { state: 'met', how: `${clock(c.metAt, tz)} にあなたが確かめたと言いました` }
    : { state: 'unchecked', how: '自動では確かめられません。確かめたら教えてください' };
}

/** 完了条件が残っているときの「次に要ること」。全部満たしていれば null。 */
function nextForCriteria(name: string, criteria: readonly Criterion[]): string | null {
  const unmet = criteria.find((c) => c.state === 'unmet');
  if (unmet) return `「${unmet.text}」を満たしていません（${unmet.how}）。`;
  const tests = criteria.find((c) => c.kind === 'tests' && c.state === 'unchecked');
  if (tests) return `「${tests.text}」をまだ確かめていません（${tests.how}）。`;
  const manual = criteria.filter((c) => c.kind === 'manual' && c.state === 'unchecked');
  if (manual.length > 0)
    return `${manual.map((c) => `「${c.text}」`).join('、')}は自動では確かめられません。確かめたら「${name}の完了条件は確かめた」と言ってください。`;
  return null;
}

export function composeSessionLedger(input: {
  session: AgentSession;
  marks: readonly { kind: MarkKind; at: Date }[];
  criteria: readonly CriterionRow[];
  holdSubject: string | null;
  now: number;
  tz: string;
}): Ledger {
  const { session: s, marks, tz } = input;
  const name = s.project ?? 'Claude Code';
  const lastTestMark = [...marks]
    .reverse()
    .find((m) => m.kind === 'test_passed' || m.kind === 'test_failed');
  const lastTest = lastTestMark
    ? { at: lastTestMark.at, passed: lastTestMark.kind === 'test_passed' }
    : null;
  const criteria: Criterion[] = input.criteria.map((c) => ({
    id: c.id,
    text: c.text,
    kind: c.kind,
    ...(c.kind === 'tests' ? testsCriterion(s, lastTest, tz) : manualCriterion(c, tz)),
  }));
  const timeline = marks.map((m) => ({ at: m.at.toISOString(), text: MARK_TEXT[m.kind] }));
  const decisions: LedgerEntry[] = [];
  if (input.holdSubject)
    decisions.push({
      at: s.stateSince.toISOString(),
      text: `「${input.holdSubject}」として保留中です`,
    });
  const verification =
    s.checkState === 'passed'
      ? '変えたあと、テストが通っています'
      : s.checkState === 'failed'
        ? '最後のテストが失敗しています'
        : s.checkState === 'changed'
          ? 'ファイルを変えましたが、まだテストで確かめていません'
          : 'ファイルの変更はまだ届いていません';

  const a = attentionFor(s, input.now);
  let next: string;
  switch (a) {
    case 'needs_user':
      next =
        s.state === 'error'
          ? 'うまくいかずに止まりました。ターミナルで様子を見てください。'
          : `${s.waitingReason === 'permission' ? '承認' : 'あなたの返事'}を待っています。Claude Code にはターミナルで答えてください（Genie からは押しません）。`;
      break;
    case 'held':
      next = `保留中なので進めません。進めるときは「${input.holdSubject ?? name}の保留を解除して」と言ってください。`;
      break;
    case 'paused':
      next = '見守りを止めています。';
      break;
    case 'working':
      next = 'Claude Code が作業中です。いまは待つだけです。';
      break;
    case 'stalled_suspected':
    case 'unknown':
      next =
        '動きが届いていません（止まっているかもしれません。推測です）。ターミナルで様子を見てください。';
      break;
    default:
      next =
        nextForCriteria(name, criteria) ??
        (criteria.length > 0
          ? '完了条件はすべて満たしています。'
          : `完了条件がまだありません。「${name}の完了条件は〇〇」と言えば、それに照らして確かめます。`);
  }
  return {
    subject: { kind: 'agent_session', id: s.id },
    name: sessionName(s),
    request: s.title,
    criteria,
    timeline,
    decisions,
    artifacts: [],
    verification,
    next,
    notes: [
      'Claude Code の頼みの全文・コマンド・変えたファイルの名前は残していません（種類と時刻だけです）。',
    ],
  };
}

/** 依頼の文（入力のうち人が書いたもの）。 */
function requestText(input: Record<string, unknown>): string | null {
  for (const key of ['message', 'instruction', 'question', 'title']) {
    const value = input[key];
    if (typeof value === 'string' && value.trim()) return value.trim().slice(0, 2000);
  }
  return null;
}

export const STATUS_TEXT: Record<TaskStatus, string> = {
  PENDING: '始まるのを待っています',
  RUNNING: '進めています',
  WAITING_APPROVAL: 'あなたの承認を待っています',
  PAUSED_HOST_OFFLINE: 'Mac が戻るのを待っています',
  CANCELLING: '取り消しています',
  COMPLETED: '終わりました',
  FAILED: 'うまくいきませんでした',
  CANCELLED: '取り消しました',
};

const INSTRUCTION_TEXT: Record<TaskInstruction['status'], string> = {
  RECEIVED: '受け取りました（まだ反映していません）',
  APPLIED: '反映しました',
  NOT_APPLIED: '反映できませんでした',
};

export function composeTaskLedger(input: {
  task: Task;
  instructions: readonly TaskInstruction[];
  approvals: readonly {
    summary: string;
    status: string;
    createdAt: Date;
    decidedAt: Date | null;
  }[];
  artifacts: readonly { id: string; title: string }[];
  criteria: readonly CriterionRow[];
  tz: string;
}): Ledger {
  const { task: t, tz } = input;
  const name = t.title ?? '名前のない仕事';
  const criteria: Criterion[] = input.criteria.map((c) => ({
    id: c.id,
    text: c.text,
    kind: 'manual',
    ...manualCriterion(c, tz),
  }));
  const timeline: LedgerEntry[] = [{ at: t.created_at, text: '頼まれました' }];
  if (t.started_at) timeline.push({ at: t.started_at, text: '始めました' });
  const decisions: LedgerEntry[] = [];
  for (const i of input.instructions)
    decisions.push({
      at: i.created_at,
      text: `途中の指示「${i.text}」: ${INSTRUCTION_TEXT[i.status]}`,
    });
  for (const a of input.approvals) {
    const verdict =
      a.status === 'APPROVED'
        ? '承認しました'
        : a.status === 'REJECTED'
          ? '却下しました'
          : a.status === 'EXPIRED'
            ? '期限が切れました'
            : '承認を待っています';
    decisions.push({
      at: (a.decidedAt ?? a.createdAt).toISOString(),
      text: `「${a.summary}」: ${verdict}`,
    });
  }
  decisions.sort((x, y) => x.at.localeCompare(y.at));
  if (t.completed_at) timeline.push({ at: t.completed_at, text: STATUS_TEXT[t.status] });

  const verification =
    t.status === 'COMPLETED'
      ? input.artifacts.length > 0
        ? `終わりました。成果物が ${String(input.artifacts.length)} 件あります`
        : '終わりました。成果物はありません'
      : t.status === 'FAILED'
        ? `うまくいきませんでした（${t.error?.message ?? '理由は残っていません'}）`
        : STATUS_TEXT[t.status];

  let next: string;
  if (t.status === 'WAITING_APPROVAL')
    next = 'あなたの承認を待っています。Task Dock で確かめてください。';
  else if (t.status === 'PAUSED_HOST_OFFLINE') next = 'Mac が戻れば続きます。';
  else if (!isTerminal(t.status)) next = 'Genie が進めています。いまは待つだけです。';
  else if (t.status === 'FAILED')
    next = 'うまくいかなかったので、やり直すか頼み方を変えるかを決めてください。';
  else if (t.status === 'CANCELLED' || t.status === 'CANCELLING')
    next = '取り消したので、これ以上は進めません。';
  else
    next =
      nextForCriteria(name, criteria) ??
      (criteria.length > 0 ? '完了条件はすべて満たしています。' : '終わりました。');

  return {
    subject: { kind: 'task', id: t.id },
    name: taskName(t),
    request: requestText(t.input) ?? t.title,
    criteria,
    timeline,
    decisions,
    artifacts: input.artifacts,
    verification,
    next,
    notes: [],
  };
}

/** 台帳を話し言葉で（チャット向け。Claude Code の頼みの頭は出さない）。 */
export function speakLedger(l: Ledger, tz: string): string {
  const lines = [`${l.name}: ${l.verification}。`];
  if (l.criteria.length > 0) {
    lines.push('完了条件:');
    for (const c of l.criteria)
      lines.push(
        `・${c.state === 'met' ? '済' : c.state === 'unmet' ? '未達' : '未確認'}「${c.text}」（${c.how}）`,
      );
  }
  const recent = l.timeline.slice(-4);
  if (recent.length > 0)
    lines.push(
      `最近の経過: ${recent.map((e) => `${clock(new Date(e.at), tz)} ${e.text}`).join('、')}`,
    );
  if (l.decisions.length > 0)
    lines.push(
      `あなたの判断: ${l.decisions
        .slice(-3)
        .map((d) => d.text)
        .join('、')}`,
    );
  lines.push(`次: ${l.next}`);
  return lines.join('\n');
}

/** 決まった言い方。 */
const CRITERIA_MET =
  /^(?:(.+?)\s*の\s*)?(?:完了条件|終わりの条件|完了の条件)\s*(?:は|を|も)?\s*(?:全部|すべて|ぜんぶ|全て)?\s*(?:確かめた|確認した|確認できた|満たした|クリアした)/;
const CRITERIA =
  /^(?:(.+?)\s*の\s*)?(?:完了条件|終わりの条件|完了の条件)\s*(?:は|を)\s*、?\s*(.+)$/;
const PROGRESS =
  /^(.+?)\s*(?:は|って)\s*(?:いま|今)?\s*どこまで\s*(?:進んだ|進んでる|進んでいる|いった|行った|できた|できてる)|^(.+?)\s*の\s*(?:経緯|経過|台帳|記録)\s*(?:を|は)?\s*(?:教えて|見せて|どう)/;
const DEICTIC = /^(?:この|その|あの|今の|いまの)?(?:案件|仕事|作業|タスク|件|これ|それ|あれ)?$/;
const TESTS = /テスト|test|検証|verify/i;

/** 「テストが通ること、LINE に届くこと」を 1 つずつに。 */
export function splitCriteria(text: string): string[] {
  return text
    .split(/[、,，・。\n]/)
    .map((p) =>
      p
        .trim()
        .replace(/(?:こと|事)?\s*(?:です|にして|にします|でお願い|で)?\s*[。.!！]?$/, '')
        .trim(),
    )
    .filter((p) => p.length > 0)
    .map((p) => p.slice(0, 200))
    .slice(0, 8);
}

type Subject =
  | { kind: 'agent_session'; session: AgentSession }
  | { kind: 'task'; task: Pick<Task, 'id' | 'title' | 'status' | 'updated_at'> };

export interface WorkLedgerDeps {
  readonly db: DbHandle;
  readonly tasks: Pick<TaskService, 'list' | 'get' | 'listInstructions' | 'approvalHistory'>;
  readonly library: Pick<LibraryService, 'list'>;
  readonly tz: string;
  readonly now?: () => Date;
}

export class WorkLedger {
  readonly #sessions: AgentSessionStore;

  constructor(private readonly deps: WorkLedgerDeps) {
    this.#sessions = new AgentSessionStore(deps.db, deps.now);
  }

  #now(): number {
    return (this.deps.now?.() ?? new Date()).getTime();
  }

  async #criteria(
    tenantId: string,
    column: 'task_id' | 'agent_session_id',
    id: string,
  ): Promise<CriterionRow[]> {
    const rows = await withTenant(this.deps.db, tenantId, (tx) =>
      tx
        .selectFrom('work_criteria')
        .select(['id', 'text', 'kind', 'met_at'])
        .where(column, '=', id)
        .orderBy('created_at')
        .execute(),
    );
    return rows.map((r) => ({
      id: r.id,
      text: r.text,
      kind: r.kind as 'tests' | 'manual',
      metAt: r.met_at ? new Date(r.met_at) : null,
    }));
  }

  async forSession(tenantId: string, userId: string, id: string): Promise<Ledger | null> {
    const session = await this.#sessions.get(tenantId, userId, id);
    if (!session) return null;
    const [marks, criteria, hold] = await Promise.all([
      withTenant(this.deps.db, tenantId, (tx) =>
        tx
          .selectFrom('agent_session_marks')
          .select(['kind', 'at'])
          .where('session_id', '=', id)
          .orderBy('at')
          .orderBy('id')
          .execute(),
      ),
      this.#criteria(tenantId, 'agent_session_id', id),
      session.heldBy
        ? withTenant(this.deps.db, tenantId, (tx) =>
            tx
              .selectFrom('work_holds')
              .select('subject')
              .where('id', '=', session.heldBy!)
              .executeTakeFirst(),
          )
        : Promise.resolve(undefined),
    ]);
    return composeSessionLedger({
      session,
      marks: marks.map((m) => ({ kind: m.kind as MarkKind, at: new Date(m.at) })),
      criteria,
      holdSubject: hold?.subject ?? null,
      now: this.#now(),
      tz: this.deps.tz,
    });
  }

  async forTask(tenantId: string, userId: string, id: string): Promise<Ledger | null> {
    const task = await this.deps.tasks.get(tenantId, id).catch(() => null);
    if (!task || task.created_by !== userId) return null;
    const [instructions, approvals, artifacts, criteria] = await Promise.all([
      this.deps.tasks.listInstructions(tenantId, id).catch(() => []),
      this.deps.tasks.approvalHistory(tenantId, id),
      // 成果物は作られた順（UUIDv7 の id の順）
      this.deps.library
        .list({ tenantId, limit: 100, sourceTaskId: id })
        .then((page) =>
          page.items
            .map((a) => ({ id: a.id, title: a.title }))
            .sort((a, b) => (a.id < b.id ? -1 : 1)),
        ),
      this.#criteria(tenantId, 'task_id', id),
    ]);
    return composeTaskLedger({
      task,
      instructions,
      approvals: approvals.map((a) => ({
        summary: a.summary,
        status: a.status,
        createdAt: new Date(a.created_at),
        decidedAt: a.decided_at ? new Date(a.decided_at) : null,
      })),
      artifacts,
      criteria,
      tz: this.deps.tz,
    });
  }

  /**
   * 名前から仕事を探す。Claude Code はフォルダ名、Genie の仕事は題名に含まれるもの。
   * 「この仕事」「これ」は、いちばん最近動いたもの。見つからなければ候補の名前を返す。
   */
  async #find(
    tenantId: string,
    userId: string,
    name: string | undefined,
  ): Promise<Subject | { candidates: string[] }> {
    // 開いているものと、この 1 日に終わったもの
    const sessions = await this.#sessions.list(tenantId, userId).catch(() => []);
    const listed = await this.deps.tasks.list(tenantId, 50).catch(() => ({ items: [] }));
    const tasks = listed.items.filter((t) => t.created_by === userId);
    const latest = (ss: readonly AgentSession[], ts: typeof tasks): Subject | null => {
      const s = ss[0];
      const t = ts[0];
      if (s && (!t || s.lastActivityAt.getTime() >= Date.parse(t.updated_at)))
        return { kind: 'agent_session', session: s };
      return t ? { kind: 'task', task: t } : null;
    };
    const key = name?.trim().replace(/^(?:じゃあ|では|あと)、?\s*/, '');
    if (!key || DEICTIC.test(key)) {
      const open = latest(
        sessions.filter((s) => s.state !== 'ended'),
        tasks.filter((t) => !isTerminal(t.status as TaskStatus)),
      );
      const found = open ?? latest(sessions, tasks);
      if (found) return found;
    } else {
      const k = key.toLowerCase();
      const found = latest(
        sessions.filter(
          (s) =>
            s.project &&
            (s.project.toLowerCase().includes(k) || k.includes(s.project.toLowerCase())),
        ),
        tasks.filter((t) => t.title?.toLowerCase().includes(k)),
      );
      if (found) return found;
    }
    const names = [
      ...new Set([
        ...sessions.filter((s) => s.project).map((s) => s.project!),
        ...tasks.slice(0, 5).map((t) => t.title ?? ''),
      ]),
    ].filter(Boolean);
    return { candidates: names.slice(0, 6) };
  }

  /** 決まった言い方なら答える。それ以外は null。 */
  async command(
    principal: { tenantId: string; userId: string },
    text: string,
  ): Promise<string | null> {
    const t = text.trim();
    const met = CRITERIA_MET.exec(t);
    const criteria = met ? null : CRITERIA.exec(t);
    const progress = met || criteria ? null : PROGRESS.exec(t);
    if (!met && !criteria && !progress) return null;
    const name = met ? met[1] : criteria ? criteria[1] : (progress![1] ?? progress![2]);
    // 「今の作業はどこまで進んだ？」は全体の見通しに任せる
    if (progress && (!name || DEICTIC.test(name.trim()))) return null;
    const subject = await this.#find(principal.tenantId, principal.userId, name);
    if ('candidates' in subject)
      return [
        name && !DEICTIC.test(name.trim())
          ? `「${name.trim()}」に当たる仕事が見つかりませんでした。`
          : 'どの仕事のことか分かりませんでした。',
        subject.candidates.length > 0 ? `いまある仕事: ${subject.candidates.join('、')}` : '',
      ]
        .filter(Boolean)
        .join('\n');
    const column = subject.kind === 'task' ? 'task_id' : 'agent_session_id';
    const id = subject.kind === 'task' ? subject.task.id : subject.session.id;
    const label = subject.kind === 'task' ? taskName(subject.task) : sessionName(subject.session);
    const callName =
      subject.kind === 'task'
        ? (subject.task.title ?? 'この仕事')
        : (subject.session.project ?? 'Claude Code');

    if (met) {
      const updated = await withTenant(this.deps.db, principal.tenantId, (tx) =>
        tx
          .updateTable('work_criteria')
          .set({ met_at: new Date(this.#now()) })
          .where(column, '=', id)
          .where('user_id', '=', principal.userId)
          .where('kind', '=', 'manual')
          .where('met_at', 'is', null)
          .returning('text')
          .execute(),
      );
      const tests = (await this.#criteria(principal.tenantId, column, id)).filter(
        (c) => c.kind === 'tests',
      );
      if (updated.length === 0 && tests.length === 0)
        return `${label}には、確かめ待ちの完了条件がありません。`;
      return [
        updated.length > 0
          ? `${label}の${updated.map((u) => `「${u.text}」`).join('、')}を、あなたが確かめたものとして記録しました。`
          : '',
        tests.length > 0
          ? `${tests.map((c) => `「${c.text}」`).join('、')}は、言葉ではなくテストの結果で確かめます。`
          : '',
      ]
        .filter(Boolean)
        .join('');
    }

    if (criteria) {
      const parts = splitCriteria(criteria[2]!);
      if (parts.length === 0)
        return '完了条件を聞き取れませんでした。「〇〇の完了条件は△△」と言ってください。';
      const rows = parts.map((p) => ({
        id: uuidv7(),
        tenant_id: principal.tenantId,
        user_id: principal.userId,
        task_id: subject.kind === 'task' ? id : null,
        agent_session_id: subject.kind === 'agent_session' ? id : null,
        text: p,
        // テストで確かめられるのは Claude Code のセッションだけ（Genie の仕事にはテストの結果が無い）
        kind:
          subject.kind === 'agent_session' && TESTS.test(p)
            ? ('tests' as const)
            : ('manual' as const),
      }));
      await withTenant(this.deps.db, principal.tenantId, (tx) =>
        tx.insertInto('work_criteria').values(rows).execute(),
      );
      const lines = [`${label}の完了条件を ${String(rows.length)} つ覚えました。`];
      for (const r of rows)
        lines.push(
          r.kind === 'tests'
            ? `・「${r.text}」… Claude Code のテストの結果で確かめます`
            : `・「${r.text}」… 自動では確かめられないので、確かめたら「${callName}の完了条件は確かめた」と言ってください`,
        );
      lines.push('満たすまでは「終わった」とは言いません。');
      return lines.join('\n');
    }

    const ledger =
      subject.kind === 'task'
        ? await this.forTask(principal.tenantId, principal.userId, id)
        : await this.forSession(principal.tenantId, principal.userId, id);
    return ledger ? speakLedger(ledger, this.deps.tz) : null;
  }
}
