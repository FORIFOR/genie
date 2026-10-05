import type { CheckoutService } from '@genie/contracts';

/** Entire explicit requests only; never reinterpret questions, quoted text or order terms. */
export function checkoutAssistanceRequest(text: string): CheckoutService | null {
  const match =
    /^(マックデリバリー|マクドナルド|マック|ドミノ(?:・ピザ)?|ドミノピザ|Domino's)(?:(?:を|で|の)?(?:ピザを)?(?:注文して|注文したい|頼みたい)(?:んだけど|んですけど|んですが|です)?|の注文(?:画面|サイト)を開いて|のメニューを(?:見せて|開いて|見たい))(?:ください)?[。！!]?$/iu.exec(
      text.trim(),
    );
  if (!match) return null;
  return /^(?:マック|マクドナルド)/u.test(match[1]!) ? 'mcdelivery_jp' : 'dominos_jp';
}

/** Prevent a whole quoted example from falling through to generic screen automation. */
export function isCheckoutAssistanceQuotation(text: string): boolean {
  const trimmed = text.trim();
  const writing =
    /^(.*?)(?:という|と言う)(?:文|文章|フレーズ|言葉)(?:を(?:書いて|説明して|教えて)|の意味を教えて)(?:ください)?[。！!？?]?$/u.exec(
      trimmed,
    );
  const candidate = writing?.[1] ?? trimmed;
  const quoted = /^(?:「([^」]+)」|『([^』]+)』|"([^"]+)"|'([^']+)')[。！!？?]?$/u.exec(candidate);
  if (!writing && !quoted) return false;
  return (
    checkoutAssistanceRequest(quoted?.slice(1).find((part) => part !== undefined) ?? candidate) !==
    null
  );
}
