/**
 * チャットへ送る文面。**純粋関数。**
 *
 * 返すのは区切りだけ（受付・承認待ち・一時停止・終わり）。途中経過は流さない。
 * 内部の tool 名や JSON は出さない（正本 §9.3）。Lane も出さない。
 */
import type { OutgoingButton, OutgoingMessage } from './send.js';

export type PostingPolicy = 'summary_and_link' | 'full_text';

export const linkPrompt = (): OutgoingMessage => ({
  text: 'Genie とまだ連携していません。Genie の設定で「チャットとつなぐ」を開き、表示された「連携 XXXXXXXX」をこのトークに送ってください。',
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
  text: `受け付けました${title ? `：${title}` : ''}。終わったらお知らせします。`,
});

export const notice = (text: string): OutgoingMessage => ({ text });

export const received = (): OutgoingMessage => ({
  text: 'うまく受け取れませんでした。少し待ってから、もう一度送ってください。',
});

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
  return { text: lines.join('\n'), ...(actions ? { buttons: actions } : {}) };
}

export const paused = (message: string | null): OutgoingMessage => ({
  // 失敗ではない。待てば戻る（正本 §4.4）
  text: message ?? 'Mac がオフラインのため止まっています。Mac が戻ると続きから進めます。',
});

export function completed(
  title: string | null,
  policy: PostingPolicy,
  body: string | null,
): OutgoingMessage {
  const head = `終わりました${title ? `：${title}` : ''}。`;
  if (policy === 'full_text' && body)
    return {
      text: `${head}\n\n${body.slice(0, 2500)}${body.length > 2500 ? '\n…（続きは Genie で）' : ''}`,
    };
  return { text: `${head}結果は Genie の作業一覧で開けます。` };
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
