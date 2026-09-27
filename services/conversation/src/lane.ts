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

/**
 * 外に対して何かを確定させてほしいと言っている（送信・予約・削除など）。
 * 説明を求める句が一緒にあっても action のまま（「請求書を送って。どうすればいい？」は送る依頼）。
 */
const COMMIT_ACTION = [
  /(?:送信|予約|登録|更新|削除|申請|発注)(?:して(?!はいけ|はだめ|はダメ|いない|ない)|を(?:お願い|実行)|する(?:[。！!]|$))/,
  /送って(?!はいけ|はだめ|はダメ|いない|ない)/,
  /送る(?:[。！!]|$)/,
  /^(?:送信|予約|登録|申請|発注)$/,
  /(?:予定|イベント|アカウント|タスク|レコード).{0,16}作成して(?!はいけ|はだめ|はダメ|いない|ない)/,
];

/**
 * 画面を動かしてほしいと言っている（computer.run に回る）。
 * こちらだけは、やり方・意味を尋ねる句（EXPLANATION）があれば action にしない。
 */
const SCREEN_ACTION = [
  /(?:クリック|ダブルクリック|タップ)(?:して(?!はいけ|はだめ|はダメ|いない|ない)|する(?:[。！!]|$))/,
  /(?:操作|起動)(?:して(?!はいけ|はだめ|はダメ|いない|ない)|する(?:[。！!]|$))/,
  /(?:ボタン|リンク|アイコン|タブ|メニュー|画面).{0,10}を押して(?!はいけ|はだめ|はダメ|いない|ない)/,
  /(?:開いて|立ち上げて)(?!はいけ|はだめ|はダメ|いない|ない)/,
  /(?:ログイン|サインイン|サインアップ)(?:して(?!はいけ|はだめ|はダメ|いない|ない)|を手伝って|の操作|を補助|する(?:[。！!]|$))/,
  // 「作業を手伝って」だけでは、画面を動かしてほしいのか決まらない
  /(?:操作|入力|ログイン|サインイン).{0,10}(?:手伝って|補助して|代行して)/,
  // アプリの名指しが無い「検索して」は操作と決めない（下の名指しの規則で拾う）
  /(?:入力|打ち込|タイピング|アクセス|移動)(?:して(?!はいけ|はだめ|はダメ|いない|ない)|する(?:[。！!]|$))/,
  /(?:閉じて|終了して)(?!はいけ|はだめ|はダメ|いない|ない)/,
  /(?:読み取|取得|スクレイピング)(?:して(?!はいけ|はだめ|はダメ|いない|ない)|する(?:[。！!]|$))/,
  // ここから下は、アプリや画面を名指しして読む・探す・動かす。
  // X は単独の一文字だけ（/i の [Xx] は Excel・Next.js・tax の x まで拾っていた）。
  // 「教えて」「調べ」は chat と research の言葉なので、名指しがあっても操作にしない（X の流行・話題は別の規則）。
  // 語の直後の否定（〜しないで・〜らないで・〜してはいけない）は操作の依頼ではない。
  /(?:(?<![A-Za-z0-9])[Xx](?![A-Za-z0-9])|twitter|safari|chrome|ブラウザ|画面|ページ|アプリ|ウィンドウ|カレンダー|メモ|メール|リマインダー|slack|discord|notion|finder|設定|マップ|電卓).{0,25}(?:を|の|から|で).*(?:読み取|見て|確認して|チェックして|取得して|読ん(?:で|だら)|検索|探して|見せて|表示して|開いて)(?!(?:は|も)?[らりれしさせい]?(?:ない|なく|なし|ず|ません)|はいけ|はだめ|はダメ)/i,
  /(?:カレンダー|リマインダー|slack|discord|notion|finder|設定|マップ|電卓).{0,20}(?:を|の|から|で).*(?:操作|入力|追加|消して|削除|開いて)(?!(?:は|も)?[らりれしさせい]?(?:ない|なく|なし|ず|ません)|はいけ|はだめ|はダメ)/i,
  /(?:(?<![A-Za-z0-9])[Xx](?![A-Za-z0-9])|twitter).{0,25}(?:から|で|の).*(?:流行|トレンド|話題|ポスト|ツイート)(?!(?:は|も)?[らりれしさせい]?(?:ない|なく|なし|ず|ません)|はいけ|はだめ|はダメ)/i,
  /(?:safari|chrome|ブラウザ|アプリ|画面).{0,15}(?:で|を|の).*(?:開いて|ログイン|サインイン|入力|操作|手伝って)(?!(?:は|も)?[らりれしさせい]?(?:ない|なく|なし|ず|ません)|はいけ|はだめ|はダメ)/i,
  /(?:画面操作|computer[- ]?use)(?!(?:は|も)?[らりれしさせい]?(?:ない|なく|なし|ず|ません)|はいけ|はだめ|はダメ)/i,
];

/**
 * やり方・意味を尋ねている。操作の語を含んでいても、ほしいのは説明で、画面を動かすことではない。
 * 「Safariでログインする方法を教えて」は action にしない（chat / research のまま）。
 */
const EXPLANATION = [
  /(?:使い方|やり方|書き方|仕方|しかた|方法|手順|要点|コツ|違い|意味|仕組み)(?:を|が|は|について)?[^、。！!？?]{0,4}(?:教えて|知りたい|説明して|解説して|調べて)/,
  /(?:とは|って)(?:何|なに|どういう|どんな)/,
  /どう(?:やって|すれば|したら|やれば|やったら)/,
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

const ACTION = [...COMMIT_ACTION, ...SCREEN_ACTION];

/**
 * 外に対して何かを起こしてほしいと言っているか。
 * 画面の操作の語は、やり方を尋ねているだけなら言っていない。確定させる操作の語は、説明の句があっても言っている。
 */
function asksForAction(text: string): boolean {
  return matches(text, COMMIT_ACTION) || (matches(text, SCREEN_ACTION) && !matches(text, EXPLANATION));
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
  if (asksForAction(text)) {
    return { lane: 'action', reason: 'asked to do something outward' };
  }
  if (isDocumentRequest(text)) {
    return { lane: 'chat', reason: 'asked to write a document from the supplied context' };
  }
  if (matches(text, RESEARCH)) {
    return { lane: 'research', reason: 'asked to look something up' };
  }
  if (matches(text, ACTION)) {
    // 操作の語はあるが、やり方を尋ねている。説明で答え、画面は動かさない。
    return { lane: 'chat', reason: 'asked how to do something, not to do it' };
  }

  // 規則で決まらないものは chat。**推測で振り分けない。**
  return { lane: 'chat', reason: 'nothing more specific applies' };
}

/** Also used to select the writing step, without exposing internal modes to users. */
export function isDocumentRequest(text: string): boolean {
  return COMPOSITION.test(text) && !asksForAction(text) && !matches(text, EXPLICIT_RESEARCH);
}
