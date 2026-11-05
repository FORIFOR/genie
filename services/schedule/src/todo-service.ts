/**
 * 締切のある「やること」を会話で扱う（置く・一覧・済んだ・消す）。handleTurn から、予約より先に呼ばれる。
 *
 *   「金曜までに見積書を出す」
 *     → やることに入れました：「見積書を出す」（11/13(金)まで）。11/13(金) 9:00 にこのトークでお知らせします。
 *   「やることは？」 → 締切の早い順の一覧（過ぎたもの・今日までのものは、そう書く）
 *   「見積書出した」「やること 1 終わった」 → 済みにして、締切の朝の知らせも取り消す
 *
 * 置くのは本人がはっきり言ったときだけなので、確かめずに置く（言い直しを返事に書く。違えば「やること 1 を消して」）。
 */
import type { ScheduleStore } from './store.js';
import { formatWhen, zonedTime, type Schedule } from './time.js';
import type { SchedulePayload } from './parse.js';
import { dueFromIso, dueIso, dueLabel, parseTodoRequest, type DueDate } from './todo-parse.js';
import type { Todo, TodoStore } from './todo-store.js';
import { wallClock } from './time.js';

export interface TodoReply {
  readonly answer: string;
  readonly needsClarification: boolean;
}

export interface TodoServiceOptions {
  readonly tz?: string;
  readonly now?: () => number;
  /**
   * 期限のないやること（本人の TODO。service-understand の household_todos）。
   * 「やることは？」の一覧に、締切のあるものの後ろに並べる（予定とタスクは分けるが、やることは 1 つの一覧）。
   */
  readonly undated?: (principal: {
    tenantId: string;
    userId: string;
  }) => Promise<readonly { readonly title: string; readonly assignee?: string | null }[]>;
  /**
   * 「これを金曜までにやって」の「これ」: この会話で、この発話の 1 つ前に本人が送った文（無ければ null）。
   */
  readonly previousText?: (
    principal: { tenantId: string; userId: string },
    conversationId: string,
  ) => Promise<string | null>;
}

/** 締切の日の何時に知らせるか */
const REMIND_HOUR = 9;

export class TodoService {
  readonly #tz: string;
  readonly #now: () => number;

  readonly #undated: TodoServiceOptions['undated'];
  readonly #previousText: TodoServiceOptions['previousText'];

  constructor(
    readonly store: TodoStore,
    readonly schedules: ScheduleStore,
    options: TodoServiceOptions = {},
  ) {
    this.#tz = options.tz ?? 'Asia/Tokyo';
    this.#now = options.now ?? Date.now;
    this.#undated = options.undated;
    this.#previousText = options.previousText;
  }

  /** やることの話なら答えを返す。違えば null（いつもの振り分けへ）。 */
  async handle(
    principal: { tenantId: string; userId: string },
    conversationId: string,
    text: string,
  ): Promise<TodoReply | null> {
    const request = parseTodoRequest(text, { now: this.#now(), tz: this.#tz });
    if (!request) return null;
    switch (request.kind) {
      case 'add':
        return this.add(principal, conversationId, request.title, request.due);
      case 'add-ref': {
        const said = this.#previousText
          ? await this.#previousText(principal, conversationId).catch(() => null)
          : null;
        const title = said ? refTitle(said) : '';
        if (!title)
          return {
            answer: `何を${dueLabel(request.due)}までにしますか？「${dueLabel(request.due)}までに見積書を出す」のように、やることの名前を入れて送ってください。`,
            needsClarification: true,
          };
        return this.add(principal, conversationId, title, request.due);
      }
      case 'list':
        return { answer: await this.listText(principal), needsClarification: false };
      case 'done':
        return this.#close(principal, request.ref, 'done');
      case 'delete':
        return this.#close(principal, request.ref, 'deleted');
    }
  }

  /** やることを置く（締切の朝の知らせも作る）。候補の承認（candidate-service.ts）からも呼ぶ。 */
  async add(
    principal: { tenantId: string; userId: string },
    conversationId: string,
    title: string,
    due: DueDate,
  ): Promise<TodoReply> {
    const today = wallClock(this.#now(), this.#tz);
    const todayIso = dueIso({ year: today.year, month: today.month, day: today.day });
    if (dueIso(due) < todayIso)
      return {
        answer: `${dueLabel(due)} はもう過ぎています。締切の日を言い直してください。`,
        needsClarification: false,
      };
    const { todo, previousDue } = await this.store.upsert({
      tenantId: principal.tenantId,
      userId: principal.userId,
      conversationId,
      title,
      dueDate: dueIso(due),
    });
    // 締切の朝の知らせ。前の知らせ（締切を変えたとき）は取り消してから作る
    if (todo.reminderJobId)
      await this.schedules
        .setStatus(principal.tenantId, principal.userId, todo.reminderJobId, 'cancelled')
        .catch(() => null);
    const at = zonedTime(due.year, due.month, due.day, REMIND_HOUR, 0, this.#tz);
    let remind = '';
    if (at > this.#now()) {
      const schedule: Schedule = { kind: 'at', at: new Date(at).toISOString() };
      const payload: SchedulePayload = { kind: 'reminder', text: `今日が締切：${title}` };
      const { job } = await this.schedules.addConfirmed({
        tenantId: principal.tenantId,
        userId: principal.userId,
        conversationId,
        name: `${formatWhen(at, this.#tz)} に締切「${title}」をお知らせ`,
        schedule,
        payload,
        tz: this.#tz,
        nextRunAt: new Date(at),
      });
      await this.store.setReminder(principal.tenantId, todo.id, job.id);
      remind = `${formatWhen(at, this.#tz)} にこのトークでお知らせします。`;
    } else {
      await this.store.setReminder(principal.tenantId, todo.id, null);
    }
    const head = previousDue
      ? `「${title}」の締切を ${dueLabel(dueFromIso(previousDue))} から ${dueLabel(due)} に変えました。`
      : `やることに入れました：「${title}」（${dueLabel(due)}まで）。`;
    return {
      answer: `${head}${remind}\n済んだら「${title} 終わった」、一覧は「やることは？」と送ってください。`,
      needsClarification: false,
    };
  }

  /** 締切の早い順の一覧（Genie の作業の様子や、毎朝のまとめにも使う）。 */
  async listText(principal: { tenantId: string; userId: string }): Promise<string> {
    const [todos, undated] = await Promise.all([
      this.store.open(principal.tenantId, principal.userId),
      this.#undated ? this.#undated(principal).catch(() => []) : Promise.resolve([]),
    ]);
    if (todos.length === 0 && undated.length === 0)
      return 'やることはありません。「金曜までに見積書を出す」のように言えば、締切つきで覚えます。';
    const lines = todos
      .slice(0, 15)
      .map((t, i) => `${String(i + 1)}. ${t.title}（${this.#when(t)}）`);
    const loose = undated
      .slice(0, 10)
      .map((t) => `・${t.title}${t.assignee ? `（${t.assignee}）` : ''}`);
    return [
      todos.length > 0 ? `やること（${String(todos.length)} 件、締切の早い順）` : '',
      ...lines,
      todos.length > 15 ? `ほか ${String(todos.length - 15)} 件。` : '',
      undated.length > 0 ? `期限なし（${String(undated.length)} 件）` : '',
      ...loose,
      undated.length > 10 ? `ほか ${String(undated.length - 10)} 件。` : '',
      todos.length > 0
        ? '済んだら「やること 1 終わった」や「見積書出した」のように送ってください。'
        : '済んだら「ゴミ出し終わった」のように送ってください。締切をつけるなら「金曜までに見積書を出す」。',
    ]
      .filter(Boolean)
      .join('\n');
  }

  /** 締切が過ぎた・今日まで・明日までのもの（作業の様子の「気にすること」に出す）。 */
  async attention(principal: { tenantId: string; userId: string }): Promise<string[]> {
    const todos = await this.store.open(principal.tenantId, principal.userId);
    const today = this.#todayIso();
    const tomorrow = this.#todayIso(1);
    return todos
      .filter((t) => t.dueDate <= tomorrow)
      .map((t) =>
        t.dueDate < today
          ? `やること「${t.title}」は締切（${dueLabel(dueFromIso(t.dueDate))}）を過ぎています`
          : t.dueDate === today
            ? `やること「${t.title}」は今日が締切です`
            : `やること「${t.title}」は明日が締切です`,
      );
  }

  #todayIso(plusDays = 0): string {
    const w = wallClock(this.#now(), this.#tz);
    const d = new Date(Date.UTC(w.year, w.month - 1, w.day + plusDays));
    return dueIso({ year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() });
  }

  #when(t: Todo): string {
    const label = dueLabel(dueFromIso(t.dueDate));
    const today = this.#todayIso();
    if (t.dueDate < today) return `締切 ${label} を過ぎています`;
    if (t.dueDate === today) return `今日まで`;
    if (t.dueDate === this.#todayIso(1)) return `明日 ${label} まで`;
    return `${label}まで`;
  }

  async #close(
    principal: { tenantId: string; userId: string },
    ref: number | string,
    status: 'done' | 'deleted',
  ): Promise<TodoReply | null> {
    const todos = await this.store.open(principal.tenantId, principal.userId);
    let target: Todo | undefined;
    if (typeof ref === 'number') {
      target = todos[ref - 1];
      if (!target)
        return {
          answer:
            todos.length === 0
              ? 'まだ済んでいないやることはありません。'
              : `やること ${String(ref)} はありません。「やることは？」で番号を確かめてください。`,
          needsClarification: false,
        };
    } else {
      // 「見積書出した」: 名前で照らす。1 つに決まらなければ、やることの話ではない（いつもの振り分けへ）
      const key = core(ref);
      if (key.length < 2) return null;
      const hits = todos.filter((t) => core(t.title).includes(key) || key.includes(core(t.title)));
      if (hits.length !== 1) return null;
      target = hits[0]!;
    }
    const closed = await this.store.close(principal.tenantId, principal.userId, target.id, status);
    if (closed?.reminderJobId)
      await this.schedules
        .setStatus(principal.tenantId, principal.userId, closed.reminderJobId, 'cancelled')
        .catch(() => null);
    if (!closed) return { answer: 'そのやることは、もう済んでいます。', needsClarification: false };
    const left = todos.length - 1;
    return {
      answer:
        (status === 'done'
          ? `「${target.title}」を済みにしました。`
          : `「${target.title}」をやることから消しました。`) +
        (left > 0 ? `残りのやることは ${String(left)} 件です。` : 'やることは全部済みました。'),
      needsClarification: false,
    };
  }
}

/** 照らし合わせ用に、助詞・動詞の終わりを外す（「見積書を出す」→「見積書」） */
function core(s: string): string {
  return s
    .replace(/\s+/g, '')
    .replace(
      /(?:を|は|が|の)?(?:出す|出した|送る|送った|提出する|提出した|やる|やった|する|した|作る|作った|済ませる|終わらせる|仕上げる|完成させる)$/u,
      '',
    )
    .replace(/(?:を|は|が|の)$/u, '');
}

/**
 * 「これ」が指す直前の文を、やることの名前にする。頼みの終わり（「〜して」「お願い」）と句点を外し、長ければ切る。
 * 質問や短すぎる文（「はい」「OK」）は名前にしない。
 */
export function refTitle(said: string): string {
  const one = said.replace(/\s+/g, ' ').trim();
  if (/[?？]$/.test(one)) return '';
  const t = one
    .replace(/[。．.！!、,\s]+$/u, '')
    .replace(
      /(?:を)?(?:お願い(?:します)?|して(?:ください|下さい|おいて)?|やって(?:ください|おいて)?)$/u,
      '',
    )
    .replace(/[。．.！!、,\s]+$/u, '')
    .trim();
  if (t.length < 3 || /^(?:はい|うん|OK|ok|了解|ありがとう)/u.test(t)) return '';
  return t.length > 60 ? `${t.slice(0, 59)}…` : t;
}
