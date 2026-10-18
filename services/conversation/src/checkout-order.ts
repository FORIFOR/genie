import {
  CHECKOUT_SERVICES,
  CheckoutOrderDraft,
  CheckoutPrepareArgs,
  type CheckoutService,
} from '@genie/contracts';
import { checkoutAssistanceRequest } from './checkout-request.js';

// 声の書き起こしは語尾が欠けることがある（「マクドナル」）。「マクド」も同じ店。
const merchant =
  "(マックデリバリー|マクドナルド?|マクド|マック|ドミノ(?:・ピザ)?|ドミノピザ|Domino's)";
const startPattern = new RegExp(
  `^(新しく[、 ]*)?${merchant}(?:で|を|の)?(.*?)(?:注文して|注文したい|頼みたい|デリバリー(?:して|したい|を頼みたい)|宅配(?:して|したい)|出前(?:して|したい))(?:ください|んだけど|んですけど|んですが|です)?[。！!、 ,]*(.*)$`,
  'iu',
);
// 「ひとつ」「ふたつ」も数（声の書き起こしはかなで来る）。
const quantity =
  /(?<![0-9.\-])(?:(?:[1-9][0-9]*|[一二三四五六七八九十]+)\s*(?:個|つ|枚|セット|人前|杯|本|袋)|(?:ひと|ふた|みっ|よっ|いつ)つ)/u;
const quantityOnly =
  /^(?:(?:[1-9][0-9]*|[一二三四五六七八九十]+)\s*(?:個|つ|枚|セット|人前|杯|本|袋)|(?:ひと|ふた|みっ|よっ|いつ)つ)$/u;
/** 商品の答えの末尾の「を注文して」「を頼む」など。商品名ではない。 */
const orderVerb =
  /を?(?:注文|頼|たの)(?:して|する|します|したい|みたい|んで|む|みます)?(?:ください|ね)?$/u;
const unrelated =
  /(?:メール|会議|天気|株価|資料|書類|売上|パソコン|パワポ|スライド|印刷|翻訳|調べて|教えて|送って|送信して|削除して|作成して)/u;
const privateDetails =
  /(?:住所|郵便番号|電話番号|パスワード|暗証番号|クレジット|カード番号|カードは|CVV|CVC|セキュリティコード|\b\d{13,19}\b)/iu;
const siteNotice =
  '住所・ログイン・カード情報はチャットに書かず、公式サイトで入力・選択してください。';

function normalized(text: string): string {
  return text.normalize('NFKC').trim();
}
function exampleOrQuestion(text: string): boolean {
  return (
    /^[「『"']/u.test(text) ||
    /(?:という|と言う)(?:文|文章|言葉|フレーズ)|方法|どうすれば|できますか|できる[?？]|[?？]$/u.test(
      text,
    ) ||
    /(?:注文しない|注文したくない|頼みたくない|してはいけない|しないで)/u.test(text)
  );
}

/** Only an explicit merchant order request starts collection; examples and questions never do. */
export function checkoutOrderRequest(
  text: string,
): { service: CheckoutService; details: string; fresh: boolean } | null {
  const value = normalized(text);
  if (exampleOrQuestion(value) || checkoutAssistanceRequest(value) || /https?:\/\//iu.test(value))
    return null;
  const match = startPattern.exec(value);
  if (!match) return null;
  return {
    service: /^(?:マック|マクド)/u.test(match[2]!) ? 'mcdelivery_jp' : 'dominos_jp',
    details: [match[3]!.replace(/を$/u, '').trim(), match[4]!.trim()].filter(Boolean).join('、'),
    fresh: !!match[1],
  };
}

export function isCheckoutOrderQuotation(text: string): boolean {
  const value = normalized(text);
  return (
    exampleOrQuestion(value) && new RegExp(merchant, 'iu').test(value) && /注文|頼み/u.test(value)
  );
}

export interface CheckoutOrderTransition {
  readonly draft: CheckoutOrderDraft;
  readonly message: string;
  readonly prepare: CheckoutPrepareArgs | null;
  readonly taskId: string | null;
}

function question(draft: CheckoutOrderDraft): string {
  // 商品は分かっていて数だけ無いときは、その商品の数だけを聞く（同じ質問を繰り返さない）。
  if (draft.itemsText && !quantity.test(draft.itemsText))
    return `「${draft.itemsText}」の数量を教えてください。「1つ」「2個」のように答えてください。`;
  if (!draft.itemsText)
    return `${CHECKOUT_SERVICES[draft.service].label}で頼む商品名と数量を教えてください。セット・サイズなども指定できます。`;
  if (!draft.requestedTime)
    return 'いつ届けたいですか。「できるだけ早く」または希望日時を教えてください。';
  if (draft.maxTotalMinor === null)
    return '税込・配達料などの手数料を含む合計の上限はいくらですか。「上限は2000円」のように教えてください。';
  return '';
}

/** Conservative slots: an item price, vague amount or unrelated topic is not an order budget. */
function fields(text: string, draft: CheckoutOrderDraft): Partial<CheckoutOrderDraft> | null {
  if (!text) return {};
  if (privateDetails.test(text) || unrelated.test(text) || /https?:\/\//iu.test(text)) return null;
  const update: Partial<CheckoutOrderDraft> = {};
  const parts = text
    .replace(/(?<=\d),(?=\d{3}(?:\D|$))/gu, '')
    .split(/[、。;\n]+/u)
    .map((s) => s.trim())
    .filter(Boolean);
  for (const part of parts) {
    const budget =
      /^(?:(?:税込|税・?手数料込み|税込・?手数料込み|配達料込み)(?:で)?[、 ]*)?(?:(?:予算|上限|合計の上限)(?:は|を|:)?\s*([0-9]+)円(?:まで|以内)?|([0-9]+)円(?:まで|以内))(?:です|で|にして|でお願い(?:します)?)?[!！]?$/u.exec(
        part,
      );
    const bareBudget =
      !draft.maxTotalMinor &&
      draft.itemsText &&
      quantity.test(draft.itemsText) &&
      draft.requestedTime
        ? /^([0-9]+)円(?:です)?$/u.exec(part)
        : null;
    if (budget || bareBudget) {
      const value = Number(budget?.[1] ?? budget?.[2] ?? bareBudget?.[1]);
      if (!Number.isSafeInteger(value) || value <= 0 || update.maxTotalMinor !== undefined)
        return null;
      update.maxTotalMinor = value;
      continue;
    }
    const time = part
      .replace(/^(?:希望(?:時刻|日時)?|配達(?:時刻|日時)?|お届け)(?:は|:)?\s*/u, '')
      .replace(/(?:でお願いします|でお願い|にして|です)$/u, '')
      // 「できるだけ早い時間で届ける」（声の会話で Gemini が言い換えて渡した形、genie.log 2026-10-18 16:10Z）。
      .replace(/(?:で|に)?(?:届けて(?:ください)?|届ける|お届け(?:して)?|配達して|持ってきて)$/u, '');
    if (
      /^(?:(?:できるだけ|なるべく)(?:早く|早め|早い時間|すぐ)(?:に|で)?|最短(?:で)?|今すぐ|すぐ|asap)$/iu.test(time)
    ) {
      if (update.requestedTime) return null;
      update.requestedTime = 'asap';
      continue;
    }
    if (
      /^(?:(?:今日|明日|明後日|\d{4}[-/](?:0?[1-9]|1[0-2])[-/](?:0?[1-9]|[12]\d|3[01])|(?:0?[1-9]|1[0-2])月(?:0?[1-9]|[12]\d|3[01])日)\s*)?(?:(?:午前|午後)\s*)?(?:[01]?\d|2[0-3])(?::[0-5]\d|時(?:[0-5]?\d分|半)?)(?:ごろ|頃)?$/u.test(
        time,
      )
    ) {
      if (update.requestedTime || time.length > 100) return null;
      update.requestedTime = time;
      continue;
    }
    const items = part
      .replace(/^(?:商品|注文内容)(?:は|:)?\s*/u, '')
      .replace(orderVerb, '')
      .replace(/(?:をお願いします|をお願い|でお願いします|でお願い|にして|です)$/u, '')
      .trim();
    if (
      !items ||
      items.length > 600 ||
      /円|ドル|予算|上限|希望|時刻|住所|(?:して|ください|について)$/u.test(items)
    )
      return null;
    if (quantityOnly.test(items) && draft.itemsText && !quantity.test(draft.itemsText)) {
      update.itemsText = `${draft.itemsText} ${items}`;
      if (!CheckoutPrepareArgs.shape.itemsText.safeParse(update.itemsText).success) return null;
      continue;
    }
    if (quantityOnly.test(items)) return {};
    // Unlabelled continuations need a quantity or a recognizable food word.
    if (
      !/^(?:商品|注文内容)/u.test(part) &&
      !quantity.test(items) &&
      !/(?:バーガー|ビッグマック|ポテト|ナゲット|ピザ|マルゲリータ|サラダ|コーラ|コーヒー|シェイク|チキン|セット)/u.test(
        items,
      )
    )
      return null;
    update.itemsText = update.itemsText ? `${update.itemsText}、${items}` : items;
    if (!CheckoutPrepareArgs.shape.itemsText.safeParse(update.itemsText).success) return null;
  }
  return update;
}

/** Pure transition. Only explicit order answers modify a draft; other topics remain normal conversation. */
export function advanceCheckoutOrder(
  current: CheckoutOrderDraft | null,
  text: string,
  turnId: string,
): CheckoutOrderTransition | null {
  const value = normalized(text);
  if (exampleOrQuestion(value) || checkoutAssistanceRequest(value)) return null;
  const start = checkoutOrderRequest(value);
  const pause =
    /^(?:注文(?:の準備)?(?:を)?[、 ]*)?(?:中断して|一旦やめて|いったんやめて|あとで|保留して|やめて)[。！!]?$/u.test(
      value,
    );
  const resume = /^(?:さっきの|前の)?注文(?:の準備)?(?:を)?(?:再開して|続けて)[。！!]?$/u.test(
    value,
  );
  if (!current && !start) return null;
  let draft = current;
  if (start && (!draft || start.fresh))
    draft = CheckoutOrderDraft.parse({
      version: 1,
      service: start.service,
      orderKey: `checkout:${turnId}`,
      currency: 'JPY',
      itemsText: null,
      requestedTime: null,
      maxTotalMinor: null,
      status: 'collecting',
      dispatchTurnId: null,
      taskId: null,
    });
  if (!draft) return null;
  const answer = (message: string): CheckoutOrderTransition => ({
    draft: draft!,
    message,
    prepare: null,
    taskId: draft!.taskId,
  });
  if (start && start.service !== draft.service)
    return answer(
      '別の注文先の内容は混ぜません。今の注文を続けるか、「新しくマックで注文して」のように新しい注文を指定してください。',
    );
  if (draft.status === 'dispatched') {
    if (!start && !resume && !pause) return null;
    if (pause)
      return answer(
        'この注文のカート準備は依頼済みです。中止するには、その仕事の停止を使ってください。注文・支払いは確定していません。',
      );
    return answer(
      'この注文のカート準備は依頼済みです。準備状況を確認します。注文・支払いは確定していません。',
    );
  }
  // Once dispatch is reserved, retries must use the exact same terms and identity.
  if (draft.dispatchTurnId) {
    if (pause)
      return answer(
        '準備開始の受付を確認中です。新しい条件でやり直す前に、準備状況を確認してください。注文・支払いは確定していません。',
      );
    if (!start && !resume && !fields(value, draft)) return null;
    const prepare = CheckoutPrepareArgs.parse({
      service: draft.service,
      orderKey: draft.orderKey,
      itemsText: draft.itemsText,
      requestedTime: draft.requestedTime,
      maxTotalMinor: draft.maxTotalMinor,
      currency: draft.currency,
    });
    return { draft, message: '', prepare, taskId: null };
  }
  if (pause) {
    draft = { ...draft, status: 'paused' };
    return answer(
      '注文条件を保存して中断しました。「注文を再開して」で続けられます。注文は確定していません。',
    );
  }
  if (draft.status === 'paused' && !resume && !start) return null;
  if (privateDetails.test(start?.details ?? value))
    return answer(`${siteNotice} ${question(draft)}`);
  if (quantityOnly.test(value) && !draft.itemsText) return answer(question(draft));
  const patch = resume ? {} : fields(start?.details ?? value, draft);
  if (!patch) {
    // 集めている途中の「…を注文して」は注文への答え。一般の会話へ流すと「注文できません」と返っていた（実機 2026-10-16）。
    if (
      !start &&
      !/^(?:予算|上限|商品|注文内容|希望|配達|お届け)/u.test(value) &&
      !(/円/u.test(value) && !unrelated.test(value)) &&
      !(draft.status === 'collecting' && orderVerb.test(value) && !unrelated.test(value))
    )
      return null;
    return answer(`注文条件を確定できませんでした。${question(draft)} ${siteNotice}`);
  }
  draft = CheckoutOrderDraft.parse({ ...draft, ...patch, status: 'collecting' });
  const missing = question(draft);
  if (missing) return answer(`${missing}${start ? ` ${siteNotice}` : ''}`);
  draft = { ...draft, dispatchTurnId: draft.dispatchTurnId ?? turnId };
  const prepare = CheckoutPrepareArgs.parse({
    service: draft.service,
    orderKey: draft.orderKey,
    itemsText: draft.itemsText,
    requestedTime: draft.requestedTime,
    maxTotalMinor: draft.maxTotalMinor,
    currency: draft.currency,
  });
  return { draft, message: '', prepare, taskId: null };
}
