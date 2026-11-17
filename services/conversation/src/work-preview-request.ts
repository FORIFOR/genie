/**
 * 会話から、案件の数を変えた案（見積り・提案書・スライドをそろえて）を作る依頼を見つける。
 *
 * **数と、それを変える言葉と、案件の書類の言葉がそろったときだけ。**
 * 「端末を120台にしたら提案書も合わせた案を作って」「見積りの数量を150にした場合の資料を作って」。
 * やり方を聞いているだけ（「〜する方法を教えて」）は拾わない。
 */
export interface WorkPreviewRequest {
  readonly to: number;
  readonly subject?: string;
  readonly folder?: string;
}

const DOCUMENTS = /見積|提案書|提案資料|資料|スライド|パワポ|パワーポイント|ワード|エクセル|案件|書類/u;
const CHANGE =
  /(?:([^\s、。,をのはが「」]{1,12}?)(?:の(?:数量|台数|個数|件数|人数|本数|数))?(?:を|は|が)\s*)?(\d{1,3}(?:,\d{3})+|\d+)\s*(台|個|件|名|本|人|セット|式|ライセンス|枚)?\s*(?:に\s*(?:し|変え|増やし|減らし)(?:たら|た|て)|に変更|へ(?:変更|増や|減ら))/u;
const FOLDER = /((?:~|\/Users\/)[^\s「」『』"']+?)\/?(?=$|[\s、。のでにを])/u;

export function workPreviewRequest(text: string): WorkPreviewRequest | null {
  const trimmed = text.trim();
  if (!DOCUMENTS.test(trimmed)) return null;
  if (/(?:方法|やり方|仕方|方)を?(?:教えて|知りたい)/u.test(trimmed)) return null;
  const m = CHANGE.exec(trimmed);
  if (!m) return null;
  const to = Number(m[2]!.replace(/,/g, ''));
  const subject = m[1] && !/^(見積|見積り|見積もり|数量|台数|数)$/u.test(m[1]) ? m[1].replace(/^(?:見積(?:もり|り)?の)/u, '') : undefined;
  const folder = FOLDER.exec(trimmed)?.[1];
  // ファイルを名指しした編集は office.edit の仕事
  if (folder && /\.(?:docx|xlsx|pptx)$/iu.test(folder)) return null;
  return { to, ...(subject ? { subject } : {}), ...(folder ? { folder } : {}) };
}
