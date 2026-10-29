/**
 * チャットへ送る文面。**純粋関数。**
 *
 * 返すのは区切りだけ（受付・承認待ち・一時停止・終わり）。途中経過は流さない。
 * 内部の tool 名や JSON は出さない（正本 §9.3）。Lane も出さない。
 */
import { CALL_OUTCOME_TEXT, type CallReport } from '@genie/contracts';
import type { OutgoingButton, OutgoingMessage } from './send.js';

export type PostingPolicy = 'summary_and_link' | 'full_text';

export const linkPrompt = (): OutgoingMessage => ({
  text: 'Genie とまだ連携していません。Mac の Genie で「アプリ連携」の「Slack・LINE」を開き、表示された「連携 XXXXXXXX」をこのトークに送ってください。',
});

export const linked = (): OutgoingMessage => ({
  text: '連携しました。ここで頼んだことを Genie が進めます。外へ送る操作は、確認してから行います。やめるときは「連携解除」と送ってください。',
});

export const linkFailed = (reason: 'invalid' | 'already_linked'): OutgoingMessage => ({
  text:
    reason === 'already_linked'
      ? 'このアカウントはすでに Genie と連携しています。'
      : 'コードが違うか、期限（10 分）が切れています。Genie で新しいコードを出して、送り直してください。',
});

export const unlinked = (): OutgoingMessage => ({
  text: '連携を解除しました。このトークでの頼みごとは受け付けません。',
});

export const accepted = (title: string | null): OutgoingMessage => ({
  text: `承知しました${title ? `：${title}` : ''}。終わったらお知らせします。`,
});

export const notice = (text: string): OutgoingMessage => ({ text });

/** 調べものが長引いている（質問なので「承知しました」は付けない）。 */
export const lookingUp = (): OutgoingMessage => ({
  text: '調べています。分かりしだい、このトークでお知らせします。',
});

/**
 * 会話の答え（あいさつ・質問）。前置きを付けずに、答えの文だけ。
 * 答えは Markdown で書かれる。文は見出しと太字の記号だけ外したもの（Slack と通知用）。LINE は元の Markdown から
 * Flex Message を作る（rich.ts）。
 */
export const answer = (markdown: string, card?: string): OutgoingMessage => ({
  markdown,
  ...(card ? { card } : {}),
  text: markdown
    .replace(/^#{1,6}[^\n]*\n+/, '') // 先頭の見出し（答えの題）は本文に要らない
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .trim(),
});

/** 予約の時間になって始めた仕事。 */
export const scheduledStarted = (title: string | null): OutgoingMessage => ({
  text: `⏰ 予約の時間になったので始めました${title ? `：${title}` : ''}。終わったらお知らせします。`,
});

export const received = (): OutgoingMessage => ({
  text: 'うまく受け取れませんでした。少し待ってから、もう一度送ってください。',
});

/** 受けた依頼の処理の途中で Genie が止まった。仕事ができたかは分からないので、確かめ先を示す。 */
export const interrupted = (): OutgoingMessage => ({
  text: '受け取った依頼の途中で Genie が止まりました。仕事になったかは Genie の作業一覧で確かめてください。無ければ、もう一度送ってください。',
});

/** 写真以外の添付（音声・動画・ファイル）。いまは読めない。 */
export const mediaUnsupported = (): string =>
  '音声・動画・ファイルはまだ読めません。写真か文字で送ってください。';

/** 写真の本体を取りに行けなかった。 */
export const mediaFailed = (): string => '写真を受け取れませんでした。もう一度送ってください。';

/**
 * グループに招かれた（本人の設計 2026-10-28 改:「招待＝即利用開始、会話理解＝透明性のある設定、発言＝呼ばれたときだけ」）。
 * 挨拶は短く 1 回。会話を覚えるかは「@Genie 設定」で、いまは覚えていないことも言う。
 */
export const groupWelcome = (ready: boolean): OutgoingMessage =>
  ready
    ? {
        text: [
          'こんにちは、Genie です！',
          'このグループで、お店探し・予定の調整・買い物リストなどをお手伝いします。すぐに使えます。',
          'ふだんは会話に割り込まず、「@Genie」や「ジーニー、〜」と呼ばれたときにお返事します。',
          '会話の流れを覚えて使うかどうかと、その期間は「@Genie 設定」で確かめ・変えられます（いまは覚えていません）。',
        ].join('\n'),
        quickReplies: ['@Genie 設定', '@Genie 何ができる？'],
      }
    : {
        text: [
          'こんにちは、Genie です！',
          'このグループで、お店探し・予定の調整・買い物リストなどをお手伝いします。',
          'Genie を使っている人が、このグループで一度話しかけると使えるようになります。ふだんは会話に割り込まず、呼ばれたときにお返事します。',
        ].join('\n'),
      };

/** 招かれたが、まだ持ち主が決まっていない（連携している人がこのグループでまだ話していない）。 */
export const groupPending = (): OutgoingMessage => ({
  text: 'まだ準備中です。Genie を使っている人が、このグループで一度話しかけると使えるようになります。',
});

/** 「@Genie このグループをやめる」で止めたグループ。招き直しでは戻さない。 */
export const groupStopped = (): OutgoingMessage => ({
  text: 'このグループでは Genie を止めています。また使うときは「@Genie 再開」と送ってください。',
  quickReplies: ['@Genie 再開'],
});

export const groupResumed = (): OutgoingMessage => ({
  text: '再開しました。呼ばれたときにお返事します。会話を覚えるかどうかは「@Genie 設定」で確かめられます。',
  quickReplies: ['@Genie 設定'],
});

export const groupDisabled = (): OutgoingMessage => ({
  text: 'このグループでの利用をやめました。これまでの家計簿・リストは残っています。',
});

export const groupHelpShort = (): string =>
  'このグループでは @Genie を付けて送ってください。できることは「@Genie 使い方」。';

export const mentionAck = (): OutgoingMessage => ({
  text: '受け取りました。結果は DM でお返しします。',
});

export interface ApprovalView {
  readonly summary: string;
  readonly details: readonly { readonly label: string; readonly value: string }[];
  readonly primaryActionLabel: string;
}

/**
 * 承認待ち。ボタンを付けてよいのは、**外への送信（EXTERNAL_COMMIT）だけ**。
 * それ以外（削除・お金・規制のある記録）は Genie の承認カードへ案内する。
 */
export function waitingApproval(
  approval: ApprovalView,
  buttons: { approve: string; reject: string } | null,
): OutgoingMessage {
  const lines = [
    `確認してください：${approval.summary}`,
    ...approval.details.slice(0, 8).map((d) => `・${d.label}：${d.value.slice(0, 200)}`),
    '',
    buttons
      ? '進めてよければボタンを押してください（10 分で無効になります）。'
      : 'Genie の承認カードで確認してください。',
  ];
  const actions: OutgoingButton[] | undefined = buttons
    ? [
        { label: approval.primaryActionLabel, value: buttons.approve, style: 'primary' },
        { label: 'やめる', value: buttons.reject, style: 'danger' },
      ]
    : undefined;
  return {
    text: lines.join('\n'),
    ...(actions
      ? {
          buttons: actions,
          approval: {
            summary: approval.summary,
            details: approval.details.map((d) => ({ label: d.label, value: d.value })),
            note: '押すまで実行しません（10 分で無効になります）。',
          },
        }
      : {}),
  };
}

export const paused = (message: string | null): OutgoingMessage => ({
  // 失敗ではない。待てば戻る（正本 §4.4）
  text: message ?? 'Mac がオフラインのため止まっています。Mac が戻ると続きから進めます。',
});

/**
 * 終わりの知らせ。仕事のホームのリンク（本人だけ・読むだけ）があれば、Mac の作業一覧ではなくそこへ案内する
 * （外で受けた知らせから、外で開ける）。
 */
export function completed(
  title: string | null,
  policy: PostingPolicy,
  body: string | null,
  homeUrl: string | null = null,
): OutgoingMessage {
  const head = `終わりました${title ? `：${title}` : ''}。`;
  if (policy === 'full_text' && body)
    return {
      text: `${head}\n\n${body.slice(0, 2500)}${body.length > 2500 ? '\n…（続きは Genie で）' : ''}`,
      markdown: `${head}\n\n${body.slice(0, 6000)}${body.length > 6000 ? '\n\n…（続きは Genie で）' : ''}`,
    };
  if (homeUrl)
    return {
      text: `${head}経過と確かめた結果は仕事のホームで開けます。\n${homeUrl}`,
      markdown: `${head}経過と確かめた結果は仕事のホームで開けます。\n\n[仕事のホームを開く](${homeUrl})`,
    };
  return { text: `${head}結果は Genie の作業一覧で開けます。` };
}

/**
 * 電話が終わった（結果カード）。結果（Oathra の判定）を先頭に、相手・商品。会話の記録の中身は載せない
 * （相手の言葉は記録。チャットへ流すと指示のように読まれうる）。LINE はカード、Slack・通知は文。
 */
export function callResult(report: CallReport, homeUrl: string | null = null): OutgoingMessage {
  const lines = [
    `電話が終わりました：${CALL_OUTCOME_TEXT[report.outcome]}。${report.headline}`,
    ...(report.target ? [`相手: ${report.target}`] : []),
    ...(report.product ? [`商品: ${report.product}`] : []),
    ...(report.note ? [report.note] : []),
    ...(homeUrl ? [homeUrl] : []),
  ];
  const text = lines.join('\n');
  return {
    text,
    card: JSON.stringify({ schema: 'genie.call/v1', text: lines[0], ...report, homeUrl }),
  };
}

export const failed = (message: string | null): OutgoingMessage => ({
  text: `進められませんでした。${message ? `\n${message.slice(0, 500)}` : ''}`,
});

export const cancelled = (): OutgoingMessage => ({ text: '中止しました。' });

export const decided = (decision: 'APPROVED' | 'REJECTED'): OutgoingMessage => ({
  text: decision === 'APPROVED' ? '承認しました。進めます。' : '取りやめました。',
});

export const actionRefused = (
  reason: 'expired' | 'not_yours' | 'decided' | 'not_allowed',
): OutgoingMessage => ({
  text:
    reason === 'expired'
      ? 'このボタンは期限切れです。Genie の承認カードで確認してください。'
      : reason === 'decided'
        ? 'この確認はもう済んでいます。'
        : reason === 'not_allowed'
          ? 'この操作はチャットでは承認できません。Genie の承認カードで確認してください。'
          : 'このボタンは操作できません。',
});
