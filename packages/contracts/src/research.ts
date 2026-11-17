/**
 * 調べものの問いが、事実だけでなく見立て（予想・評価・比較・おすすめ）を求めているか。
 *
 * 計画（task）と調査（research）の両方が同じ判定を使う。求めていない問いに見立てを
 * 足すと、調べた事実に意見が混ざる。求めている問いには、対象が決まった後に中身を
 * 探す段と、事実とは分けた見立ての段を足す。
 */
export function asksForJudgment(question: string): boolean {
  return /予想|予測|見立て|見通し|勝ち?そう|有力|本命|狙い目|おすすめ|オススメ|勧め|どちらが|どれが(?:良|いい|よい)|比較して|評価して|判断して|forecast|predict|recommend/i.test(
    question,
  );
}
