/**
 * LINE のリッチメニュー（トークの下の 4 つのボタン）。**純粋な定義。**
 *
 *   仕事 → 「今の作業どうなってる？」（見通しのカードと、仕事のホームのボタン）
 *   電話 → 「電話して」（Genie と声で話すページのリンク）
 *   予定 → 「今日の予定を教えて」（予定のカード）
 *   使い方 → 「使い方」（できることの一覧。決まった答え）
 *
 * ボタンは**本人が打つのと同じ文を送るだけ**（message action）。新しい道は作らない。
 * 登録は scripts/line-rich-menu.mjs（LINE のアカウントの見た目が変わるので、本人の許可のあとで）。
 */
export const RICH_MENU_NAME = 'genie-main-v1';

/** 画像の大きさ（LINE の小さいメニューの大きさ。幅 2500）。 */
export const RICH_MENU_SIZE = { width: 2500, height: 843 } as const;

export interface RichMenuButton {
  readonly label: string;
  /** ボタンの下の小さな説明。 */
  readonly hint: string;
  /** 押したときに本人の発言として送る文。 */
  readonly text: string;
}

export const RICH_MENU_BUTTONS: readonly RichMenuButton[] = [
  { label: '仕事', hint: '状況とホーム', text: '今の作業どうなってる？' },
  { label: '電話', hint: 'Genie と声で話す', text: '電話して' },
  { label: '予定', hint: '今日の予定', text: '今日の予定を教えて' },
  { label: '使い方', hint: 'できること', text: '使い方' },
];

/** LINE の Messaging API（POST /v2/bot/richmenu）に渡す本文。 */
export function richMenuBody() {
  const width = Math.floor(RICH_MENU_SIZE.width / RICH_MENU_BUTTONS.length);
  return {
    size: RICH_MENU_SIZE,
    // 開いた状態で出す（どこを押せばよいか、最初から見える）
    selected: true,
    name: RICH_MENU_NAME,
    chatBarText: 'メニュー',
    areas: RICH_MENU_BUTTONS.map((b, i) => ({
      bounds: {
        x: i * width,
        y: 0,
        // 最後のボタンは端まで（割り切れない分を取りこぼさない）
        width: i === RICH_MENU_BUTTONS.length - 1 ? RICH_MENU_SIZE.width - i * width : width,
        height: RICH_MENU_SIZE.height,
      },
      action: { type: 'message', label: b.label, text: b.text },
    })),
  };
}
