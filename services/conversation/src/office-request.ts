/**
 * 会話から、手元の Word / Excel を直す依頼を見つける。
 *
 * **ファイルの場所が書いてあり、直す言葉があるときだけ。**場所の無い「Excel を直して」は
 * どのファイルか決められないので、ここでは拾わない（画面操作の側に任せる）。
 * 読むだけの依頼（要約・説明）も拾わない。こちらは別名のコピーを書く仕事なので。
 */
export interface OfficeEditRequest {
  readonly path: string;
  readonly instruction: string;
}

const QUOTED = /[「『"']((?:~|\/)[^」』"'\n]+?\.(?:docx|xlsx))[」』"']/iu;
const BARE = /((?:~|\/)[^\s「」『』"']+?\.(?:docx|xlsx))(?=$|[\s、。をにのでとはがも])/iu;
const EDIT =
  /直して|修正|編集|書き換え|書きかえ|追記|追加|足して|加えて|入れて|埋めて|更新|変更|差し替え|削除|消して|整えて|まとめ直|清書|合計|集計|計算して|式を/u;

export function officeEditRequest(text: string): OfficeEditRequest | null {
  const trimmed = text.trim();
  const path = (QUOTED.exec(trimmed) ?? BARE.exec(trimmed))?.[1];
  if (!path || !EDIT.test(trimmed)) return null;
  // 「〜の直し方を教えて」は説明を求めている。直す依頼ではない。
  if (/(?:方法|やり方|仕方|方)を?(?:教えて|知りたい)|ですか[？?]?$/u.test(trimmed)) return null;
  return { path, instruction: trimmed.slice(0, 2000) };
}
