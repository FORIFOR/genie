/**
 * 会話から「〇〇の公式サイトを開いて」「ブラウザで〇〇を開いて」を見つける。
 *
 * 拾うのは**開く言葉があるときだけ**。「〇〇の公式サイトはどこ？」は答えを求めているので
 * 普通の会話に任せる。URL を書いた依頼も拾わない（書かれた URL を確かめずに開かない）。
 */
export interface BrowserOpenRequest {
  readonly subject: string;
}

const OPEN =
  /(?:を|も)?(?:ブラウザ(?:で|に))?(?:開いて|ひらいて|開けて|表示して|見せて|出して|確認して|見て)/u;
const POLITE =
  /(?:ください|くれる|くれますか|もらえる|もらえますか|下さい|ほしい|欲しい)?[。！!？?\s]*$/u;
const OFFICIAL =
  /^(.+?)の?(?:公式(?:サイト|ページ|ホームページ|HP|ウェブサイト)?|ホームページ|ウェブサイト|サイト|HP)$/iu;
const LEAD =
  /^(?:ジーニー|Genie)?[、,\s]*(?:ちょっと|あの|えっと)?[、,\s]*(?:ブラウザ(?:を開いて|で|に)[、,\s]*)?/iu;

export function browserOpenRequest(text: string): BrowserOpenRequest | null {
  const trimmed = text.trim();
  if (/https?:\/\/|www\./iu.test(trimmed)) return null;
  const body = trimmed.replace(POLITE, '');
  const match = new RegExp(`^(.+?)${OPEN.source}$`, 'u').exec(body);
  if (!match) return null;
  const target = match[1]!
    .replace(LEAD, '')
    .replace(/[をもは]$/u, '')
    .trim();
  const official = OFFICIAL.exec(target);
  const viaBrowser = /ブラウザ/u.test(trimmed);
  // 「公式サイト」等の言葉か、「ブラウザで」の言葉のどちらかが要る。「資料を見て」は拾わない。
  if (!official && !viaBrowser) return null;
  const subject = (official ? official[1]! : target).replace(/[のを]$/u, '').trim();
  if (!subject || subject.length > 60 || /^(?:これ|それ|あれ|この|その)$/u.test(subject))
    return null;
  return { subject };
}
