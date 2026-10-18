/**
 * 会話から「〇〇の公式サイトを開いて」「ブラウザで〇〇を開いて」を見つける。
 *
 * 拾うのは**開く言葉があるときだけ**。「〇〇の公式サイトはどこ？」は答えを求めているので
 * 普通の会話に任せる。URL を書いた依頼も拾わない（書かれた URL を確かめずに開かない）。
 */
export interface BrowserOpenRequest {
  readonly subject: string;
  /** 「Safari で」「Chrome で」と言われたら、そのブラウザ。 */
  readonly browser?: 'safari' | 'chrome';
}

const SAFARI = /[\s、,]*(?:safari|サファリ)[\s]*(?:で|に|を使って)?[、,\s]*/iu;
const CHROME =
  /[\s、,]*(?:google\s*)?(?:chrome|クローム|グーグルクローム)[\s]*(?:で|に|を使って)?[、,\s]*/iu;

const OPEN =
  /(?:を|も)?(?:ブラウザ(?:で|に))?(?:開いて|ひらいて|開けて|表示して|見せて|出して|確認して|見て)/u;
const POLITE =
  /(?:ください|くれる|くれますか|もらえる|もらえますか|下さい|ほしい|欲しい)?[。！!？?\s]*$/u;
// 「公式サイド」は「公式サイト」の聞き違い（Gemini Live の文字起こし、liveflow 2026-10-06）。
const OFFICIAL =
  /^(.+?)の?(?:公式(?:サイト|サイド|ページ|ホームページ|HP|ウェブサイト)?|ホームページ|ウェブサイト|サイト|HP)$/iu;
const LEAD =
  /^(?:ジーニー|Genie)?[、,\s]*(?:ちょっと|あの|えっと)?[、,\s]*(?:ブラウザ(?:を開いて|で|に)[、,\s]*)?/iu;

export function browserOpenRequest(text: string): BrowserOpenRequest | null {
  const named = SAFARI.test(text) ? 'safari' : CHROME.test(text) ? 'chrome' : undefined;
  // ブラウザの名前は取り除いてから読む（「〇〇の公式サイトを Safari で開いて」→ 対象は〇〇）。
  // 置き換えではなく取り除く（以前は「ブラウザでで」が対象名に残り、別のものを検索していた。liveflow 2026-10-05）。
  const trimmed = text.replace(SAFARI, '').replace(CHROME, '').trim();
  if (/https?:\/\/|www\./iu.test(trimmed)) return null;
  const body = trimmed.replace(POLITE, '');
  const match = new RegExp(`^(.+?)${OPEN.source}$`, 'u').exec(body);
  if (!match) return null;
  const target = match[1]!
    .replace(LEAD, '')
    // 「〇〇を公式サイトで見せて」の「で」も外す（Gemini への指示の例文そのもの。外さないと公式サイトと
    // 読めず、ブラウザを開けない会話に回っていた。genie.log 2026-10-18 16:09Z・16:20Z）。
    .replace(/[をもはで]$/u, '')
    .trim();
  const official = OFFICIAL.exec(target);
  const viaBrowser = named !== undefined || /ブラウザ/u.test(trimmed);
  // 「公式サイト」等の言葉か、「ブラウザで」の言葉のどちらかが要る。「資料を見て」は拾わない。
  if (!official && !viaBrowser) return null;
  const subject = (official ? official[1]! : target).replace(/[のを]$/u, '').trim();
  if (!subject || subject.length > 60 || /^(?:これ|それ|あれ|この|その)$/u.test(subject))
    return null;
  return named ? { subject, browser: named } : { subject };
}
