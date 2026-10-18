/**
 * 「電話して」を仕事（task の種別と入力）にする。チャットの turn と着信の両方から使う。
 *
 * 営業電話は、ここで相手と商品を Oathra の連絡先から決める。**決まらなければ仕事にしない。**
 * 決まったものだけが承認カードに載り、利用者が見て「電話をかける」を押す。
 */
import { OathraError, type OathraClient } from './oathra.js';
import { phoneIntentOf, salesTargetOf } from './intent.js';

export type PhoneTaskDecision =
  | {
      readonly kind: 'task';
      readonly request: {
        kind: 'phone.call' | 'phone.sales';
        title: string;
        input: Record<string, unknown>;
      };
    }
  | { readonly kind: 'notice'; readonly notice: string };

const NOT_DELEGATED: Readonly<Record<string, string>> = {
  sales_not_delegated:
    'Oathra で Genie に営業電話を任せていません。Oathra の委任に「営業電話」を加えてから頼んでください。',
  phone_grant_expired_or_revoked:
    'Oathra の委任が期限切れか、取り消されています。Oathra で委任し直してください。',
  phone_grant_scope_changed: 'Oathra の同意や設定が変わりました。Oathra で委任し直してください。',
};

/**
 * 電話の頼みでなければ null（ほかの振り分けに任せる）。
 * 電話の頼みだが進められないときは、直し方を書いた notice を返す。
 */
export async function phoneTaskFor(
  text: string,
  client: OathraClient | null,
): Promise<PhoneTaskDecision | null> {
  const intent = phoneIntentOf(text);
  if (!intent) return null;
  if (!client) {
    return {
      kind: 'notice',
      notice: '電話をかけるには Oathra との接続が必要です。まだ繋がっていません。',
    };
  }
  if (intent.kind === 'call') {
    return {
      kind: 'task',
      request: {
        kind: 'phone.call',
        title: `電話: ${intent.phone}`,
        input: { phone: intent.phone, name: '相手', instruction: intent.request },
      },
    };
  }

  let context;
  try {
    context = await client.salesContext();
  } catch (error) {
    if (error instanceof OathraError && NOT_DELEGATED[error.code]) {
      return { kind: 'notice', notice: NOT_DELEGATED[error.code]! };
    }
    return {
      kind: 'notice',
      notice: 'Oathra に繋がりませんでした。少し待ってから、もう一度頼んでください。',
    };
  }
  const target = salesTargetOf(intent.request, context);
  if (!target.ok) return { kind: 'notice', notice: target.message };
  return {
    kind: 'task',
    request: {
      kind: 'phone.sales',
      title: `営業電話: ${target.contact.name}`,
      input: {
        contact_id: target.contact.id,
        contact_name: target.contact.name,
        ...(target.product
          ? { product_id: target.product.id, product_name: target.product.name }
          : {}),
        request: intent.request,
        goal: intent.goal,
      },
    },
  };
}
