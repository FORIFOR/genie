/**
 * 成果物の形。Mac の Dock はこれを見てカードにする（apps/genie-macos …/InfoCard.swift）。
 *
 * `text` は読み上げ・カードを描けない画面用の、そのまま読める答え。
 * `data` が null なら文だけ（場所が見つからない等）。
 */
export const INFO_SCHEMA = 'genie.info/v1';

export interface WeatherDay {
  /** YYYY-MM-DD（その場所の日付） */
  readonly date: string;
  /** 今日 / 明日 / 明後日 / 9/28(日) */
  readonly label: string;
  /** WMO weather code。絵はアプリが決める。 */
  readonly code: number;
  readonly summary: string;
  readonly high: number | null;
  readonly low: number | null;
  /** 降水確率の最大（%） */
  readonly precipitation: number | null;
}

export interface WeatherData {
  readonly place: string;
  /** 今日を聞かれたときだけ。 */
  readonly current: { readonly temperature: number; readonly code: number; readonly summary: string } | null;
  readonly days: readonly WeatherDay[];
}

export interface NewsItem {
  readonly title: string;
  readonly url: string;
  readonly source: string | null;
  /** ISO 8601 */
  readonly published_at: string | null;
}

export interface NewsData {
  readonly topic: string | null;
  readonly items: readonly NewsItem[];
}

export type InfoEnvelope =
  | {
      readonly schema: typeof INFO_SCHEMA;
      readonly kind: 'weather';
      readonly text: string;
      readonly data: WeatherData | null;
      readonly sources: readonly { name: string; url: string }[];
      readonly fetched_at: string;
    }
  | {
      readonly schema: typeof INFO_SCHEMA;
      readonly kind: 'news';
      readonly text: string;
      readonly data: NewsData | null;
      readonly sources: readonly { name: string; url: string }[];
      readonly fetched_at: string;
    };
