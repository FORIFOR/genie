/**
 * 電話の頼みごとを見分ける。**規則だけで決める。モデルに聞かない。**
 *
 * 電話は外へ出る、取り消せない、お金がかかる操作なので、
 * 「電話して」と言われていないものを電話にしない。迷ったら電話にしない
 * （chat の答えになるだけで、何も起きない）。
 */
import type { OathraSalesContext, SalesGoal } from './oathra.js';

export type PhoneIntent =
  | { readonly kind: 'sales'; readonly goal: SalesGoal; readonly request: string }
  | { readonly kind: 'call'; readonly phone: string; readonly request: string };

/** かけてほしいと言っている。「電話番号」「電話で話した」は含めない。 */
const ASKS_TO_CALL =
  /(?:電話|架電|テレアポ|コール)(?:を)?(?:して|かけて|掛けて|入れて|お願い|する(?:[。！!]|$))|(?:アポ|アポイント)(?:を)?(?:取って|とって|入れて)|(?:営業|売り込み)(?:を)?(?:かけて|掛けて|して)/;

/** やめてほしい・やり方を聞いているだけ。 */
const NOT_A_REQUEST =
  /(?:して|かけて|掛けて|入れて|取って)(?:は(?:いけ|だめ|ダメ)|いない|ない|ほしくない|欲しくない)|しないで|やめて|どう(?:やって|すれば)|コツ|方法|とは[？?]?$/;

/** 売り込み・案内・商談の電話。 */
const SALES =
  /営業|売り込|セールス|テレアポ|アポ(?:イント)?|商談|提案|ご?案内|資料(?:の)?(?:送付|案内|をお送り)/;

/** 国内（0 から 10〜11 桁）か国番号付き。区切りのハイフン・空白・全角は許す。 */
const PHONE = /(?:\+|＋)?[0-9０-９][0-9０-９\-－ー‐\s()（）]{8,16}[0-9０-９]/;

export function phoneIntentOf(text: string): PhoneIntent | null {
  const request = text.trim();
  if (!request || !ASKS_TO_CALL.test(request) || NOT_A_REQUEST.test(request)) return null;
  if (SALES.test(request)) return { kind: 'sales', goal: salesGoalOf(request), request };
  const phone = PHONE.exec(request)?.[0];
  // 番号の無い「電話して」は、だれにかけるか決まらない。推測しない。
  return phone ? { kind: 'call', phone: phone.trim(), request } : null;
}

/** Oathra の goal と同じ語彙。**商談の日程が出てくれば meeting が勝つ。** */
export function salesGoalOf(text: string): SalesGoal {
  if (/商談|打ち合わせ|打合せ|面談|日程|アポ/.test(text)) return 'meeting';
  if (/資料|パンフレット|カタログ/.test(text)) return 'materials';
  return 'introduce';
}

export type SalesTarget =
  | {
      readonly ok: true;
      readonly contact: { readonly id: string; readonly name: string };
      readonly product: { readonly id: string; readonly name: string } | null;
    }
  | {
      readonly ok: false;
      readonly reason: 'no_contact' | 'ambiguous_contact' | 'not_permitted' | 'ambiguous_product';
      readonly message: string;
    };

/**
 * だれに・何をの電話か。**名前が文にそのまま出てくるものだけ**を候補にする。
 *
 * 一人に決まらなければかけない。断る理由は利用者が直せる言葉で返す
 * （「Oathra で関係と根拠を登録してください」など）。
 */
export function salesTargetOf(request: string, context: OathraSalesContext): SalesTarget {
  const mentioned = context.contacts.filter((c) =>
    [c.name, c.company].some((label) => !!label && request.includes(label)),
  );
  if (mentioned.length === 0) {
    return {
      ok: false,
      reason: 'no_contact',
      message:
        '電話する相手が見つかりませんでした。Oathra に登録し、Genie に任せた連絡先の名前で頼んでください。',
    };
  }
  if (mentioned.length > 1) {
    return {
      ok: false,
      reason: 'ambiguous_contact',
      message: `相手を一人に決められません（${mentioned.map((c) => c.name || c.company).join(' / ')}）。名前を一人だけ書いてください。`,
    };
  }
  const contact = mentioned[0]!;
  if (!contact.callPermitted) {
    return {
      ok: false,
      reason: 'not_permitted',
      message: `${contact.name || contact.company}さんには営業電話をかけられません。Oathra の連絡先に関係と連絡する根拠を登録してください（再連絡停止の相手にはかけません）。`,
    };
  }
  const products = context.products.filter((p) => request.includes(p.name));
  if (products.length > 1) {
    return {
      ok: false,
      reason: 'ambiguous_product',
      message: `どの商品の案内か決められません（${products.map((p) => p.name).join(' / ')}）。一つだけ書いてください。`,
    };
  }
  return {
    ok: true,
    contact: { id: contact.id, name: contact.name || contact.company || '相手' },
    product: products[0] ?? null,
  };
}
