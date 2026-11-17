/**
 * ニュースの画像を出してよいか（Media Rights Resolver。本人の方針 2026-10-29）。
 *
 * 画像は、**確認済みの利用条件の台帳（NEWS_MEDIA_LICENSES）に載っている使い方のときだけ**写真で出す。
 * それ以外（台帳に無い・期限切れ・その使い方が許されていない・画像の置き場所が契約の相手と違う）は、
 * 分野のアイコンに切り替える。og:image が公開されている、API がくれた、というだけでは出さない。
 *
 *   1. 契約済みのニュース API の画像     → 契約の条件どおり
 *   2. 公式の発表資料・公的機関の画像   → 再利用の条件を 1 件ずつ確かめてから台帳へ
 *   3. 許諾済み・オープンライセンスの画像 → 出典とライセンスの条件どおり
 *   4. 確かめられない                    → 分野のアイコン
 *
 * 台帳はコードとして置く（足すときは条件を読んだ人がレビューを通して足す）。いまは空（契約が無い）。
 */

/** 使い方は 1 つずつ許可を見る（LINE で配る・LIFF のページで見せる・保存する・加工する）。 */
export type MediaUse = 'line_distribution' | 'liff_display' | 'store' | 'transform';

export interface MediaLicense {
  readonly id: string;
  /** 契約・許諾の相手（ニュースの配信元の名前ではなく、画像の権利の出どころ）。 */
  readonly provider: string;
  /** 画像の置き場所として認めるホスト（ここ以外の URL は、同じ相手を名乗っても出さない）。 */
  readonly imageHosts: readonly string[];
  readonly allowedUses: readonly MediaUse[];
  /** 画像に添える出典の文（必須）。 */
  readonly attribution: string;
  /** 条件の期限（ISO 8601）。null は期限なし。 */
  readonly validUntil: string | null;
}

/** 確認済みの利用条件の台帳。 */
export const NEWS_MEDIA_LICENSES: readonly MediaLicense[] = [];

/** 記事に付いてきた画像（配信元が名乗るもの。ここではまだ何も許していない）。 */
export interface NewsMedia {
  readonly image_url: string;
  readonly provider: string;
  readonly license_id: string | null;
}

export type NewsImageDecision =
  | { readonly display: 'photo'; readonly url: string; readonly attribution: string }
  | {
      readonly display: 'icon';
      readonly reason:
        | 'no_image'
        | 'no_license'
        | 'unknown_license'
        | 'other_provider'
        | 'use_not_allowed'
        | 'expired'
        | 'untrusted_host';
    };

export function resolveNewsImage(
  media: NewsMedia | null | undefined,
  use: MediaUse,
  ledger: readonly MediaLicense[],
  now: Date,
): NewsImageDecision {
  if (!media || typeof media.image_url !== 'string') return { display: 'icon', reason: 'no_image' };
  if (!media.license_id) return { display: 'icon', reason: 'no_license' };
  const license = ledger.find((l) => l.id === media.license_id);
  if (!license) return { display: 'icon', reason: 'unknown_license' };
  if (license.provider !== media.provider) return { display: 'icon', reason: 'other_provider' };
  if (!license.allowedUses.includes(use)) return { display: 'icon', reason: 'use_not_allowed' };
  if (license.validUntil !== null && Date.parse(license.validUntil) <= now.getTime())
    return { display: 'icon', reason: 'expired' };
  let url: URL;
  try {
    url = new URL(media.image_url);
  } catch {
    return { display: 'icon', reason: 'untrusted_host' };
  }
  if (url.protocol !== 'https:' || !license.imageHosts.includes(url.hostname.toLowerCase()))
    return { display: 'icon', reason: 'untrusted_host' };
  if (!license.attribution.trim()) return { display: 'icon', reason: 'unknown_license' };
  return { display: 'photo', url: url.href, attribution: license.attribution };
}
