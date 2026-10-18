import { describe, expect, it } from 'vitest';
import { CheckoutPrepareArgs, type CheckoutOrderDraft, uuidv7 } from '@genie/contracts';
import { advanceCheckoutOrder, checkoutOrderRequest } from '../src/checkout-order.js';
import { checkoutAssistanceRequest } from '../src/checkout-request.js';
import { routeLane } from '../src/lane.js';

const advance = (draft: CheckoutOrderDraft | null, text: string) =>
  advanceCheckoutOrder(draft, text, uuidv7());
const started = () => advance(null, 'マックデリバリーを注文して')!.draft;
const timed = () =>
  advance(advance(started(), 'ビッグマック2個、ポテトM1個')!.draft, 'できるだけ早く')!.draft;

describe('durable checkout terms reducer', () => {
  // 声の会話で Gemini が言い換えて渡した「いつ」の答え（genie.log 2026-10-18 16:10Z）。
  it.each(['できるだけ早い時間で届ける', 'できるだけ早い時間で', 'なるべく早めに', '最短で届けて', 'できるだけ早くお届けして'])(
    'reads %s as as soon as possible',
    (text) => {
      const draft = advance(started(), 'ビッグマック2個、ポテトM1個')!.draft;
      expect(advance(draft, text)!.draft.requestedTime).toBe('asap');
    },
  );

  it.each([
    'マックデリバリーを注文して',
    'マクドナルドの注文したいんだけど',
    'マックで注文したいです',
    'ドミノでピザを頼みたいんですけど',
    // 声の会話で Gemini が言い換えて渡した形（live 2026-10-16）
    'マクドナルドをデリバリーしたい。',
    'マックで宅配したい',
    'マクドナルで注文したい', // 書き起こしの語尾が欠けた形
    'マクドで注文したい',
  ])('collects %s rather than claiming a site handoff completes it', (text) => {
    expect(checkoutOrderRequest(text)).not.toBeNull();
    expect(checkoutAssistanceRequest(text)).toBeNull();
    expect(routeLane({ text, modality: 'text' }).lane).toBe('action');
    const response = advance(null, text)!;
    // 商品が分かれば、その商品の数だけを聞く
    expect(response.message).toMatch(/商品名と数量|」の数量を教えて/);
    expect(response.prepare).toBeNull();
    expect(response.draft).toMatchObject({
      status: 'collecting',
      requestedTime: null,
      maxTotalMinor: null,
      taskId: null,
    });
  });
  it('asks only missing fields and retains free-text quantities and an explicit ceiling', () => {
    const initial = started();
    const items = advance(initial, 'ビッグマック2個、ポテトM1個')!;
    expect(items.message).toContain('いつ');
    expect(items.message).not.toContain('商品名');
    const time = advance(items.draft, '明日18時30分')!;
    expect(time.message).toContain('合計の上限');
    const ready = advance(time.draft, '上限は2,000円')!;
    expect(ready.prepare).toEqual({
      service: 'mcdelivery_jp',
      orderKey: initial.orderKey,
      itemsText: 'ビッグマック2個、ポテトM1個',
      requestedTime: '明日18時30分',
      maxTotalMinor: 2000,
      currency: 'JPY',
    });
    expect(ready.draft.status).toBe('collecting'); // not a prepared cart or accepted task
    expect(ready.draft.dispatchTurnId).not.toBeNull();
  });
  it('accepts explicit complete terms in the initial request', () => {
    const ready = advance(null, 'ドミノでマルゲリータM2枚を注文して、希望は明日19時、上限3000円')!;
    expect(ready.prepare).toMatchObject({
      service: 'dominos_jp',
      itemsText: 'マルゲリータM2枚',
      requestedTime: '明日19時',
      maxTotalMinor: 3000,
    });
  });
  it('requires quantity and can complete it without dropping the item name', () => {
    expect(advance(started(), '2個')!.draft.itemsText).toBeNull();
    expect(advance(null, 'マックで2個注文して')!.draft.itemsText).toBeNull();
    const item = advance(started(), 'ビッグマック')!;
    expect(item.message).toContain('「ビッグマック」の数量を教えて');
    expect(item.prepare).toBeNull();
    expect(advance(item.draft, '2個')!.draft.itemsText).toBe('ビッグマック 2個');
  });
  it.each(['ポテト-1個', 'ポテト1.5個'])(
    'does not treat invalid quantities as complete: %s',
    (text) => {
      const answer = advance(started(), text)!;
      expect(answer.message).toContain('の数量を教えて');
      expect(answer.prepare).toBeNull();
    },
  );
  it('keeps spoken follow-ups like 「…を注文して」 inside the order (live 2026-10-16)', () => {
    const asked = advance(null, 'マクドナルド注文して')!;
    expect(asked.message).toContain('商品名と数量');
    const item = advance(asked.draft, 'チーズバーガーのMセットを注文して')!;
    expect(item).not.toBeNull(); // 以前は null で一般の会話へ流れ「注文できません」と答えていた
    expect(item.draft.itemsText).toBe('チーズバーガーのMセット');
    expect(item.message).toContain('「チーズバーガーのMセット」の数量を教えて');
    const counted = advance(item.draft, 'ひとつ')!;
    expect(counted.draft.itemsText).toBe('チーズバーガーのMセット ひとつ');
    expect(counted.message).toContain('いつ');
    // 集めている途中でも、別の話題は注文に混ぜない
    expect(advance(item.draft, '天気を教えて')).toBeNull();
    // 「注文をやめて」は下書きを止める（Gemini が stop_work でなく渡したとき）
    expect(advance(counted.draft, '注文をやめて')!.draft.status).toBe('paused');
  });

  it('preserves terms on pause, unrelated conversations and resume', () => {
    const draft = timed();
    const paused = advance(draft, '注文を中断して')!;
    expect(paused.draft.status).toBe('paused');
    expect(advance(paused.draft, '今日の天気は？')).toBeNull();
    expect(advance(paused.draft, '上限1000円')).toBeNull();
    const resumed = advance(paused.draft, '注文を再開して')!;
    expect(resumed.draft).toEqual({ ...draft, status: 'collecting' });
    expect(resumed.message).toContain('合計の上限');
  });
  it.each([
    '今日の天気は？',
    '資料を2枚印刷して',
    'メールを送って',
    '商品は資料2枚',
    'ポテト2個、会議は18時',
    'パスワードはtest-only-value',
    '住所は架空市架空町',
  ])('never incorporates unrelated or private information: %s', (text) => {
    const current = timed();
    const next = advance(current, text);
    expect(next?.draft ?? current).toEqual(current);
    expect(next?.prepare ?? null).toBeNull();
  });
  it.each([
    '2000円くらい',
    '一個2000円',
    'ポテト2個で500円',
    '予算おまかせ',
    '上限0円',
    '上限-1円',
    '上限1.5円',
    '上限9007199254740992円',
  ])('does not infer an order ceiling from %s', (text) => {
    const next = advance(timed(), text);
    expect(next?.draft.maxTotalMinor ?? null).toBeNull();
    expect(next?.prepare ?? null).toBeNull();
  });
  it('accepts bare money only as the answer to the explicit ceiling question', () => {
    expect(advance(started(), '2000円')!.draft.maxTotalMinor).toBeNull();
    expect(advance(timed(), '2000円')!.prepare?.maxTotalMinor).toBe(2000);
  });
  it.each([
    '「マックを注文して」',
    'マックを注文してという文を書いて',
    'ドミノで注文できますか？',
    'マックを注文して？',
    'マックを注文してはいけない',
  ])('does not dispatch quoted, explanatory or negated text: %s', (text) => {
    expect(checkoutOrderRequest(text)).toBeNull();
    expect(advance(null, text)).toBeNull();
    expect(routeLane({ text, modality: 'text' }).lane).toBe('chat');
  });
  it('does not mix a different merchant into the existing order', () => {
    const current = timed();
    expect(advance(current, 'ドミノでピザ2枚を注文して')!.draft).toEqual(current);
    const fresh = advance(current, '新しくドミノでピザ2枚を注文して')!;
    expect(fresh.draft.service).toBe('dominos_jp');
    expect(fresh.draft.orderKey).not.toBe(current.orderKey);
    expect(fresh.draft.maxTotalMinor).toBeNull();
  });
  it('retries dispatch with the same identity and terms, then returns the accepted task', () => {
    const ready = advance(timed(), '上限2000円')!;
    const retry = advance(ready.draft, '注文を再開して')!;
    expect(retry.prepare).toEqual(ready.prepare);
    expect(retry.draft.dispatchTurnId).toBe(ready.draft.dispatchTurnId);
    expect(advance(ready.draft, '上限3000円')!.prepare).toEqual(ready.prepare);
    const taskId = uuidv7();
    const accepted = advance({ ...ready.draft, status: 'dispatched', taskId }, 'マックを注文して')!;
    expect(accepted.taskId).toBe(taskId);
    expect(accepted.prepare).toBeNull();
    expect(accepted.message).toContain('確定していません');
  });
  it.each(['99時', '明日25:30', '希望は13月3日18時'])(
    'does not accept invalid clock fields: %s',
    (text) => {
      const draft = advance(started(), 'ポテト1個')!.draft;
      expect(advance(draft, text)?.draft.requestedTime ?? null).toBeNull();
    },
  );
  it('keeps explicit site opening independent of an active order', () => {
    expect(advance(timed(), 'マックの注文サイトを開いて')).toBeNull();
  });
  it.each([
    { itemsText: ' ' },
    { requestedTime: '\t' },
    { itemsText: 'a'.repeat(601) },
    { itemsText: 'ポテト1個\0' },
  ])('rejects invalid direct prepare input: %j', (patch) => {
    expect(
      CheckoutPrepareArgs.safeParse({ ...advance(timed(), '上限2000円')!.prepare, ...patch })
        .success,
    ).toBe(false);
  });
});
