/**
 * 汎用の答え（llm.answer）は文を返すだけで、何も実行しない。
 * それなのに「買い物リストに入れました」「確認なしで行います」と書くと、本人はしてもらったと思う
 * （evals/line-conversation 2026-10-27: 194 件中 5 件。本人の仕様 v1.0 §5: 実行していない操作を完了と言わない）。
 *
 * 送る前に、実行した・これから自分で実行すると言い切る文を探す。見つかったら、その答えは使わず、
 * まだしていないことを正直に伝える文に差し替える（有料のモデルは作り直さない方針なので、決まった文にする）。
 *
 * 「」の中・引用（> の行）・コードの中は数えない（文の下書きや、言い方の例は主張ではない）。
 */

/**
 * 実行した（〜ました・〜ておきました）か、自分で実行すると約束する（〜ておきます・〜を行います）言い方。
 * 問い（〜ますか）は数えない。「〜すると送信します」のような仕組みの説明（ます）は数えない。
 */
const CLAIM =
  /(?:入れ|登録し|追加し|記録し|記帳し|付け|控え|メモし|送り|送信し|転送し|返信し|共有し|変更し|ずらし|移動し|延期し|削除し|消し|取り消し|キャンセルし|予約し|設定し|購入し|注文し|支払い|申し込み)(?:ました|ておきました|てあります|ておきます)(?![か？?])|(?:行い|実行し)ます(?:ね)?(?=[。！!]|$)/;

/**
 * Genie が扱うもの。知識の答え（「41.8℃を記録しました」）を主張と取り違えないため、主張はこれに触れる文か、
 * 答え全体が「承知しました」で引き受けているときだけ数える。
 */
const DOMAIN =
  /予定|カレンダー|家計簿|買い物|リスト|TODO|やること|メール|LINE|グループ|リマインダー|予約|通知|設定|送信|返信|記帳|登録|メモ|リマインド|アラーム|支出|レシート|領収書/;

/** 主張として読まない部分（「」・『』・引用・コード）を外す。 */
function withoutQuotes(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, '')
    .replace(/`[^`]*`/g, '')
    .replace(/「[^」]*」|『[^』]*』/g, '')
    .split('\n')
    .filter((line) => !/^\s*>/.test(line))
    .join('\n');
}

/**
 * 実行したと主張している文（無ければ null）。
 * `withContext`: 答えに Work Context（本人のメール・予定の記録）を添えているとき。記録の要約
 * （「田中さんに見積を送りました（10/20）」）は本人の過去の行いなので、「承知しました」で引き受けた答えだけを見る。
 */
export function actionClaim(answer: string, withContext = false): string | null {
  const body = withoutQuotes(answer);
  const accepted = /^\s*承知(?:いた)?しました/.test(answer);
  if (withContext && !accepted) return null;
  for (const sentence of body.split(/(?<=[。！？!?\n])/)) {
    // 「送信前の確認は、これまでどおり行います」は守り方の約束で、実行の主張ではない
    if (
      /確認/.test(sentence) &&
      !/確認(?:なし|せず|を?省|を?飛ば|は要りません|はいりません)/.test(sentence) &&
      /(?:行い|実行し)ます/.test(sentence) &&
      !/(?:ました|ておき)/.test(sentence)
    )
      continue;
    if (CLAIM.test(sentence) && (accepted || DOMAIN.test(sentence))) return sentence.trim();
  }
  return null;
}

/** 実行していないことを正直に伝える文。 */
export function notDoneReply(question: string): string {
  const q = question.replace(/\s+/g, ' ').trim();
  const label = q.length > 40 ? `${q.slice(0, 39)}…` : q;
  return [
    `「${label}」は、まだ実行していません。`,
    'この返事では、記録・送信・予定の変更などはしていません。',
  ].join('\n');
}

/**
 * llm.answer の結果を確かめる。主張があれば差し替えた結果と、見つけた文を返す。
 * 結果の形（{ answer } か、文そのもの）は保つ。
 */
export function guardActionClaims(
  result: unknown,
  question: string,
  withContext = false,
): { result: unknown; claim: string | null } {
  const text =
    typeof result === 'string'
      ? result
      : typeof (result as { answer?: unknown } | null)?.answer === 'string'
        ? String((result as { answer: string }).answer)
        : null;
  if (text === null) return { result, claim: null };
  const claim = actionClaim(text, withContext);
  if (!claim) return { result, claim: null };
  const replaced = notDoneReply(question);
  return {
    result: typeof result === 'string' ? replaced : { ...(result as object), answer: replaced },
    claim,
  };
}
