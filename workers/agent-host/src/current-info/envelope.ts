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
  /** 今日(日) / 明日(月) / 明後日(火) / 9/30(水)。どの日も曜日をそろえて付ける。 */
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
  readonly current: {
    readonly temperature: number;
    readonly code: number;
    readonly summary: string;
  } | null;
  readonly days: readonly WeatherDay[];
}

export interface NewsItem {
  readonly title: string;
  readonly url: string;
  readonly source: string | null;
  /** ISO 8601 */
  readonly published_at: string | null;
  /** 配信元が RSS に載せたリード文（NHK のみ。長ければ切る）。Genie が書いた要約ではない。 */
  readonly summary?: string | null;
  /** 分野（配信元の RSS の category。国際のフィードは「国際」）。推し量ったものは入れない。 */
  readonly category?: string | null;
  /** 記事の画像（利用条件の台帳で許されたときだけ写真で出す。いまは付けない）。 */
  readonly media?: import('@genie/contracts').NewsMedia | null;
}

export interface NewsData {
  readonly topic: string | null;
  readonly items: readonly NewsItem[];
  /** 公式のデータ（地震の話題なら気象庁の最近の地震）。カードの図はここの数字だけから作る。 */
  readonly official?:
    import('./quakes.js').OfficialQuakes | import('./typhoons.js').OfficialTyphoons;
}

export interface MarketsData {
  readonly subject: string | null;
  readonly quotes: readonly import('./markets.js').MarketRow[];
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
    }
  | {
      readonly schema: typeof INFO_SCHEMA;
      readonly kind: 'markets';
      readonly text: string;
      readonly data: MarketsData | null;
      readonly sources: readonly { name: string; url: string }[];
      readonly fetched_at: string;
    };
