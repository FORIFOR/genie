/**
 * 一度に頼まれた複数のことを分ける（仕様 v1.0 §1・§10、評価 2026-10-27: 複数の依頼 24%）。純粋関数。
 *
 *   「明日の予定教えて。あと、昨日のレシートも家計簿に入れて」 → ["明日の予定教えて", "昨日のレシートも家計簿に入れて"]
 *   「予定と天気とニュース」「明日の予定と天気教えて」         → ["明日の予定を教えて", "明日の天気を教えて", …]
 *
 * 分けるのは、つなぎの言葉（あと・それと・それから・ついでに）が文の切れ目にあるときと、
 * よく聞かれる情報（予定・天気・ニュース・株価・家計簿）を「と」で並べたときだけ。
 * 「あと30分で」「あと何日」のような「あと」では分けない。分けられなければ null（1 つの頼みのまま）。
 */

const CONNECTOR = /(?:^|[。．.!！?？\n]|[、,]\s*|(?<=て|で|ね|よ)\s+)\s*(?:あと(?:は)?|それと|それから|ついでに|あわせて|あとそれと)\s*[、,]?\s*/g;

/** 並べて聞かれる情報。日付の言葉（明日の）は、それぞれに付け直す。 */
const TOPIC = '(?:予定|スケジュール|天気|ニュース|株価|家計簿)';
const LISTED = new RegExp(
  `^(今日の|明日の|あしたの|今週の|来週の)?(${TOPIC})((?:\\s*[と、・]\\s*${TOPIC})+)\\s*(?:を|は)?\\s*(?:教えて|おしえて|知りたい|見せて|ちょうだい)?(?:ください)?[。？?!！\\s]*$`,
);

const MAX_PARTS = 4;

export function splitRequests(text: string): string[] | null {
  const t = text.trim();
  if (t.length < 4 || t.length > 400) return null;

  const listed = LISTED.exec(t);
  if (listed) {
    const day = listed[1] ?? '';
    const topics = [listed[2]!, ...listed[3]!.split(/[と、・]/).map((x) => x.trim()).filter(Boolean)];
    const unique = [...new Set(topics)];
    if (unique.length >= 2)
      return unique.slice(0, MAX_PARTS).map((topic) => `${day}${topic}を教えて`);
  }

  const parts = t
    .split(CONNECTOR)
    .map((p) => p.replace(/^[、,。\s]+|[、,\s]+$/g, '').trim())
    .filter((p) => p.length >= 2);
  if (parts.length < 2) return null;
  // 「あと30分で着く」「あと何日？」は、つなぎではない（数・問いが続く）
  if (/(?:あと|それから)\s*(?:\d|[一二三四五六七八九十何]|少し|ちょっと|で)/.test(t) && parts.length === 2) {
    const second = parts[1]!;
    if (/^(?:\d|[一二三四五六七八九十何]|少し|ちょっと|で)/.test(second)) return null;
  }
  // 確かめ中への返事（「送って、あと最後によろしくつけて」「はい。あと…」）は、前の頼みを直しているので分けない
  if (/^(?:はい|うん|ok|おk|おっけ|送って|お願い|おねがい|それで|いいよ|そうして)/i.test(parts[0]!)) return null;
  // 「トイレットペーパーとティッシュ、あと洗剤」の「洗剤」は、前と同じ頼みの続き（物の名前だけ）
  if (parts.slice(1).some((p) => p.length <= 8 && !/[をにへでてがは]|して|教えて|[？?]/.test(p))) return null;
  return parts.slice(0, MAX_PARTS);
}
