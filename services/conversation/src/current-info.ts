/**
 * いまの情報（天気・ニュース・株価）を聞いているか。
 *
 * **モデルに決めさせない**（D-48、lane.ts と同じ）。ここで拾ったものは端末の
 * `info.lookup` が取りに行き、数字は取得元の値をそのまま使う。モデルに答えさせると
 * 「分かりません」か、もっと悪いと、それらしい予報を作ってしまう。
 *
 * ブラウザでの操作（「Safariで天気を検索して」）は ACTION が先に拾うので、ここには来ない。
 */

export type CurrentInfoWhen = 'today' | 'tomorrow' | 'day_after' | 'weekend' | 'week' | `weekday:${number}`;

export type CurrentInfoQuery =
  | { readonly kind: 'weather'; readonly when: CurrentInfoWhen; readonly place: string | null }
  | { readonly kind: 'news'; readonly topic: string | null }
  | { readonly kind: 'quote'; readonly subject: string };

const WEATHER = /天気|気温|予報|降水|傘|晴れ|台風/;
/** 「雨」「雪」だけでは天気の質問と決めない（「雨宮さん」「雪見だいふく」）。 */
const PRECIP = /雨|雪/;
const PRECIP_QUESTION = /(?:雨|雪)(?:が|は)?(?:降る|降り|ふる|ふり|になる|予報|の確率|[？?]|$)|(?:雨|雪)(?:かな|かも|ですか|そう)/;
const NEWS = /ニュース|速報|ヘッドライン/;
const QUOTE = /株価|日経平均|TOPIX|ダウ平均|終値|値動き/i;
/** 何かを作ってほしい依頼は、情報の質問ではない（「天気予報アプリの企画書を作って」）。 */
const MAKE = /(?:作って|作成|書いて|つくって|企画|設計|実装|アプリ|サイト|記事を)/;

const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'] as const;

function when(text: string): CurrentInfoWhen {
  if (/明後日|あさって/.test(text)) return 'day_after';
  if (/明日|あした|あす/.test(text)) return 'tomorrow';
  if (/週末|土日/.test(text)) return 'weekend';
  if (/今週|一週間|1週間|来週/.test(text)) return 'week';
  const day = /([日月火水木金土])曜/.exec(text);
  if (day) return `weekday:${WEEKDAYS.indexOf(day[1] as (typeof WEEKDAYS)[number])}`;
  return 'today';
}

/** 地名でない語。「明日の天気」の「明日」を地名にしない。 */
const NOT_PLACE =
  /^(?:今日|きょう|本日|明日|あした|あす|明後日|あさって|週末|土日|今週|来週|一週間|1週間|[日月火水木金土]曜日?|今|いま|今夜|今晩|朝|昼|夜|午前|午後|天気|気温|予報|降水確率|雨|雪|傘|ここ|この辺|近く|うち|家|外|Google|google|グーグル|Yahoo|ヤフー|ネット|ウェブ|Web|web|ブラウザ)$/;

function place(text: string): string | null {
  const head = text.replace(/[、。！!？?\s]/g, '');
  for (const segment of head.split(/の|は|で|って/)) {
    const candidate = segment.replace(/^(?:ねえ|ねぇ|ちょっと|えっと)/, '');
    if (!candidate || candidate.length > 12) continue;
    if (NOT_PLACE.test(candidate)) continue;
    if (WEATHER.test(candidate) || PRECIP.test(candidate)) break;
    if (/[をがにへとも]|教え|知り|どう|いる|要る|必要/.test(candidate)) break;
    return candidate;
  }
  return null;
}

function topic(text: string): string | null {
  const before = /^(.{1,20}?)(?:に関する|についての|関連の|の)(?:最新)?(?:ニュース|速報)/.exec(text.replace(/\s/g, ''));
  if (!before?.[1]) return null;
  const value = before[1].replace(/^(?:最新|今日|きょう|本日|昨日|今朝|最近|いま|今)(?:の)?/, '');
  if (!value || /^(?:今日|きょう|本日|昨日|今朝|最近|最新|主要|国内|トップ)$/.test(value)) return null;
  return value;
}

export function classifyCurrentInfo(input: string): CurrentInfoQuery | null {
  const text = input.trim();
  if (!text || text.length > 80 || MAKE.test(text)) return null;
  if (NEWS.test(text)) return { kind: 'news', topic: topic(text) };
  if (QUOTE.test(text)) return { kind: 'quote', subject: text };
  if (WEATHER.test(text) || PRECIP_QUESTION.test(text)) {
    return { kind: 'weather', when: when(text), place: place(text) };
  }
  return null;
}
