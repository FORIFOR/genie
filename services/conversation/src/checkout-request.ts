import type { CheckoutService } from '@genie/contracts';

/** Preparation of a supported registration form, never permission to accept terms or submit. */
export function accountRegistrationRequest(text: string): 'mcdelivery_jp' | null {
  return /^(?:マックデリバリー|マクドナルド|マック)(?:(?:に|で)(?:新規)?会員登録して|の(?:新規)?会員登録を(?:手伝って|準備して))(?:ください)?[。！!]?$/u.test(
    text.normalize('NFKC').trim(),
  )
    ? 'mcdelivery_jp'
    : null;
}

/** Examples, questions and negative requests must not enable the generic computer runner. */
export function isAccountRegistrationQuotation(text: string): boolean {
  const value = text.normalize('NFKC').trim();
  return (
    /(?:マックデリバリー|マクドナルド|マック)/u.test(value) &&
    /会員登録/u.test(value) &&
    (/^[「『"']/u.test(value) ||
      /(?:という|と言う)(?:文|文章|言葉|フレーズ)|方法|やり方|どうすれば|できますか|できる[?？]|[?？]$|しないで|してはいけない|したくない/u.test(
        value,
      ))
  );
}

/** Entire explicit requests only; never reinterpret questions, quoted text or order terms. */
export function checkoutAssistanceRequest(text: string): CheckoutService | null {
  const match =
    /^(マックデリバリー|マクドナルド|マック|ドミノ(?:・ピザ)?|ドミノピザ|Domino's)(?:の注文(?:画面|サイト)を開いて|のメニューを(?:見せて|開いて|見たい))(?:ください)?[。！!]?$/iu.exec(
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
