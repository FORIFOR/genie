import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';

/*
 * クラウドのモデルを画面操作に使うときの歯止め。**既定は無料の分だけ。**
 *
 * ここが守ること:
 *  - 有料へは自動で上がらない。上げるのは設定を明示的に変えたときだけ。
 *  - 無料の分を使い切ったら止まる。待って掛け直したりしない。
 *  - 課金済みのプロジェクトの鍵を「無料」として扱わない。
 *  - 有料を有効にしたときは、仕事ごと・月ごとの上限で頭打ちにする。
 *
 * ここが守らないこと（誤解を避けるために書く）:
 *  - 実際の請求額は API からは分からない。台帳が持つのは**呼び出し回数と見積り**で、
 *    請求の正本ではない。止める最後の拠り所は提供元の 429。
 *  - 鍵も画面の中身も、この台帳には入らない。
 */
export class CloudBudgetError extends Error {
  constructor(
    readonly code:
      | 'paid_not_enabled'
      | 'billed_project_not_free'
      | 'free_quota_exhausted'
      | 'task_call_limit'
      | 'month_call_limit'
      | 'task_cost_limit'
      | 'month_cost_limit',
    message: string,
  ) {
    super(message);
    this.name = 'CloudBudgetError';
  }
}

export interface CloudBudgetConfig {
  /** 既定は無料のみ。`paid` にするのは利用者が設定で明示したときだけ。 */
  readonly tier?: 'free' | 'paid';
  /** 鍵が課金済みプロジェクトのものだと利用者が申告しているか。API からは分からない。 */
  readonly billedProject?: boolean;
  readonly taskCallLimit?: number;
  readonly monthlyCallLimit?: number;
  readonly taskCostLimitUsd?: number;
  readonly monthlyCostLimitUsd?: number;
  /** 1 呼び出しあたりの見積り。請求額ではない。 */
  readonly pricePerCallUsd?: number;
  readonly statePath: string;
  readonly now?: () => number;
}

interface Ledger {
  month: string;
  calls: number;
  costUsd: number;
  /** 提供元が 429 を返した月。その月はもう掛けない。 */
  exhaustedMonth?: string;
}

const EMPTY: Ledger = { month: '', calls: 0, costUsd: 0 };

export class CloudModelBudget {
  readonly #config: CloudBudgetConfig;
  readonly #now: () => number;
  #taskCalls = 0;
  #taskCostUsd = 0;

  constructor(config: CloudBudgetConfig) {
    for (const [name, value] of Object.entries({
      taskCallLimit: config.taskCallLimit,
      monthlyCallLimit: config.monthlyCallLimit,
    }))
      if (value !== undefined && (!Number.isInteger(value) || value < 1))
        throw new Error(`${name} must be a positive integer`);
    for (const [name, value] of Object.entries({
      taskCostLimitUsd: config.taskCostLimitUsd,
      monthlyCostLimitUsd: config.monthlyCostLimitUsd,
      pricePerCallUsd: config.pricePerCallUsd,
    }))
      if (value !== undefined && (!Number.isFinite(value) || value < 0))
        throw new Error(`${name} must be a non-negative number`);
    this.#config = config;
    this.#now = config.now ?? Date.now;
  }

  get tier(): 'free' | 'paid' {
    return this.#config.tier === 'paid' ? 'paid' : 'free';
  }

  /** 仕事の始めに呼ぶ。仕事ごとの数え直しはここだけ。 */
  beginTask(): void {
    this.#taskCalls = 0;
    this.#taskCostUsd = 0;
  }

  /**
   * 1 回掛ける前に呼ぶ。通らなければ掛けない——**掛けてから謝らない。**
   * 上限に触れたら例外。別のモデルへ移ることはしない（移るのは利用者の判断）。
   */
  authorize(): void {
    const month = this.#month();
    const ledger = this.#read();
    if (this.tier === 'free' && this.#config.billedProject === true)
      throw new CloudBudgetError(
        'billed_project_not_free',
        'The key belongs to a billed project, which is not the free tier',
      );
    if (ledger.exhaustedMonth === month)
      throw new CloudBudgetError('free_quota_exhausted', 'The free allowance is used up');
    const price = this.#config.pricePerCallUsd ?? 0;
    const { taskCallLimit, monthlyCallLimit, taskCostLimitUsd, monthlyCostLimitUsd } = this.#config;
    if (taskCallLimit !== undefined && this.#taskCalls >= taskCallLimit)
      throw new CloudBudgetError('task_call_limit', 'This task reached its call limit');
    if (monthlyCallLimit !== undefined && ledger.calls >= monthlyCallLimit)
      throw new CloudBudgetError('month_call_limit', 'This month reached its call limit');
    // 見積りの上限は、掛ける前に「この 1 回で超えるか」で判断する。
    if (taskCostLimitUsd !== undefined && this.#taskCostUsd + price > taskCostLimitUsd)
      throw new CloudBudgetError('task_cost_limit', 'This task reached its cost limit');
    if (monthlyCostLimitUsd !== undefined && ledger.costUsd + price > monthlyCostLimitUsd)
      throw new CloudBudgetError('month_cost_limit', 'This month reached its cost limit');
  }

  /** 1 回掛け終えたら呼ぶ。`costUsd` を渡さないときは見積りで数える。 */
  record(costUsd?: number): void {
    const spent = costUsd ?? this.#config.pricePerCallUsd ?? 0;
    this.#taskCalls += 1;
    this.#taskCostUsd += spent;
    const month = this.#month();
    const ledger = this.#read();
    this.#write({
      ...ledger,
      month,
      calls: ledger.calls + 1,
      costUsd: Number((ledger.costUsd + spent).toFixed(6)),
    });
  }

  /** 提供元が「使い切った」と言ったとき。その月はもう掛けない。 */
  exhausted(): void {
    const month = this.#month();
    this.#write({ ...this.#read(), month, exhaustedMonth: month });
  }

  usage(): { tier: 'free' | 'paid'; taskCalls: number; monthCalls: number; monthCostUsd: number } {
    const ledger = this.#read();
    return {
      tier: this.tier,
      taskCalls: this.#taskCalls,
      monthCalls: ledger.calls,
      monthCostUsd: ledger.costUsd,
    };
  }

  #month(): string {
    return new Date(this.#now()).toISOString().slice(0, 7);
  }

  #read(): Ledger {
    let parsed: Partial<Ledger>;
    try {
      parsed = JSON.parse(readFileSync(this.#config.statePath, 'utf8')) as Partial<Ledger>;
    } catch {
      return { ...EMPTY, month: this.#month() };
    }
    // 月が変われば数え直す。使い切った印だけは、その月のものとして残す。
    const month = this.#month();
    if (parsed.month !== month)
      return {
        ...EMPTY,
        month,
        ...(parsed.exhaustedMonth ? { exhaustedMonth: parsed.exhaustedMonth } : {}),
      };
    return {
      month,
      calls: Number.isInteger(parsed.calls) ? (parsed.calls as number) : 0,
      costUsd: Number.isFinite(parsed.costUsd) ? (parsed.costUsd as number) : 0,
      ...(parsed.exhaustedMonth ? { exhaustedMonth: parsed.exhaustedMonth } : {}),
    };
  }

  #write(ledger: Ledger): void {
    mkdirSync(dirname(this.#config.statePath), { recursive: true, mode: 0o700 });
    // 書き換えの途中で落ちても台帳が壊れないように、別名で書いてから置き換える。
    const temporary = join(dirname(this.#config.statePath), `.${process.pid}.ledger`);
    writeFileSync(temporary, JSON.stringify(ledger), { mode: 0o600 });
    renameSync(temporary, this.#config.statePath);
  }
}
