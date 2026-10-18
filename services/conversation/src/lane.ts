/**
 * Lane Router。正本 §7.4、Phase 7 実装仕様 §2.1。
 *
 * **利用者に Lane を見せない。**モードを選ばせないのが正本 §2 の前提なので、
 * Lane は入力と文脈から決める。
 *
 * **モデルに決めさせない**（D-48）。規則で決まる部分を規則にしておかないと、
 * 「なぜこの Lane になったか」を説明できなくなる。
 * 規則で決まらないものだけ chat に落とす。
 */
import type { Lane, Modality } from '@genie/contracts';

export interface LaneInput {
  readonly text: string;
  readonly modality: Modality;
  /** 会議中か。会議中の発話は会議の文脈で扱う。 */
  readonly meetingActive?: boolean;
  /** 何かを選択しているか。選択があると「直して」は編集になる。 */
  readonly hasSelection?: boolean;
  /** install 済み agent が名指しされたか。 */
  readonly namedAgent?: string | null;
}

export interface LaneDecision {
  readonly lane: Lane;
  /** なぜそうなったか。**画面には出さないが、説明できるようにしておく。** */
  readonly reason: string;
}

/** 調べてほしいと言っている。 */
const RESEARCH = [
  /調べ(て|る)/,
  /調査/,
  /比較して/,
  /リサーチ/,
  /まとめて.*(教えて|ください)/,
  /について.*(教えて|知りたい)/,
];

/** 外に対して何かを起こしてほしいと言っている。 */
const ACTION = [
  /(?:送信|予約|登録|更新|削除|申請|発注)(?:して(?!はいけ|はだめ|はダメ|いない|ない)|を(?:お願い|実行)|する(?:[。！!]|$))/,
  /送って(?!はいけ|はだめ|はダメ|いない|ない)/,
  /送る(?:[。！!]|$)/,
  /^(?:送信|予約|登録|申請|発注)$/,
  /(?:予定|イベント|アカウント|タスク|レコード).{0,16}作成して(?!はいけ|はだめ|はダメ|いない|ない)/,
  // 電話をかける（Oathra 経由）。「電話番号」「電話で話した」は含めない
  /(?:電話|架電|テレアポ)(?:を)?(?:して|かけて|掛けて|入れて)(?!はいけ|はだめ|はダメ|いない|ない|ほしくない|欲しくない)/,
  /(?:アポ|アポイント)(?:を)?(?:取って|とって)(?!はいけ|はだめ|はダメ|いない|ない)/,
];

/** Writing a deliverable is local composition, not an external side effect.
 * Explicit outward actions still win, including a draft followed by sending it.
 * A research verb still requests research; "まとめてください" alone does not.
 */
const COMPOSITION =
  /(?:文章|文面|案内文|紹介文|説明文|投稿文|メール|お知らせ|レポート|記事|構成案?|台本|企画書|提案書|改善提案|下書き|計画).{0,50}(?:作成|つくって|作って|書いて|まとめて|してください|にして)/;
const EXPLICIT_RESEARCH = [/調べ(て|る)/, /調査して/, /比較して/, /リサーチして/];

/** 手元のものを直してほしいと言っている。 */
const EDIT = [/直して/, /修正して/, /書き換え/, /言い換え/, /短くして/, /整えて/];

/** 会議を始めたい。 */
const MEETING = [/会議を(記録|始め)/, /議事録/, /録音(して|を開始)/];

/** そのまま書き取ってほしい。 */
const DICTATE = [/そのまま(書|入力)/, /口述/, /ディクテーション/];

function matches(text: string, patterns: readonly RegExp[]): boolean {
  return patterns.some((p) => p.test(text));
}

/**
 * Lane を決める。
 *
 * 順序に意味がある。**強い指示が先**で、曖昧なものほど後ろ。
 * 「会議を記録して」は research にも action にも見えるので、
 * 会議として先に拾う。
 */
export function routeLane(input: LaneInput): LaneDecision {
  const text = input.text.trim();

  if (input.namedAgent) {
    return { lane: 'specialist-agent', reason: `named agent: ${input.namedAgent}` };
  }
  if (matches(text, MEETING)) {
    return { lane: 'meeting', reason: 'asked to record a meeting' };
  }
  if (input.meetingActive) {
    // 会議中の発話は会議の文脈。ここで chat に落とすと、
    // 会議の途中で別の話が始まってしまう。
    return { lane: 'meeting', reason: 'a meeting is in progress' };
  }
  if (matches(text, DICTATE)) {
    return { lane: 'dictate', reason: 'asked to transcribe verbatim' };
  }
  if (matches(text, EDIT) && input.hasSelection) {
    // 選択が無い「直して」は、何を直すか決まらない
    return { lane: 'edit', reason: 'asked to change the current selection' };
  }
  if (matches(text, ACTION)) {
    return { lane: 'action', reason: 'asked to do something outward' };
  }
  if (isDocumentRequest(text)) {
    return { lane: 'chat', reason: 'asked to write a document from the supplied context' };
  }
  if (matches(text, RESEARCH)) {
    return { lane: 'research', reason: 'asked to look something up' };
  }

  // 規則で決まらないものは chat。**推測で振り分けない。**
  return { lane: 'chat', reason: 'nothing more specific applies' };
}

/** Also used to select the writing step, without exposing internal modes to users. */
export function isDocumentRequest(text: string): boolean {
  return COMPOSITION.test(text) && !matches(text, ACTION) && !matches(text, EXPLICIT_RESEARCH);
}
