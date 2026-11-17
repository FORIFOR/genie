/**
 * 今日のまとめ（先回り 段階1、読み取り専用）。
 *
 * 予定・天気・対応が要るもの・ニュース・相場を、**出典と取得時刻つき**で 1 枚にする。
 * 取れなかった情報源は「変化なし」ではなく「未更新」と書く。外へは何も作用しない。
 * 予定と対応事項は Mac が持っている範囲を渡す（Mac の予定は端末の中にある）。
 */
import { z } from 'zod';

export const BRIEF_SCHEMA = 'genie.brief/v1';

export const BriefEvent = z.object({
  title: z.string().trim().min(1).max(200),
  /** ISO 8601（時差つき） */
  start: z.string().datetime({ offset: true }),
  end: z.string().datetime({ offset: true }),
  location: z.string().trim().max(200).optional(),
  allDay: z.boolean().optional(),
});
export type BriefEvent = z.infer<typeof BriefEvent>;

export const BriefAttention = z.object({
  title: z.string().trim().min(1).max(200),
  from: z.string().trim().max(120).optional(),
  /** 期限（分かっているときだけ。ISO 8601） */
  due: z.string().max(40).optional(),
  /** Work の項目 id など、元へ戻るための参照 */
  ref: z.string().max(200).optional(),
  /** 本人が TODO と確かめたもの。無ければメール等からの推測（候補）。 */
  confirmed: z.boolean().optional(),
});
export type BriefAttention = z.infer<typeof BriefAttention>;

export const BriefWeatherLocation = z
  .object({
    status: z.enum(['ok', 'none', 'stale']),
    latitude: z.number().min(-90).max(90).optional(),
    longitude: z.number().min(-180).max(180).optional(),
    reason: z.string().max(120).optional(),
  })
  .refine(
    (value) =>
      value.status !== 'ok' || (value.latitude !== undefined && value.longitude !== undefined),
    'A successful location requires both coordinates',
  );
export type BriefWeatherLocation = z.infer<typeof BriefWeatherLocation>;

export const BriefArgs = z
  .object({
    /** その人の今日（YYYY-MM-DD） */
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    calendar: z.object({
      status: z.enum(['granted', 'denied', 'notDetermined']),
      events: z.array(BriefEvent).max(40),
      fetched_at: z.string().datetime({ offset: true }),
    }),
    attention: z.object({
      /** ok: 読めた / stale: 読めなかった / none: メールや Work をつないでいない */
      status: z.enum(['ok', 'stale', 'none']),
      items: z.array(BriefAttention).max(30),
      fetched_at: z.string().datetime({ offset: true }).optional(),
    }),
    /** 関心のあるニュースの話題（本人が決めたものだけ。無ければ主なニュース） */
    interests: z.array(z.string().trim().min(1).max(40)).max(3).default([]),
    /** 本人が設定した天気の地域。未指定なら端末の既定地域。 */
    region: z.string().trim().min(1).max(80).optional(),
    /** 本人の監視銘柄。空配列は監視なし、未指定なら取得元の既定値。 */
    watchlist: z.array(z.string().trim().min(1).max(20)).max(8).optional(),
    /** 端末の位置取得結果。未許可・失敗を地域設定で置き換えない。 */
    weather_location: BriefWeatherLocation.optional(),
  })
  .strip();
export type BriefArgs = z.infer<typeof BriefArgs>;

export const BriefLine = z.object({
  text: z.string(),
  /** その行の時刻（予定の開始など、HH:MM） */
  time: z.string().optional(),
  url: z.string().optional(),
  ref: z.string().optional(),
  subtitle: z.string().optional(),
  received_at: z.string().datetime({ offset: true }).optional(),
});
export type BriefLine = z.infer<typeof BriefLine>;

export const BriefSection = z.object({
  id: z.enum(['calendar', 'weather', 'mail', 'attention', 'news', 'markets']),
  title: z.string(),
  /** ok: 取れた / stale: 取れなかった（未更新）/ none: 情報源が無い・未設定 */
  status: z.enum(['ok', 'stale', 'none']),
  reason: z.string().optional(),
  fetched_at: z.string().nullable(),
  sources: z.array(z.object({ name: z.string(), url: z.string() })),
  lines: z.array(BriefLine),
});
export type BriefSection = z.infer<typeof BriefSection>;

export const BriefEnvelope = z.object({
  schema: z.literal(BRIEF_SCHEMA),
  date: z.string(),
  generated_at: z.string(),
  /** 画面の短い文（予定の題名などを含む） */
  text: z.string(),
  /**
   * 会話（Gemini Live）へ渡してよい文。**件数・時刻・状態と公開の天気だけ**で、予定の題名・相手・
   * メールの件名は入れない（DESIGN.md §8、docs/privacy-egress.md）。中身は画面のカードで見せる。
   */
  talk: z.string(),
  /** 今日の要点（規則で選ぶ。モデルに作らせない） */
  highlights: z.array(z.string()),
  /**
   * 画面の冒頭に出す 1〜3 文（予定・対応事項・天気から規則で作る。モデルに作らせない）。
   * 予定の題名を含むので会話へは渡さない（`talk` を使う）。古い保存分には無い。
   */
  summary: z.array(z.string().max(200)).max(3).default([]),
  sections: z.array(BriefSection),
});
export type BriefEnvelope = z.infer<typeof BriefEnvelope>;
