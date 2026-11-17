import { describe, expect, it } from 'vitest';
import {
  MemoryPending,
  ScriptedUnderstander,
  correctionOf,
  UnderstandService,
  looksForeign,
  type Expense,
  type ExpenseScope,
  type NewExpense,
  type Understanding,
} from '../src/index.js';

const principal = { tenantId: 't', userId: 'u' };
const scope = { ...principal, householdId: null };
const NOW = Date.parse('2026-10-23T03:00:00Z'); // 10/23 12:00 JST
const photo = { mediaType: 'image/jpeg', data: new Uint8Array([1, 2, 3]) };

function read(over: Partial<Understanding>): Understanding {
  return {
    kind: 'other',
    intent: 'explain',
    confidence: 0.95,
    source_language: 'ja',
    summary_ja: '',
    translation_ja: null,
    receipt: null,
    meal: null,
    event: null,
    request_ja: null,
    question_ja: null,
    ...over,
  };
}

const receipt = (over: Partial<NonNullable<Understanding['receipt']>> = {}, confidence = 0.97) =>
  read({
    kind: 'receipt',
    intent: 'record_expense',
    confidence,
    receipt: {
      merchant: 'スーパー',
      date: '2026-10-22',
      total: 2480,
      currency: 'JPY',
      category: '食費',
      items_sum: 2480,
      ...over,
    },
  });

/** DB の代わり。同じ指紋は duplicate にする。 */
class FakeBook {
  rows: (Expense & { key: string; voided: boolean })[] = [];
  budgetsList: { category: string; currency: string; monthly: number }[] = [];
  async add(_s: ExpenseScope, e: NewExpense) {
    const key = `${e.merchant}|${e.spentOn}|${String(e.amount)}|${e.imageSha256 ?? ''}`;
    const same = this.rows.find((r) => !r.voided && r.key === key);
    if (same) return { result: 'duplicate' as const, expense: same };
    const row = {
      id: `e${String(this.rows.length + 1)}`,
      amount: e.amount,
      currency: e.currency,
      category: e.category,
      merchant: e.merchant,
      spentOn: e.spentOn,
      createdAt: '',
      key,
      voided: false,
    };
    this.rows.push(row);
    return { result: 'added' as const, expense: row };
  }
  async void(_s: ExpenseScope, id: string) {
    const row = this.rows.find((r) => r.id === id && !r.voided);
    if (row) row.voided = true;
    return Boolean(row);
  }
  async monthTotals(_s: ExpenseScope, month: string) {
    const map = new Map<
      string,
      { category: string; currency: string; total: number; count: number }
    >();
    for (const r of this.rows.filter((x) => !x.voided && x.spentOn.startsWith(month))) {
      const k = `${r.category}|${r.currency}`;
      const v = map.get(k) ?? { category: r.category, currency: r.currency, total: 0, count: 0 };
      v.total += r.amount;
      v.count += 1;
      map.set(k, v);
    }
    return [...map.values()];
  }
  async budgets() {
    return this.budgetsList;
  }
  async setBudget(_s: ExpenseScope, category: string, currency: string, monthly: number) {
    this.budgetsList = [
      ...this.budgetsList.filter((b) => b.category !== category),
      { category, currency, monthly },
    ];
  }
}

function setup(answers: Understanding[]) {
  const book = new FakeBook();
  const understander = new ScriptedUnderstander(answers, 'Sure, see you next week.');
  const service = new UnderstandService({
    understander,
    expenses: book,
    timeZone: 'Asia/Tokyo',
    now: () => NOW,
  });
  return { book, understander, service };
}

describe('looksForeign', () => {
  it('reads Japanese as Japanese and other scripts as foreign', () => {
    expect(looksForeign('明日の会議の資料を作って')).toBe(false);
    expect(looksForeign('Slack で返事して')).toBe(false);
    expect(looksForeign('OK')).toBe(false);
    expect(looksForeign('https://example.com/some/long/english/path')).toBe(false);
    expect(looksForeign('Your flight has been delayed by approximately two hours.')).toBe(true);
    expect(looksForeign('안녕하세요 내일 만나요')).toBe(true);
    expect(looksForeign('您的订单已经发货了请注意查收')).toBe(true);
  });
});

describe('UnderstandService.inbound', () => {
  it('passes plain Japanese text through without calling the model', async () => {
    const { service, understander } = setup([]);
    expect(
      await service.inbound(principal, 'c', { text: '明日の天気は？', images: [], source: 'line' }),
    ).toBeNull();
    expect(understander.calls).toHaveLength(0);
  });

  it('records a clear receipt, reports the month, and undoes it', async () => {
    const { service, book } = setup([receipt()]);
    await book.setBudget(scope, '食費', 'JPY', 60_000);
    const out = await service.inbound(principal, 'c', {
      text: '',
      images: [photo],
      source: 'line',
    });
    expect(out).toEqual({
      kind: 'reply',
      text: '食費 ¥2,480を家計簿に付けました。今月の食費は ¥2,480 / ¥60,000です。違っていたら「取り消して」。',
    });
    expect(book.rows).toHaveLength(1);

    const undo = await service.handle(principal, 'c', '取り消して');
    expect(undo?.answer).toBe('食費 ¥2,480（スーパー・10/22）を取り消しました。');
    expect(book.rows[0]!.voided).toBe(true);
    // 取り消したあとの「取り消して」は家計簿の話ではない（予約などに回す）
    expect(await service.handle(principal, 'c', '取り消して')).toBeNull();
  });

  it('does not record the same receipt twice', async () => {
    const { service, book } = setup([receipt(), receipt()]);
    await service.inbound(principal, 'c', { text: '', images: [photo], source: 'line' });
    const again = await service.inbound(principal, 'c', {
      text: '',
      images: [photo],
      source: 'line',
    });
    expect(again).toEqual({
      kind: 'reply',
      text: 'このレシートはもう付けてあります（食費 ¥2,480（スーパー・10/22））。',
    });
    expect(book.rows).toHaveLength(1);
  });

  it('asks before recording when the totals disagree, and records on はい', async () => {
    const { service, book } = setup([receipt({ items_sum: 1980 })]);
    const out = await service.inbound(principal, 'c', {
      text: '',
      images: [photo],
      source: 'line',
    });
    expect(out).toEqual({
      kind: 'reply',
      text: '家計簿に付けますか？ 食費 ¥2,480（スーパー・10/22）\n（明細と合計が合いません）\nはい / 修正する / いいえ',
    });
    expect(book.rows).toHaveLength(0);
    const yes = await service.handle(principal, 'c', 'はい');
    expect(yes?.answer).toContain('食費 ¥2,480を家計簿に付けました。');
    expect(book.rows).toHaveLength(1);
  });

  // 仕様 v1.0 §11: 金額と日付を確かめ、直してから付ける。確かめ中は再起動しても消えない
  it('lets the person correct amount, date and category before recording, across a restart', async () => {
    const pending = new MemoryPending();
    const book = new FakeBook();
    const make = (answers: Understanding[]) =>
      new UnderstandService({
        understander: new ScriptedUnderstander(answers, 'x'),
        expenses: book,
        timeZone: 'Asia/Tokyo',
        now: () => NOW,
        pending,
      });
    await make([receipt({ items_sum: 1980 })]).inbound(principal, 'c', {
      text: '',
      images: [photo],
      source: 'line',
    });
    // ここで Genie が再起動した（同じ確かめ中の置き場を、新しい service が読む）
    const service = make([]);
    expect((await service.handle(principal, 'c', '修正する'))?.answer).toContain(
      'どこを直しますか？',
    );
    const fixed = await service.handle(principal, 'c', '金額は1,980円、日付は昨日、費目は外食で');
    expect(fixed?.answer).toMatch(/^直しました。家計簿に付けますか？ 外食 ¥1,980/);
    expect(fixed?.answer).toContain('はい / 修正する / いいえ');
    expect(book.rows).toHaveLength(0);
    await service.handle(principal, 'c', 'はい');
    expect(book.rows).toHaveLength(1);
    expect(book.rows[0]).toMatchObject({ amount: 1980, category: '外食' });
  });

  it('asks for the photo when a receipt is asked for in words only', async () => {
    const { service, book } = setup([]);
    const out = await service.handle(principal, 'c', '昨日のレシートも家計簿に入れて');
    expect(out).toEqual({
      answer: 'レシートの写真はまだ届いていません。写真を送ってください。読み取って、金額と日付を確かめてから家計簿に付けます。',
      needsClarification: true,
    });
    expect(book.rows).toHaveLength(0);
  });

  it('reads corrections, and only corrections', () => {
    const today = '2026-10-27';
    expect(correctionOf('金額は1280円', today, 'Asia/Tokyo')).toEqual({ amount: 1280 });
    expect(correctionOf('日付はおととい', today, 'Asia/Tokyo')).toEqual({ spentOn: '2026-10-25' });
    expect(correctionOf('12/30の分', today, 'Asia/Tokyo')).toEqual({ spentOn: '2025-12-30' });
    expect(correctionOf('店はローソンです', today, 'Asia/Tokyo')).toEqual({ merchant: 'ローソン' });
    expect(correctionOf('はい', today, 'Asia/Tokyo')).toBeNull();
  });

  it('asks when confidence is low or the date is implausible, and drops it on いいえ', async () => {
    const { service, book } = setup([receipt({ date: '2031-01-01' }, 0.6)]);
    const out = await service.inbound(principal, 'c', {
      text: '',
      images: [photo],
      source: 'line',
    });
    expect(out?.kind === 'reply' && out.text).toContain('日付が読めないので今日にしています');
    expect((await service.handle(principal, 'c', 'いいえ'))?.answer).toBe('家計簿には付けません。');
    expect(book.rows).toHaveLength(0);
  });

  it('gives a meal estimate as a range, marked as an estimate', async () => {
    const { service } = setup([
      read({
        kind: 'meal',
        intent: 'estimate_meal',
        meal: {
          name: '焼き鮭定食',
          kcal_low: 600,
          kcal_high: 700,
          protein_g: 35,
          fat_g: 20,
          carbs_g: 75,
        },
      }),
    ]);
    const out = await service.inbound(principal, 'c', {
      text: '',
      images: [photo],
      source: 'line',
    });
    expect(out).toEqual({
      kind: 'reply',
      text: '焼き鮭定食ですね。約 600〜700 kcal（たんぱく質 35g・脂質 20g・炭水化物 75g）。\n写真からの目安です。量や油の量までは分かりません。',
    });
  });

  it('proposes an event and hands the calendar request to Genie on はい', async () => {
    const { service } = setup([
      read({
        kind: 'event',
        intent: 'add_event',
        event: {
          title: '保護者会',
          date: '2026-11-12',
          start_time: '10:00',
          end_time: null,
          place: '体育館',
        },
      }),
    ]);
    const out = await service.inbound(principal, 'c', {
      text: '',
      images: [photo],
      source: 'line',
    });
    expect(out).toEqual({
      kind: 'reply',
      text: '予定を見つけました: 保護者会\n2026-11-12 10:00〜（体育館）\nカレンダーに入れますか？ はい / いいえ',
    });
    const yes = await service.handle(principal, 'c', 'はい');
    expect(yes?.request).toBe('カレンダーに予定を入れて: 保護者会 2026-11-12 10:00〜 場所: 体育館');
  });

  it('translates a foreign message and drafts a reply in that language', async () => {
    const { service } = setup([
      read({
        kind: 'message',
        intent: 'translate',
        source_language: 'en',
        summary_ja: '欠航の知らせ',
        translation_ja: '悪天候のため、飛行機の出発が約2時間遅れています。',
      }),
    ]);
    const out = await service.inbound(principal, 'c', {
      text: 'Your flight has been delayed by approximately two hours due to severe weather.',
      images: [],
      source: 'line',
    });
    expect(out).toEqual({
      kind: 'reply',
      text: '英語 → 日本語\n悪天候のため、飛行機の出発が約2時間遅れています。',
    });
    const reply = await service.handle(principal, 'c', 'これに返信して');
    expect(reply?.answer).toBe('返信の案（英語）:\nSure, see you next week.');
  });

  it('hands a foreign request to Genie in Japanese', async () => {
    const { service } = setup([
      read({
        kind: 'message',
        intent: 'request',
        source_language: 'en',
        request_ja: '明日の予定をまとめて',
      }),
    ]);
    const out = await service.inbound(principal, 'c', {
      text: 'Please summarize my schedule for tomorrow',
      images: [],
      source: 'line',
    });
    expect(out).toEqual({ kind: 'turn', text: '明日の予定をまとめて' });
  });

  it('says it cannot read photos when no model is configured', async () => {
    const service = new UnderstandService({
      understander: null,
      expenses: new FakeBook(),
      timeZone: 'Asia/Tokyo',
    });
    expect(
      await service.inbound(principal, 'c', { text: '', images: [photo], source: 'line' }),
    ).toEqual({
      kind: 'reply',
      text: 'この Genie では、まだ写真を読めません。文字で送ってください。',
    });
    expect(
      await service.inbound(principal, 'c', {
        text: 'Your flight has been delayed by two hours.',
        images: [],
        source: 'line',
      }),
    ).toBeNull();
  });
});

describe('photo memory and remaining budget', () => {
  it('answers 「さっきの写真」 from the last photo it read, without the photo itself', async () => {
    const { service } = setup([receipt()]);
    await service.inbound(principal, 'c', { text: '', images: [photo], source: 'line' });
    const answer = await service.handle(principal, 'c', 'さっき送った写真を見て');
    expect(answer?.answer).toContain('さっきの写真は');
    expect(answer?.answer).toContain('スーパー・合計 2480 JPY（食費）');
    expect(await service.handle(principal, 'other', 'さっき送った写真を見て')).toBeNull();
  });

  it('tells how much of the budget is left', async () => {
    const { service, book } = setup([receipt()]);
    expect((await service.handle(principal, 'c', '今月あといくら使える？'))?.answer).toContain(
      '予算がまだ決まっていません',
    );
    await book.setBudget(scope, '食費', 'JPY', 10_000);
    await service.inbound(principal, 'c', { text: '', images: [photo], source: 'line' });
    expect((await service.handle(principal, 'c', '今月あといくら使える？'))?.answer).toBe(
      '今月の予算の残りは ¥7,520 です。\n・食費 残り ¥7,520',
    );
  });
});

describe('UnderstandService.handle', () => {
  it('shows the month, a category, and sets a budget', async () => {
    const { service, book } = setup([receipt()]);
    expect((await service.handle(principal, 'c', '家計簿を見せて'))?.answer).toBe(
      '今月の家計簿はまだ空です。レシートの写真を送ると付けます。',
    );
    await service.inbound(principal, 'c', { text: '', images: [photo], source: 'line' });
    expect((await service.handle(principal, 'c', '食費の予算を6万円にして'))?.answer).toBe(
      '食費の予算を月 ¥60,000 にしました。',
    );
    expect(book.budgetsList).toEqual([{ category: '食費', currency: 'JPY', monthly: 60_000 }]);
    expect((await service.handle(principal, 'c', '今月の食費はいくら？'))?.answer).toBe(
      '今月の食費は ¥2,480（予算 ¥60,000、残り ¥57,520）です。',
    );
    expect((await service.handle(principal, 'c', '家計簿を見せて'))?.answer).toBe(
      '今月の支出 ¥2,480\n・食費 ¥2,480 / ¥60,000',
    );
  });

  it('leaves ordinary requests alone', async () => {
    const { service } = setup([]);
    for (const text of [
      'はい',
      '取り消して',
      '予約を取り消して',
      'この文を英語に変えて',
      '返信して',
    ]) {
      expect(await service.handle(principal, 'c', text)).toBeNull();
    }
  });
});

describe('call minutes', () => {
  const call = {
    transcript: [
      { role: 'user' as const, text: '本日のメールを整理して' },
      { role: 'genie' as const, text: 'Gmail の許可が無く読めませんでした' },
    ],
    requests: [
      { request: '本日のメールを整理して', status: 'answered', answer: '読めませんでした' },
    ],
  };

  it('passes only the call transcript and requests to the model', async () => {
    const model = new ScriptedUnderstander([]);
    model.minutesAnswer = { topics: ['メールの整理'], outcomes: [], next: [] };
    const service = new UnderstandService({
      understander: model,
      expenses: new FakeBook(),
      timeZone: 'Asia/Tokyo',
    });
    expect(await service.callMinutes(call)).toEqual(model.minutesAnswer);
    expect(model.minutesCalls).toEqual([call]);
  });

  it('returns null without a model, for an empty call, or when the model fails (the caller builds them itself)', async () => {
    const none = new UnderstandService({
      understander: null,
      expenses: new FakeBook(),
      timeZone: 'Asia/Tokyo',
    });
    expect(await none.callMinutes(call)).toBeNull();
    const failing = new ScriptedUnderstander([]);
    const events: string[] = [];
    const service = new UnderstandService({
      understander: failing,
      expenses: new FakeBook(),
      timeZone: 'Asia/Tokyo',
      log: (event) => events.push(event),
    });
    expect(await service.callMinutes(call)).toBeNull();
    expect(events).toEqual(['understand.minutes_failed']);
    expect(await service.callMinutes({ transcript: [], requests: [] })).toBeNull();
    expect(failing.minutesCalls).toHaveLength(1);
  });
});
