/**
 * 「〇〇の公式サイトを開いて」。端末が検索して公式サイトを選び、既定のブラウザで開く。
 * 開くのは検索結果に実際に出た URL だけ（モデルに URL を作らせない）。
 */
import { z } from 'zod';

export const BrowserOpenArgs = z.object({ subject: z.string().trim().min(1).max(200) }).strip();
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
});
export type BrowserOpenResult = z.infer<typeof BrowserOpenResult>;
