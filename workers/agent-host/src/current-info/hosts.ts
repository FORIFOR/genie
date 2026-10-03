/**
 * いまの情報を取りに行ってよい相手。**ここに無い所へは出ない。**
 *
 * 何を送るかは docs/privacy-egress.md の表と同じ。変えたら両方と
 * scripts/verify-privacy-egress.sh の一覧を揃える（揃っていないとゲートが落ちる）。
 */
export const CURRENT_INFO_HOSTS = [
  // 予報: 緯度経度と日数だけ
  'api.open-meteo.com',
  // 地名 → 緯度経度: 質問に出た地名だけ（既定の地域は同梱の表で引き、送らない）
  'geocoding-api.open-meteo.com',
  // NHK の主要ニュース RSS: 何も送らない
  'news.web.nhk',
  // 話題つきのニュース: 話題の語だけ
  'news.google.com',
] as const;

export type InfoFetch = (url: string) => Promise<string>;

const MAX_BYTES = 1_000_000;

export class InfoFetchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InfoFetchError';
  }
}

/** 取得の入口は 1 つ。https、一覧の相手、5 秒、1MB まで。転送先には付いて行かない。 */
export function infoFetch(fetchImpl: typeof fetch = fetch, timeoutMs = 5_000): InfoFetch {
  return async (raw) => {
    const url = new URL(raw);
    if (url.protocol !== 'https:' || !(CURRENT_INFO_HOSTS as readonly string[]).includes(url.hostname))
      throw new InfoFetchError(`not an allowed information source: ${url.hostname}`);
    const response = await fetchImpl(url, {
      redirect: 'error',
      credentials: 'omit',
      headers: { accept: 'application/json, application/rss+xml, application/xml, text/xml' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) throw new InfoFetchError(`${url.hostname} returned HTTP ${response.status}`);
    const body = await response.text();
    if (body.length > MAX_BYTES) throw new InfoFetchError(`${url.hostname} returned too much data`);
    return body;
  };
}
