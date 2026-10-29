/**
 * 文が外国語らしいか（モデルに読ませる前の、安い見分け）。
 *
 * かなが 1 字でもあれば日本語として扱う（日本語の文には、ほぼ必ずかなが入る）。
 * 外国語らしいと見たものだけをモデルに渡し、何をしたいか（訳す・頼み）はモデルが決める。
 */
export function looksForeign(text: string): boolean {
  const body = text.replace(/https?:\/\/\S+/g, ' ').replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, ' ');
  if (/[ぁ-ゖァ-ヺ]/.test(body)) return false;
  const count = (re: RegExp) => (body.match(re) ?? []).length;
  if (count(/[가-힣]/g) >= 2) return true; // ハングル
  if (count(/[Ѐ-ӿ฀-๿؀-ۿऀ-ॿͰ-Ͽ]/g) >= 4) return true; // キリル・タイ・アラビア・デーヴァナーガリー・ギリシャ
  if (count(/[一-鿿]/g) >= 6) return true; // かなの無い漢字だけの文（中国語）
  const words = body.match(/[A-Za-zÀ-ÿ]{2,}/g) ?? [];
  return words.length >= 3 && words.join('').length >= 12;
}

const LANGUAGE_NAMES: Readonly<Record<string, string>> = {
  en: '英語',
  zh: '中国語',
  ko: '韓国語',
  fr: 'フランス語',
  de: 'ドイツ語',
  es: 'スペイン語',
  it: 'イタリア語',
  pt: 'ポルトガル語',
  ru: 'ロシア語',
  th: 'タイ語',
  vi: 'ベトナム語',
  id: 'インドネシア語',
  ar: 'アラビア語',
  hi: 'ヒンディー語',
};

/** "en-US" → 英語。知らない言語は「外国語」。 */
export function languageName(tag: string): string {
  return LANGUAGE_NAMES[tag.toLowerCase().split(/[-_]/)[0] ?? ''] ?? '外国語';
}
