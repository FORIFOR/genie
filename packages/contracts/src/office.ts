/**
 * 手元の Word / Excel ファイルの編集。**原本は書き換えない。**
 *
 * 端末が原本を読み、モデルに変更の案を出させ、同じフォルダの別名のコピーに書く。
 * 契約に置くのは、頼む形（どのファイルに何をしてほしいか）と、結果の形（何をどこへ書いたか）。
 */
import { z } from 'zod';

export const OFFICE_FORMATS = ['docx', 'xlsx'] as const;
export const OfficeFormat = z.enum(OFFICE_FORMATS);
export type OfficeFormat = z.infer<typeof OfficeFormat>;

/** 依頼。パスは端末の上の絶対パス（`~/` で始めてもよい）。 */
export const OfficeEditArgs = z
  .object({
    path: z
      .string()
      .min(2)
      .max(1024)
      .regex(/^(?:\/|~\/)/, 'absolute path or ~/'),
    // 追加指示が後から書き足されることがある（withInstructions）。
    instruction: z.string().trim().min(1).max(4000),
  })
  // 追加指示の控え（follow_up_instructions）など、使わない欄は捨てる。
  .strip();
export type OfficeEditArgs = z.infer<typeof OfficeEditArgs>;

/** 実際に書いた 1 件。before / after は人が読んで確かめるための短い写し。 */
export const OfficeChange = z.object({
  where: z.string().max(200),
  before: z.string().max(400),
  after: z.string().max(400),
});
export type OfficeChange = z.infer<typeof OfficeChange>;

export const OfficeEditResult = z.object({
  format: OfficeFormat,
  /** 原本。**書き換えていない。** */
  source: z.string(),
  /** 変更を書いた別名のコピー。変更が 1 件も無ければ null（コピーも作らない）。 */
  output: z.string().nullable(),
  summary: z.string().max(1000),
  changes: z.array(OfficeChange).max(200),
  /** 案のうち、形が合わず書かなかったもの。黙って捨てない。 */
  skipped: z.array(z.string().max(300)).max(200),
});
export type OfficeEditResult = z.infer<typeof OfficeEditResult>;
