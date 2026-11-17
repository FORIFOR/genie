/**
 * 「〇〇の公式サイトを開いて」。端末が検索して公式サイトを選び、既定のブラウザで開く。
 * 開くのは検索結果に実際に出た URL だけ（モデルに URL を作らせない）。
 */
import { z } from 'zod';

/** 開くブラウザ（本人の指定。無ければ既定のブラウザ）。 */
export const BrowserChoice = z.enum(['default', 'safari', 'chrome']);
export type BrowserChoice = z.infer<typeof BrowserChoice>;

export const BrowserOpenArgs = z
  .object({ subject: z.string().trim().min(1).max(200), browser: BrowserChoice.optional() })
  .strip();
export type BrowserOpenArgs = z.infer<typeof BrowserOpenArgs>;

export const BrowserOpenResult = z.object({
  subject: z.string(),
  url: z.string().nullable(),
  title: z.string().max(300),
  opened: z.boolean(),
  /** 公式と判断した理由（モデルの見立て。事実の確認ではない）。 */
  reason: z.string().max(400),
  /** 開けなかったとき、利用者に伝える理由（見つからなかった等）。 */
  problem: z.string().max(400).optional(),
  /** 開いたブラウザ。 */
  browser: BrowserChoice.optional(),
  /**
   * 表示の確認: true = ブラウザの前面のタブがそのサイトを表示しているのを読み取った。
   * false = 読み取れたが別のページだった。null = 読み取れなかった（「開いた」とは言わない）。
   */
  shown: z.boolean().nullable().optional(),
  shownUrl: z.string().max(500).optional(),
});
export type BrowserOpenResult = z.infer<typeof BrowserOpenResult>;
