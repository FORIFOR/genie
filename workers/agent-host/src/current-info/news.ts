/**
 * ニュース。見出しとリンクだけを出す（本文は載せない）。
 *
 * 話題が無ければ NHK の主要・国際ニュース（何も送らない）。話題があれば Google ニュースの
 * 検索 RSS（話題の語だけを送る）。
 */
import { INFO_SCHEMA, type InfoEnvelope, type NewsItem } from './envelope.js';
import type { InfoFetch } from './hosts.js';

export const NHK_TOP = 'https://news.web.nhk/n-data/conf/na/rss/cat0.xml';
/** NHK の国際ニュース（何も送らない）。 */
export const NHK_WORLD = 'https://news.web.nhk/n-data/conf/na/rss/cat6.xml';
const MAX_ITEMS = 5;

function decode(value: string): string {
  return value
    .replace(/^<!\[CDATA\[([\s\S]*)\]\]>$/, '$1')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, '&')
    .trim();
}

function tag(item: string, name: string): string | null {
  const found = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`).exec(item);
  return found ? decode(found[1]!) : null;
}

/** RSS 2.0 の item を読む。https のリンクだけ残す。 */
export function parseRss(xml: string, sourceFallback: string | null): NewsItem[] {
  const items: NewsItem[] = [];
  for (const [, body] of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    let title = tag(body!, 'title');
    const url = tag(body!, 'link');
    if (!title || !url || !url.startsWith('https://')) continue;
    let source = tag(body!, 'source') ?? sourceFallback;
    // Google ニュースの見出しは「見出し - 媒体」
    if (source && title.endsWith(` - ${source}`)) title = title.slice(0, -(source.length + 3));
    else if (!tag(body!, 'source') && sourceFallback === null) {
      const dash = title.lastIndexOf(' - ');
      if (dash > 0) {
        source = title.slice(dash + 3);
        title = title.slice(0, dash);
      }
    }
    const date = tag(body!, 'pubDate');
    const published = date ? new Date(date) : null;
    items.push({
      title,
      url,
      source,
      published_at:
        published && !Number.isNaN(published.valueOf()) ? published.toISOString() : null,
    });
    if (items.length >= MAX_ITEMS) break;
  }
  return items;
}

export async function lookupNews(
  query: { readonly topic: string | null; readonly feed?: 'top' | 'world' },
  get: InfoFetch,
  now: () => Date = () => new Date(),
): Promise<InfoEnvelope> {
  const topic = query.topic?.trim() || null;
  const source = topic
    ? {
        name: 'Google ニュース',
        url: `https://news.google.com/rss/search?${new URLSearchParams({ q: topic, hl: 'ja', gl: 'JP', ceid: 'JP:ja' }).toString()}`,
      }
    : { name: 'NHK', url: query.feed === 'world' ? NHK_WORLD : NHK_TOP };
  const items = parseRss(await get(source.url), topic ? null : 'NHK');
  const base = {
    schema: INFO_SCHEMA,
    kind: 'news',
    sources: [
      { name: source.name, url: topic ? 'https://news.google.com/' : 'https://news.web.nhk/' },
    ],
    fetched_at: now().toISOString(),
  } as const;
  if (items.length === 0)
    return {
      ...base,
      text: topic
        ? `「${topic}」のニュースは見つかりませんでした。`
        : 'いまはニュースを取得できませんでした。',
      data: null,
    };
  const heading = topic ? `「${topic}」のニュース` : '主なニュース';
  const lines = items.slice(0, 3).map((item, i) => `${i + 1}. ${item.title}`);
  return {
    ...base,
    text: `${heading}（${source.name}）: ${lines.join(' ')}`,
    data: { topic, items },
  };
}

/** 見出しを比べるための形（全角半角・空白・記号・媒体名の括弧をそろえる）。 */
function headlineKey(title: string): string {
  return title
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[【［\[(（][^】］\])）]{0,20}[】］\])）]/g, '')
    .replace(/[\s\p{P}\p{S}]/gu, '');
}

function bigrams(value: string): Set<string> {
  const grams = new Set<string>();
  for (let i = 0; i < value.length - 1; i += 1) grams.add(value.slice(i, i + 2));
  return grams;
}

/**
 * 同じ出来事の見出しか。別の媒体が少し違う言い方で出した記事を 1 件にまとめるため、
 * 文字の 2 字組の重なり（Jaccard）で比べる。短すぎる見出しは完全一致だけ。
 */
export function sameStory(a: string, b: string): boolean {
  const x = headlineKey(a);
  const y = headlineKey(b);
  if (!x || !y) return false;
  if (x === y) return true;
  if (Math.min(x.length, y.length) < 10) return false;
  // 数字が違えば別の出来事（「第1試合」と「第2試合」、日付や件数）。
  const digits = (v: string) => (v.match(/\d+/g) ?? []).sort().join(',');
  if (digits(x) !== digits(y)) return false;
  if (x.includes(y) || y.includes(x)) return true;
  const gx = bigrams(x);
  const gy = bigrams(y);
  let shared = 0;
  for (const gram of gx) if (gy.has(gram)) shared += 1;
  return shared / (gx.size + gy.size - shared) >= 0.6;
}
