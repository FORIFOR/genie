/**
 * 送られたもの（写真・外国語の文）を読んだ結果の形。モデルにはこの形でだけ答えさせる。
 *
 * **読む・決める・実行するを分ける。**モデルが出すのは「何か」「何をしたそうか」「読み取った値」まで。
 * 家計簿に入れてよいか、確かめるかは、ここではなく service.ts が値を検めてから決める。
 */
import { z } from 'zod';

/** 家計簿の費目。モデルにはこの中から選ばせる（自由な費目を増やさない）。 */
export const EXPENSE_CATEGORIES = [
  '食費',
  '外食',
  '日用品',
  '交通',
  '医療',
  '衣服',
  '娯楽',
  '光熱費',
  '通信',
  'その他',
] as const;
export type ExpenseCategory = (typeof EXPENSE_CATEGORIES)[number];

export const Understanding = z.object({
  /** 何か。 */
  kind: z.enum(['receipt', 'meal', 'event', 'screenshot', 'document', 'message', 'other']),
  /**
   * 送った人が何をしたそうか。
   *   record_expense: 家計簿に付けたい（レシート）
   *   estimate_meal : 食べたものの目安を知りたい（料理）
   *   add_event     : 予定に入れたい（案内状・招待）
   *   translate     : 外国語を日本語で知りたい
   *   explain       : 中身を説明してほしい（スクショ・エラー画面・書類）
   *   request       : Genie への頼みごと（そのまま Genie に渡す）
   *   unclear       : 分からない（短く聞き返す）
   */
  intent: z.enum([
    'record_expense',
    'estimate_meal',
    'add_event',
    'translate',
    'explain',
    'request',
    'unclear',
  ]),
  /** 0〜1。読み取りの確かさ。 */
  confidence: z.number(),
  /** 元の文の言語（BCP 47。日本語だけなら "ja"、文字が無ければ "none"）。 */
  source_language: z.string(),
  /** 日本語で 1〜3 行。何が写っているか・何が書いてあるか。 */
  summary_ja: z.string(),
  /** 外国語の文があるときの日本語訳。無ければ null。 */
  translation_ja: z.string().nullable(),
  receipt: z
    .object({
      merchant: z.string().nullable(),
      /** YYYY-MM-DD。読めなければ null。 */
      date: z.string().nullable(),
      /** 支払った合計（最小単位ではなく、円ならそのまま円）。 */
      total: z.number(),
      /** ISO 4217（JPY、USD…）。 */
      currency: z.string(),
      category: z.enum(EXPENSE_CATEGORIES),
      /** 明細を足した額（合計と比べて読み違いを見つける）。読めなければ null。 */
      items_sum: z.number().nullable(),
    })
    .nullable(),
  meal: z
    .object({
      name: z.string(),
      kcal_low: z.number(),
      kcal_high: z.number(),
      protein_g: z.number().nullable(),
      fat_g: z.number().nullable(),
      carbs_g: z.number().nullable(),
    })
    .nullable(),
  event: z
    .object({
      title: z.string(),
      /** YYYY-MM-DDTHH:mm（その土地の時刻）。日付だけなら時刻は null の start_time に。 */
      date: z.string(),
      start_time: z.string().nullable(),
      end_time: z.string().nullable(),
      place: z.string().nullable(),
    })
    .nullable(),
  /** intent が request のとき、Genie に渡す頼み（日本語で）。 */
  request_ja: z.string().nullable(),
  /** intent が unclear のとき、短い聞き返し。 */
  question_ja: z.string().nullable(),
});
export type Understanding = z.infer<typeof Understanding>;

/**
 * 通話の議事録。モデルが書くのは、通話の文字起こしにあることだけ。
 * 1 行は短く（LINE で読む）。無ければ空の配列。
 */
export const CallMinutes = z.object({
  /** 話したこと（話題・頼んだこと）。 */
  topics: z.array(z.string()).max(5),
  /** 決まったこと・分かったこと・Genie の答えの要点。 */
  outcomes: z.array(z.string()).max(5),
  /** 次にやること。who は、利用者がやるなら you、Genie が進めているなら genie。 */
  next: z.array(z.object({ who: z.enum(['you', 'genie']), what: z.string() })).max(5),
});
export type CallMinutes = z.infer<typeof CallMinutes>;
