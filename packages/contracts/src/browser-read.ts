/**
 * 「<URL> を読んで要約して」。端末が Genie 専用のブラウザ（本人の Chrome とは別のプロファイル・画面に出さない）で
 * ページを開き、本文を取り出して、端末のモデルで問いに答える。
 *
 * **読むだけ。**押す・入力する・ログインする・ダウンロードすることはしない。
 * 開くのは公開の http / https だけ。Mac の中・家の中のアドレス（localhost・192.168.x.x など）は開かない。
 */
import { z } from 'zod';

export const BrowserReadArgs = z
  .object({
    url: z.string().trim().min(1).max(2000),
    question: z.string().trim().min(1).max(500),
  })
  .strip();
export type BrowserReadArgs = z.infer<typeof BrowserReadArgs>;

export const BrowserReadResult = z.object({
  url: z.string().max(2000),
  /** 転送のあとに表示されたアドレス。読めなかったときは null。 */
  finalUrl: z.string().max(2000).nullable(),
  title: z.string().max(300),
  /** 本文を取り出せた。false なら answer は null で、problem に理由。 */
  read: z.boolean(),
  /** 取り出した本文の長さ（中身は返さない）。 */
  chars: z.number().int().nonnegative(),
  /** 端末のモデルの答え（本文に無いことは書かせない）。 */
  answer: z.string().max(4000).nullable(),
  problem: z.string().max(400).optional(),
});
export type BrowserReadResult = z.infer<typeof BrowserReadResult>;

const PRIVATE_V4 = [
  /^0\./,
  /^10\./,
  /^127\./,
  /^169\.254\./,
  /^172\.(?:1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
  /^100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./,
];

/**
 * 開いてよい公開のアドレスか。http / https で、名前が localhost・.local・.internal・.home.arpa でなく、
 * 数字のアドレスなら家の中・Mac の中のものでない。ページの中から読みに行く先にも同じ線を引く。
 */
export function isPublicWebUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  if (url.username || url.password) return false;
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (!host || !host.includes('.')) return false;
  if (/(?:^|\.)(?:localhost|local|internal|home\.arpa|lan)$/.test(host)) return false;
  if (host.startsWith('[')) return false; // IPv6 の数字のアドレスは開かない（家の中との区別をここでしない）
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) return !PRIVATE_V4.some((r) => r.test(host));
  return true;
}
