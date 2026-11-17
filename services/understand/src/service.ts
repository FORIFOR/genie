/**
 * 送るだけで、Genie が判断する。
 *
 *   写真・外国語の文 → 読む（model.ts）→ 値を検める → 家計簿に付ける / 目安を返す / 予定の確かめ / 訳す
 *                                                  / Genie への頼みとして渡す / 短く聞き返す
 *
 * 返事は 1〜3 行。うまくいったことは結果だけ伝える。確かめるのは、次のときだけ:
 *   - レシートの読みに自信が無い（確かさ 0.85 未満・合計と明細が合わない・日付がおかしい・円でない）
 *   - 予定に入れる（カレンダーへの書き込みは、そのあと承認カードでもう一度確かめる）
 * 付けたものは「取り消して」で取り消せる。
 *
 * 確かめ中の案と「直前に付けたもの」「直前に訳したもの」は、このプロセスの中に 10〜30 分だけ持つ
 * （gateway を起動し直すと消える。消えても、もう一度送れば同じことができる）。
 */
import { createHash } from 'node:crypto';
import type { ExpenseStore, Expense, NewExpense } from './expenses.js';
import { languageName, looksForeign } from './language.js';
import type { GroupReplyInput, MinutesInput, UnderstandImage, Understander } from './model.js';
import { MemoryPending, type PendingBox } from './pending.js';
import { EXPENSE_CATEGORIES, type CallMinutes, type Understanding } from './schema.js';
import type { SharedSpaceService } from './shared.js';

/**
 * 誰の、どの家計簿か。householdId があれば共有スペース（グループ）の家計簿、無ければ本人の個人の家計簿。
 */
type Principal = {
  readonly tenantId: string;
  readonly userId: string;
  readonly householdId?: string | null;
};
const scopeOf = (p: Principal) => ({
  tenantId: p.tenantId,
  userId: p.userId,
  householdId: p.householdId ?? null,
});

/** チャネルから届いた 1 通をどう扱うか。null なら、いつもどおり Genie に渡す。 */
export type InboundOutcome =
  | { readonly kind: 'reply'; readonly text: string }
  | { readonly kind: 'turn'; readonly text: string }
  | null;

/** handleTurn の決まった言い方（はい・取り消して・家計簿・予算・返信して）の答え。 */
export interface UnderstandAnswer {
  readonly answer: string;
  readonly needsClarification: boolean;
  /** 「はい」で始める頼み（予定をカレンダーへ）。handleTurn はこの文で振り分け直す。 */
  readonly request?: string;
}

export interface UnderstandServiceDeps {
  /** 無ければ写真は読めない（そう答える）。外国語の文は、いつもどおり Genie に渡す。 */
  readonly understander: Understander | null;
  readonly expenses: Pick<ExpenseStore, 'add' | 'void' | 'monthTotals' | 'budgets' | 'setBudget'>;
  /** 利用者の時間帯（`GENIE_TIMEZONE`）。今日の日付と月の区切りに使う。 */
  readonly timeZone: string;
  readonly now?: () => number;
  readonly log?: (event: string, detail: Record<string, unknown>) => void;
  /** 個人の買い物リスト・TODO（1:1 のトークと Task Dock から）。 */
  readonly lists?: Pick<SharedSpaceService, 'handle'>;
  /** 確かめている途中のこと。無ければプロセスの記憶（再起動で消える）。本番は PendingStore（DB）。 */
  readonly pending?: PendingBox;
}

interface Recent {
  expense?: { readonly id: string; readonly label: string; readonly at: number };
  foreign?: { readonly text: string; readonly language: string; readonly at: number };
  /** 直前に読んだ写真（通話の「さっきの写真を見て」に答えるため。写真そのものは持たない）。 */
  photo?: { readonly description: string; readonly at: number };
}

const PROPOSAL_MS = 10 * 60 * 1000;
const RECENT_MS = 30 * 60 * 1000;
/** これ以上なら確かめずに付ける。 */
const AUTO_CONFIDENCE = 0.85;
const MAX_AMOUNT = 1_000_000;

const YES =
  /^\s*(?:はい|うん|ええ|お願い(?:します)?|おねがい|ok|okay|オーケー|いいよ|いいです|登録して|入れて|yes)[。.!！\s]*$/i;
const NO =
  /^\s*(?:いいえ|いや|いらない|やめて|やめる|キャンセル|しない|大丈夫です?|no)[。.!！\s]*$/i;
/** レシート・領収書を家計簿に（写真の無い文だけで届いたとき）。 */
const RECEIPT_WITHOUT_PHOTO =
  /(?:レシート|領収書|れしーと|りょうしゅうしょ).{0,12}(?:家計簿|かけいぼ).{0,6}(?:入れ|いれ|付け|つけ|登録|記録)|(?:家計簿|かけいぼ).{0,6}(?:に|へ).{0,8}(?:レシート|領収書)/;

/** 確かめ中の家計簿を直したい（中身なしの「修正する」）。 */
const FIX =
  /^\s*(?:修正|しゅうせい|直す|なおす|直して|訂正|ちがう|違う)(?:する|して|したい)?[。!！\s]*$/;

/**
 * 「金額は1280円」「日付は昨日」「費目は外食」「店はローソン」から、直すところだけを読む。何も読めなければ null。
 * 金額は数字だけ（記号・桁区切りを外す）。日付は今日・昨日・おととい・M/D（未来なら去年）。
 */
export function correctionOf(
  text: string,
  today: string,
  _timeZone: string,
): Partial<Pick<NewExpense, 'amount' | 'spentOn' | 'category' | 'merchant'>> | null {
  const fix: { amount?: number; spentOn?: string; category?: string; merchant?: string } = {};
  const amount = /([\d,，]+)\s*円/.exec(text);
  if (amount) {
    const n = Number(amount[1]!.replace(/[,，]/g, ''));
    if (Number.isFinite(n) && n > 0 && n < 100_000_000) fix.amount = n;
  }
  const [y, m, d] = today.split('-').map(Number) as [number, number, number];
  const shift = (days: number) => new Date(Date.UTC(y, m - 1, d - days)).toISOString().slice(0, 10);
  if (/おととい|一昨日/.test(text)) fix.spentOn = shift(2);
  else if (/昨日|きのう/.test(text)) fix.spentOn = shift(1);
  else if (/日付は?\s*今日|今日の/.test(text)) fix.spentOn = today;
  else {
    const md = /(\d{1,2})\s*[\/月]\s*(\d{1,2})\s*日?/.exec(text);
    if (md) {
      const mo = Number(md[1]);
      const da = Number(md[2]);
      const year = Date.UTC(y, mo - 1, da) > Date.UTC(y, m - 1, d) ? y - 1 : y;
      if (mo >= 1 && mo <= 12 && da >= 1 && da <= 31)
        fix.spentOn = `${String(year)}-${String(mo).padStart(2, '0')}-${String(da).padStart(2, '0')}`;
    }
  }
  const category = EXPENSE_CATEGORIES.find((c) => text.includes(c));
  if (category) fix.category = category;
  const merchant = /(?:店|お店|店名)\s*(?:は|を)\s*([^\s。、]{1,30}?)(?:に|で|です|。|$)/.exec(
    text,
  );
  if (merchant) fix.merchant = merchant[1]!;
  return Object.keys(fix).length ? fix : null;
}

const UNDO =
  /^\s*(?:さっきの|今の|いまの)?(?:登録|家計簿|それ|レシート)?(?:を|は)?(?:取り消して|取消して|消して|なしにして|やっぱりなし)[。.!！\s]*$/;
const SHOW = /^\s*(?:今月の)?(?:家計簿|支出)(?:を)?(?:見せて|教えて|出して|確認して)?[？?。.\s]*$/;
/** 「今月あといくら使える？」「残りの予算は？」 */
const REMAINING =
  /^\s*(?:今月(?:は)?)?\s*(?:あと|残り(?:の予算)?(?:は)?)\s*(?:いくら|どれくらい|何円)?\s*(?:使える|残ってる|ある)?[？?。.\s]*$/;
const CATEGORY_TOTAL = new RegExp(
  `^\\s*今月の(${EXPENSE_CATEGORIES.join('|')})(?:は|って)?(?:いくら|どれくらい)?[？?。.\\s]*$`,
);
const BUDGET = new RegExp(
  `^\\s*(${EXPENSE_CATEGORIES.join('|')})の予算を\\s*([\\d,，.]+)\\s*(万)?\\s*円?に(?:して|する|設定して)?[。.\\s]*$`,
);
/** 「さっき送った写真を見て」「今の画像は何？」（通話・トークで、直前に読んだ写真を指す）。 */
const PHOTO_REF =
  /^\s*(?:さっき|今|いま|先ほど)?(?:の|送った|送っ(?:て|た)|LINEに送った|ラインに送った)?\s*(?:写真|画像|レシート|スクショ)(?:を|は|って|について)?(?:見て|見た|教えて|説明して|何|なに|どう|読んで)?.{0,12}$/;
const REPLY =
  /^\s*(?:これに|この(?:メッセージ|文|メール)に)?返信(?:して|を作って|文を作って|案を作って)(?:[、,\s]*(.*))?$/;

export class UnderstandService {
  readonly #now: () => number;
  readonly #pending: PendingBox;
  readonly #recent = new Map<string, Recent>();

  constructor(private readonly deps: UnderstandServiceDeps) {
    this.#now = deps.now ?? Date.now;
    this.#pending = deps.pending ?? new MemoryPending();
  }

  /** グループの会話を踏まえた答え。モデルが無い・書けなければ null。 */
  async groupReply(input: GroupReplyInput): Promise<string | null> {
    const write = this.deps.understander?.groupReply?.bind(this.deps.understander);
    if (!write) return null;
    try {
      return await write(input);
    } catch (err) {
      this.deps.log?.('understand.group_reply_failed', { error: (err as Error).message });
      return null;
    }
  }

  /**
   * 通話の議事録。モデルが無い・書けなかったときは null（呼ぶ側が決まった形で組み立てる）。
   * 渡すのは、その通話の文字起こしと頼みの結果だけ。
   */
  async callMinutes(input: MinutesInput): Promise<CallMinutes | null> {
    const write = this.deps.understander?.minutes?.bind(this.deps.understander);
    if (!write || (input.transcript.length === 0 && input.requests.length === 0)) return null;
    try {
      return await write(input);
    } catch (err) {
      this.deps.log?.('understand.minutes_failed', { error: (err as Error).message });
      return null;
    }
  }

  /** チャネルから届いた 1 通。写真か外国語の文だけを読む。それ以外は null（いつもどおり）。 */
  async inbound(
    principal: Principal,
    conversationId: string,
    input: {
      readonly text: string;
      readonly images: readonly UnderstandImage[];
      readonly source: string;
      /** 共有スペース（グループ）で付けた人の表示名。 */
      readonly recordedBy?: string | null;
      /**
       * グループから。個人のもの（予定・Genie への頼み）に回さない。
       * 'receipts' はメンションなしの写真（レシートのときだけ付け、ほかは黙る）。
       */
      readonly shared?: 'mentioned' | 'receipts';
    },
  ): Promise<InboundOutcome> {
    const hasImages = input.images.length > 0;
    if (!hasImages && !looksForeign(input.text)) return null;
    const understander = this.deps.understander;
    if (!understander) {
      return hasImages
        ? { kind: 'reply', text: 'この Genie では、まだ写真を読めません。文字で送ってください。' }
        : null;
    }
    let read: Understanding;
    try {
      read = await understander.understand({
        text: input.text,
        images: input.images,
        today: this.#today(),
        timeZone: this.deps.timeZone,
      });
    } catch (error) {
      this.#log('understand.failed', { error: error instanceof Error ? error.message : 'unknown' });
      return hasImages
        ? { kind: 'reply', text: '写真を読めませんでした。もう一度送ってください。' }
        : null;
    }
    this.#log('understand.read', {
      kind: read.kind,
      intent: read.intent,
      confidence: read.confidence,
      language: read.source_language,
    });
    const foreign = read.source_language !== 'ja' && read.source_language !== 'none';
    if (foreign)
      this.#remember(conversationId, {
        foreign: {
          text: input.text || read.translation_ja || read.summary_ja,
          language: read.source_language,
          at: this.#now(),
        },
      });

    if (hasImages)
      this.#remember(conversationId, { photo: { description: photoText(read), at: this.#now() } });
    if (input.shared === 'receipts' && !(read.intent === 'record_expense' && read.receipt))
      return null;
    if (input.shared && (read.intent === 'add_event' || read.intent === 'request')) {
      // グループからは持ち主の予定や仕事に触れない。読んだことだけ返す
      return {
        kind: 'reply',
        text: `${explainText(read, foreign)}\n予定に入れる・頼むのは、Genie との 1 対 1 のトークでどうぞ。`,
      };
    }
    switch (read.intent) {
      case 'record_expense':
        if (read.receipt) return this.#receipt(principal, conversationId, read, input);
        break;
      case 'estimate_meal':
        if (read.meal) return { kind: 'reply', text: mealText(read.meal) };
        break;
      case 'add_event':
        if (read.event) return this.#event(principal, conversationId, read);
        break;
      case 'request': {
        const request = read.request_ja?.trim() || input.text.trim();
        if (!request) break;
        return {
          kind: 'turn',
          text: hasImages ? `${request}\n（送った写真: ${read.summary_ja.trim()}）` : request,
        };
      }
      case 'unclear':
        return { kind: 'reply', text: read.question_ja?.trim() || 'これをどうしましょうか？' };
      case 'translate':
      case 'explain':
        break;
    }
    return { kind: 'reply', text: explainText(read, foreign) };
  }

  /** handleTurn から。決まった言い方だけを読む。違えば null。 */
  async handle(
    principal: Principal,
    conversationId: string,
    text: string,
  ): Promise<UnderstandAnswer | null> {
    const pending = await this.#pending.get(principal.tenantId, conversationId, this.#now());
    if (pending && YES.test(text)) {
      await this.#pending.delete(principal.tenantId, conversationId);
      if (pending.kind === 'event') {
        return { answer: '予定に入れます。', needsClarification: false, request: pending.request };
      }
      return {
        answer: await this.#add(principal, conversationId, pending.expense),
        needsClarification: false,
      };
    }
    if (pending && NO.test(text)) {
      await this.#pending.delete(principal.tenantId, conversationId);
      return {
        answer: pending.kind === 'event' ? '予定には入れません。' : '家計簿には付けません。',
        needsClarification: false,
      };
    }

    // 「レシート家計簿に入れて」が文だけで届いた（写真が無い）。読むものが無いので、写真を頼む（仕様 v1.0 §1）
    if (RECEIPT_WITHOUT_PHOTO.test(text) && !pending)
      return {
        answer:
          'レシートの写真はまだ届いていません。写真を送ってください。読み取って、金額と日付を確かめてから家計簿に付けます。',
        needsClarification: true,
      };

    // 家計簿に付ける前の直し（「修正する」「金額は1280円」「日付は昨日」「費目は外食」）。仕様 v1.0 §11
    if (pending?.kind === 'expense') {
      if (FIX.test(text) && !correctionOf(text, this.#today(), this.deps.timeZone))
        return {
          answer:
            'どこを直しますか？ 例:「金額は1280円」「日付は昨日」「費目は外食」「店はローソン」',
          needsClarification: true,
        };
      const fix = correctionOf(text, this.#today(), this.deps.timeZone);
      if (fix) {
        const expense = { ...pending.expense, ...fix };
        await this.#pending.set(principal.tenantId, conversationId, {
          kind: 'expense',
          expense,
          expiresAt: this.#now() + PROPOSAL_MS,
        });
        return {
          answer: `直しました。家計簿に付けますか？ ${expenseLabel(expense)}\nはい / 修正する / いいえ`,
          needsClarification: true,
        };
      }
    }

    const recent = this.#recentFor(conversationId);
    if (recent?.expense && UNDO.test(text)) {
      const done = await this.deps.expenses.void(scopeOf(principal), recent.expense.id);
      const { expense: _done, ...rest } = this.#recent.get(conversationId) ?? {};
      this.#recent.set(conversationId, rest);
      return {
        answer: done ? `${recent.expense.label}を取り消しました。` : 'もう取り消してあります。',
        needsClarification: false,
      };
    }

    if (recent?.photo && PHOTO_REF.test(text)) {
      return { answer: `さっきの写真は、${recent.photo.description}`, needsClarification: false };
    }

    const reply = recent?.foreign ? REPLY.exec(text) : null;
    if (reply && recent?.foreign && this.deps.understander) {
      const draft = await this.deps.understander.draftReply(
        recent.foreign.text,
        recent.foreign.language,
        reply[1]?.trim() ?? '',
      );
      return {
        answer: `返信の案（${languageName(recent.foreign.language)}）:\n${draft}`,
        needsClarification: false,
      };
    }

    if (SHOW.test(text))
      return { answer: await this.#monthText(principal), needsClarification: false };
    if (REMAINING.test(text))
      return { answer: await this.#remainingText(principal), needsClarification: false };
    const category = CATEGORY_TOTAL.exec(text);
    if (category) {
      return {
        answer: await this.#categoryText(principal, category[1]!),
        needsClarification: false,
      };
    }
    const budget = BUDGET.exec(text);
    if (budget) {
      const amount = Number(budget[2]!.replace(/[,，]/g, '')) * (budget[3] ? 10_000 : 1);
      if (!Number.isFinite(amount) || amount <= 0 || amount > 100 * MAX_AMOUNT) return null;
      await this.deps.expenses.setBudget(scopeOf(principal), budget[1]!, 'JPY', amount);
      return {
        answer: `${budget[1]!}の予算を月 ${yen(amount)} にしました。`,
        needsClarification: false,
      };
    }
    // 個人の買い物リスト・TODO（グループの言い方は gateway が先に読む）
    if (!principal.householdId && this.deps.lists) {
      const answer = await this.deps.lists.handle({ ...scopeOf(principal), speaker: null }, text);
      if (answer) return { answer, needsClarification: false };
    }
    return null;
  }

  async #receipt(
    principal: Principal,
    conversationId: string,
    read: Understanding,
    input: {
      readonly images: readonly UnderstandImage[];
      readonly source: string;
      readonly recordedBy?: string | null;
    },
  ): Promise<InboundOutcome> {
    const r = read.receipt!;
    const today = this.#today();
    const amount = Math.round(r.total * 100) / 100;
    if (!(amount > 0 && amount <= MAX_AMOUNT)) {
      return {
        kind: 'reply',
        text: 'レシートの合計を読めませんでした。合計が写るように撮り直してください。',
      };
    }
    const currency = /^[A-Z]{3}$/.test(r.currency.toUpperCase()) ? r.currency.toUpperCase() : 'JPY';
    const dateOk = r.date !== null && plausibleDate(r.date, today);
    const expense: NewExpense = {
      amount,
      currency,
      category: r.category,
      merchant: r.merchant?.trim() || null,
      spentOn: dateOk ? r.date! : today,
      source: input.source,
      imageSha256: input.images[0]
        ? createHash('sha256').update(input.images[0].data).digest('hex')
        : null,
      recordedBy: input.recordedBy ?? null,
    };
    const sumMatches =
      r.items_sum === null || Math.abs(r.items_sum - r.total) <= Math.max(1, r.total * 0.01);
    const sure = read.confidence >= AUTO_CONFIDENCE && sumMatches && dateOk && currency === 'JPY';
    if (sure) return { kind: 'reply', text: await this.#add(principal, conversationId, expense) };

    await this.#pending.set(principal.tenantId, conversationId, {
      kind: 'expense',
      expense,
      expiresAt: this.#now() + PROPOSAL_MS,
    });
    const doubts = [
      !dateOk ? '日付が読めないので今日にしています' : null,
      !sumMatches ? '明細と合計が合いません' : null,
      currency !== 'JPY' ? `${currency} のまま付けます` : null,
    ].filter(Boolean);
    return {
      kind: 'reply',
      text: [
        `家計簿に付けますか？ ${expenseLabel(expense)}`,
        doubts.length ? `（${doubts.join('。')}）` : null,
        // LINE ではこの 3 つがボタン（Quick Reply）になる
        'はい / 修正する / いいえ',
      ]
        .filter(Boolean)
        .join('\n'),
    };
  }

  async #event(
    principal: Principal,
    conversationId: string,
    read: Understanding,
  ): Promise<InboundOutcome> {
    const e = read.event!;
    const when = [
      e.date,
      e.start_time ? `${e.start_time}${e.end_time ? `〜${e.end_time}` : '〜'}` : null,
    ]
      .filter(Boolean)
      .join(' ');
    const request = `カレンダーに予定を入れて: ${e.title} ${when}${e.place ? ` 場所: ${e.place}` : ''}`;
    await this.#pending.set(principal.tenantId, conversationId, {
      kind: 'event',
      request,
      expiresAt: this.#now() + PROPOSAL_MS,
    });
    return {
      kind: 'reply',
      text: `予定を見つけました: ${e.title}\n${when}${e.place ? `（${e.place}）` : ''}\nカレンダーに入れますか？ はい / いいえ`,
    };
  }

  async #add(principal: Principal, conversationId: string, expense: NewExpense): Promise<string> {
    const { result, expense: row } = await this.deps.expenses.add(scopeOf(principal), expense);
    if (result === 'duplicate') {
      return `このレシートはもう付けてあります（${expenseLabel({ ...row, spentOn: row.spentOn })}）。`;
    }
    const label = expenseLabel(row);
    this.#remember(conversationId, { expense: { id: row.id, label, at: this.#now() } });
    const month = row.spentOn.slice(0, 7);
    const [totals, budgets] = await Promise.all([
      this.deps.expenses.monthTotals(scopeOf(principal), month),
      this.deps.expenses.budgets(scopeOf(principal)),
    ]);
    const total = totals.find((t) => t.category === row.category && t.currency === row.currency);
    const budget = budgets.find((b) => b.category === row.category && b.currency === row.currency);
    const monthLabel =
      month === this.#today().slice(0, 7) ? '今月' : `${String(Number(month.slice(5)))}月`;
    return [
      `${row.category} ${money(row.amount, row.currency)}を家計簿に付けました。`,
      total
        ? `${monthLabel}の${row.category}は ${money(total.total, row.currency)}${budget ? ` / ${money(budget.monthly, row.currency)}` : ''}です。`
        : null,
      '違っていたら「取り消して」。',
    ]
      .filter(Boolean)
      .join('');
  }

  async #monthText(principal: Principal): Promise<string> {
    const month = this.#today().slice(0, 7);
    const [totals, budgets] = await Promise.all([
      this.deps.expenses.monthTotals(scopeOf(principal), month),
      this.deps.expenses.budgets(scopeOf(principal)),
    ]);
    if (totals.length === 0) return '今月の家計簿はまだ空です。レシートの写真を送ると付けます。';
    const byCurrency = new Map<string, number>();
    for (const t of totals) byCurrency.set(t.currency, (byCurrency.get(t.currency) ?? 0) + t.total);
    const lines = totals.slice(0, 10).map((t) => {
      const b = budgets.find((x) => x.category === t.category && x.currency === t.currency);
      return `・${t.category} ${money(t.total, t.currency)}${b ? ` / ${money(b.monthly, t.currency)}` : ''}`;
    });
    return [`今月の支出 ${[...byCurrency].map(([c, v]) => money(v, c)).join('・')}`, ...lines].join(
      '\n',
    );
  }

  /** 予算の残り（予算を決めた費目だけ。決めていなければそう言う）。 */
  async #remainingText(principal: Principal): Promise<string> {
    const month = this.#today().slice(0, 7);
    const [totals, budgets] = await Promise.all([
      this.deps.expenses.monthTotals(scopeOf(principal), month),
      this.deps.expenses.budgets(scopeOf(principal)),
    ]);
    const yenBudgets = budgets.filter((b) => b.currency === 'JPY');
    if (yenBudgets.length === 0)
      return '予算がまだ決まっていません。「食費の予算を6万円にして」のように決めると、残りをお答えできます。';
    const lines = yenBudgets.map((b) => {
      const spent =
        totals.find((t) => t.category === b.category && t.currency === 'JPY')?.total ?? 0;
      return { category: b.category, left: b.monthly - spent };
    });
    const total = lines.reduce((sum, l) => sum + l.left, 0);
    return [
      `今月の予算の残りは ${yen(Math.max(0, total))} です。`,
      ...lines.map(
        (l) =>
          `・${l.category} ${l.left >= 0 ? `残り ${yen(l.left)}` : `${yen(-l.left)} 超えています`}`,
      ),
    ].join('\n');
  }

  async #categoryText(principal: Principal, category: string): Promise<string> {
    const month = this.#today().slice(0, 7);
    const [totals, budgets] = await Promise.all([
      this.deps.expenses.monthTotals(scopeOf(principal), month),
      this.deps.expenses.budgets(scopeOf(principal)),
    ]);
    const t = totals.find((x) => x.category === category && x.currency === 'JPY');
    const b = budgets.find((x) => x.category === category && x.currency === 'JPY');
    const spent = t?.total ?? 0;
    return `今月の${category}は ${yen(spent)}${b ? `（予算 ${yen(b.monthly)}、残り ${yen(Math.max(0, b.monthly - spent))}）` : ''}です。`;
  }

  #today(): string {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: this.deps.timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date(this.#now()));
  }

  #recentFor(conversationId: string): Recent | null {
    const r = this.#recent.get(conversationId);
    if (!r) return null;
    const now = this.#now();
    const fresh: Recent = {
      ...(r.expense && now - r.expense.at < RECENT_MS ? { expense: r.expense } : {}),
      ...(r.foreign && now - r.foreign.at < RECENT_MS ? { foreign: r.foreign } : {}),
      ...(r.photo && now - r.photo.at < RECENT_MS ? { photo: r.photo } : {}),
    };
    return fresh.expense || fresh.foreign || fresh.photo ? fresh : null;
  }

  #remember(conversationId: string, patch: Partial<Recent>): void {
    // 古い会話の控えを溜めない
    if (this.#recent.size > 1_000) {
      const oldest = this.#recent.keys().next().value;
      if (oldest !== undefined) this.#recent.delete(oldest);
    }
    this.#recent.set(conversationId, { ...this.#recent.get(conversationId), ...patch });
  }

  #log(event: string, detail: Record<string, unknown>): void {
    this.deps.log?.(event, detail);
  }
}

/** 今日から 1 年前〜明日まで（未来の日付・古すぎる日付は読み違いとみなす）。 */
function plausibleDate(date: string, today: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const t = Date.parse(`${date}T00:00:00Z`);
  const now = Date.parse(`${today}T00:00:00Z`);
  return Number.isFinite(t) && t <= now + 86_400_000 && t >= now - 366 * 86_400_000;
}

const yen = (n: number) => `¥${Math.round(n).toLocaleString('ja-JP')}`;
function money(n: number, currency: string): string {
  return currency === 'JPY' ? yen(n) : `${n.toLocaleString('en-US')} ${currency}`;
}

function expenseLabel(
  e: Pick<Expense, 'amount' | 'currency' | 'category' | 'merchant' | 'spentOn'>,
): string {
  const [, m, d] = e.spentOn.split('-');
  return `${e.category} ${money(e.amount, e.currency)}（${e.merchant ? `${e.merchant}・` : ''}${String(Number(m))}/${String(Number(d))}）`;
}

function mealText(m: NonNullable<Understanding['meal']>): string {
  const kcal =
    Math.round(m.kcal_low) === Math.round(m.kcal_high)
      ? `約 ${String(Math.round(m.kcal_low))} kcal`
      : `約 ${String(Math.round(m.kcal_low))}〜${String(Math.round(m.kcal_high))} kcal`;
  const pfc = [
    m.protein_g !== null ? `たんぱく質 ${String(Math.round(m.protein_g))}g` : null,
    m.fat_g !== null ? `脂質 ${String(Math.round(m.fat_g))}g` : null,
    m.carbs_g !== null ? `炭水化物 ${String(Math.round(m.carbs_g))}g` : null,
  ].filter(Boolean);
  return [
    `${m.name}ですね。${kcal}${pfc.length ? `（${pfc.join('・')}）` : ''}。`,
    '写真からの目安です。量や油の量までは分かりません。',
  ].join('\n');
}

/** 写真を言葉にしたもの（覚えておく分。金額や名前は読んだ値だけ）。 */
function photoText(read: Understanding): string {
  const parts = [read.summary_ja.trim()];
  if (read.receipt)
    parts.push(
      `${read.receipt.merchant ?? '店名は読めず'}・合計 ${String(read.receipt.total)} ${read.receipt.currency}（${read.receipt.category}）`,
    );
  if (read.meal)
    parts.push(
      `${read.meal.name}（約 ${String(Math.round(read.meal.kcal_low))}〜${String(Math.round(read.meal.kcal_high))} kcal）`,
    );
  if (read.event)
    parts.push(`${read.event.title} ${read.event.date} ${read.event.start_time ?? ''}`.trim());
  if (read.translation_ja) parts.push(`日本語にすると「${read.translation_ja.trim()}」`);
  return parts.filter(Boolean).join('。').slice(0, 600);
}

function explainText(read: Understanding, foreign: boolean): string {
  const translation = read.translation_ja?.trim();
  if (foreign && translation) {
    const head = `${languageName(read.source_language)} → 日本語`;
    const extra =
      read.intent === 'explain' && read.summary_ja.trim() !== translation
        ? `\n${read.summary_ja.trim()}`
        : '';
    return `${head}\n${translation}${extra}`;
  }
  return read.summary_ja.trim() || 'これをどうしましょうか？';
}
