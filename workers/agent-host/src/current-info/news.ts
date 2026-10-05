/**
 * ニュース。見出しとリンクだけを出す（本文は載せない）。
 *
 * 話題が無ければ NHK の主要ニュース（何も送らない）。話題があれば Google ニュースの
 * 検索 RSS（話題の語だけを送る）。
 */
import { INFO_SCHEMA, type InfoEnvelope, type NewsItem } from './envelope.js';
import type { InfoFetch } from './hosts.js';

export const NHK_TOP = 'https://news.web.nhk/n-data/conf/na/rss/cat0.xml';
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
      published_at: published && !Number.isNaN(published.valueOf()) ? published.toISOString() : null,
    });
    if (items.length >= MAX_ITEMS) break;
  }
  return items;
}

export async function lookupNews(
  query: { readonly topic: string | null },
  get: InfoFetch,
  now: () => Date = () => new Date(),
): Promise<InfoEnvelope> {
  const topic = query.topic?.trim() || null;
  const source = topic
    ? {
        name: 'Google ニュース',
        url: `https://news.google.com/rss/search?${new URLSearchParams({ q: topic, hl: 'ja', gl: 'JP', ceid: 'JP:ja' }).toString()}`,
      }
    : { name: 'NHK', url: NHK_TOP };
  const items = parseRss(await get(source.url), topic ? null : 'NHK');
  const base = {
    schema: INFO_SCHEMA,
    kind: 'news',
    sources: [{ name: source.name, url: topic ? 'https://news.google.com/' : 'https://news.web.nhk/' }],
    fetched_at: now().toISOString(),
  } as const;
  if (items.length === 0)
    return {
      ...base,
      text: topic ? `「${topic}」のニュースは見つかりませんでした。` : 'いまはニュースを取得できませんでした。',
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
