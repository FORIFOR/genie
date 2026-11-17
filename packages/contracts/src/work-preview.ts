/**
 * 「端末を120台にしたら、提案書とスライドも合わせた案を作って」。
 * 案件フォルダの見積り（Excel）・提案書（Word）・説明（PowerPoint）を、コピーの上でそろえて変え、確かめる。
 * 原本は変えない。結果は端末が確かめた事実だけ（モデルに「直した」と言わせない）。
 */
import { z } from 'zod';

export const WorkPreviewArgs = z
  .object({
    /** 新しい値（「120台」の 120）。 */
    to: z.number().finite().min(0).max(1e12),
    /** 何の数か（「端末」）。見積りの行の見出しと照らす。 */
    subject: z.string().trim().min(1).max(40).optional(),
    /** 案件フォルダ（無ければ、最近変えた案件フォルダを探す）。 */
    folder: z.string().trim().min(1).max(500).optional(),
  })
  .strip();
export type WorkPreviewArgs = z.infer<typeof WorkPreviewArgs>;

export const WorkPreviewResult = z.object({
  folder: z.string(),
  /** 案を置いたフォルダ（原本の隣の「Genie案」の中）。 */
  previewDir: z.string(),
  change: z.object({ label: z.string(), from: z.number(), to: z.number() }),
  edits: z.array(z.object({ file: z.string(), where: z.string(), before: z.string(), after: z.string(), reason: z.string() })),
  checks: z.array(z.object({ name: z.string(), ok: z.boolean(), detail: z.string() })),
  /** 数は合うが、どの数か決められず直していない文。 */
  needsReview: z.array(z.string()),
  /** 覚えている直し（次の案で守る規則）の数。 */
  rules: z.number().int().min(0),
  screenshots: z.array(z.string()),
});
export type WorkPreviewResult = z.infer<typeof WorkPreviewResult>;
