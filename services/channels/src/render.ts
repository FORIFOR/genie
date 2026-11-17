/**
 * チャットへ送る文面。**純粋関数。**
 *
 * 返すのは区切りだけ（受付・承認待ち・一時停止・終わり）。途中経過は流さない。
 * 内部の tool 名や JSON は出さない（正本 §9.3）。Lane も出さない。
 */
import { CALL_OUTCOME_TEXT, type CallReport } from '@genie/contracts';
import type { OutgoingButton, OutgoingMessage, QuickReply } from './send.js';

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

export const notice = (text: string, quickReplies?: readonly QuickReply[]): OutgoingMessage => ({
  text,
  ...(quickReplies?.length ? { quickReplies } : {}),
});

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

/** Claude Code の承認（gateway の agent-approvals.ts の写し。秘密は向こうで伏せてある）。取れないものは null。 */
export interface AgentApprovalCardView {
  readonly number: string;
  readonly agent: string;
  readonly project: string | null;
  readonly branch: string | null;
  readonly workdir: string | null;
  readonly task: string | null;
  readonly genieTask: string | null;
  readonly tool: string;
  readonly summary: string;
  readonly details: readonly { readonly label: string; readonly value: string }[];
  readonly operation: string;
  readonly risk: 'low' | 'medium' | 'high';
  readonly ruleable: boolean;
  readonly notRuleableReason: string | null;
  readonly expiresAt: Date;
  /** Claude Code の質問なら、いま答えてほしい 1 問。承認なら null。 */
  readonly question?: AgentQuestionView | null;
}

/** Claude Code の質問 1 問（gateway の QuestionView の写し。秘密は向こうで伏せてある）。 */
export interface AgentQuestionView {
  readonly index: number;
  readonly total: number;
  readonly header: string | null;
  readonly text: string;
  readonly options: readonly { readonly label: string; readonly description: string | null }[];
  readonly multiSelect: boolean;
}

const RISK_TEXT = { low: '低', medium: '中', high: '高' } as const;

/**
 * 「Claude Code が承認を待っています」のカード。何のプロジェクトの・何の作業の・何の操作か・リスク・期限。
 * ボタン: 今回だけ承認・拒否・指示を添える と、継続許可にしてよい操作なら このセッション / このプロジェクトで同種を許可。
 */
export function agentApproval(
  view: AgentApprovalCardView,
  buttons: {
    allow: string;
    deny: string;
    instruct: string;
    allowSession: string | null;
    allowProject: string | null;
  },
  timeZone: string,
): OutgoingMessage {
  const until = view.expiresAt.toLocaleTimeString('ja-JP', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone,
  });
  const summary = `${view.agent}が承認を待っています（#${view.number}）：${view.summary}`;
  const context = [
    {
      label: 'プロジェクト',
      value: view.project ? `${view.project}${view.branch ? `（${view.branch}）` : ''}` : '未確認',
    },
    { label: '作業', value: view.task ?? '未確認' },
    { label: 'タスク', value: view.genieTask ?? 'タスク未紐付け' },
    { label: '実行する場所', value: view.workdir ?? '未確認' },
    { label: '操作の種類', value: view.operation },
    {
      label: 'リスク',
      value: `${RISK_TEXT[view.risk]}${view.ruleable ? '' : `（毎回確認: ${view.notRuleableReason ?? '継続許可の対象外'}）`}`,
    },
  ];
  const details = [...context, ...view.details].slice(0, 9);
  const note = `${until} まで。押すまで実行しません。Mac で答えても構いません。${
    view.ruleable
      ? '「同種を許可」は、この種類の操作を次から確認なしで進めます（「承認ルール」で一覧・取り消し）。'
      : ''
  }`;
  return {
    text: [summary, ...details.map((d) => `・${d.label}：${d.value.slice(0, 200)}`), '', note].join(
      '\n',
    ),
    buttons: [
      { label: '今回だけ承認', value: buttons.allow, style: 'primary' },
      { label: '拒否', value: buttons.deny, style: 'danger' },
      { label: '指示を添える', value: buttons.instruct },
      ...(buttons.allowSession
        ? [{ label: 'このセッションで同種を許可', value: buttons.allowSession }]
        : []),
      ...(buttons.allowProject
        ? [{ label: 'このプロジェクトで常に許可', value: buttons.allowProject }]
        : []),
    ],
    approval: {
      summary,
      details: details.map((d) => ({ label: d.label, value: d.value })),
      note,
    },
  };
}

/**
 * 「Claude Code が質問しています」のカード。選択肢をそのままボタンにする（押すと、その選択肢を答えとして返す）。
 * ほかに「文で答える」（次の文を答えにする）と「答えない」。何問かあれば 1 問ずつ送る。
 */
export function agentQuestion(
  view: AgentApprovalCardView,
  question: AgentQuestionView,
  buttons: { options: readonly string[]; text: string; skip: string },
  timeZone: string,
): OutgoingMessage {
  const until = view.expiresAt.toLocaleTimeString('ja-JP', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone,
  });
  const count =
    question.total > 1 ? `（${String(question.index + 1)}/${String(question.total)} 問目）` : '';
  const summary = `${view.agent}が質問しています（#${view.number}）${count}：${question.header ?? question.text.slice(0, 40)}`;
  const details = [
    {
      label: 'プロジェクト',
      value: view.project ? `${view.project}${view.branch ? `（${view.branch}）` : ''}` : '未確認',
    },
    { label: '作業', value: view.task ?? '未確認' },
    { label: '質問', value: question.text },
    ...question.options.map((o, i) => ({
      label: String(i + 1),
      value: o.description && o.description !== o.label ? `${o.label} — ${o.description}` : o.label,
    })),
  ];
  const note = `${until} まで。ボタンを押すと、その答えを Claude Code に返します。${
    question.multiSelect
      ? '複数選ぶときは「文で答える」で「A、B」のように送ってください。'
      : '選択肢にないときは「文で答える」。'
  }Mac で答えても構いません。`;
  return {
    text: [summary, ...details.map((d) => `・${d.label}：${d.value.slice(0, 200)}`), '', note].join(
      '\n',
    ),
    buttons: [
      ...question.options.map((o, i) => ({
        label: `${String(i + 1)}. ${o.label}`,
        value: buttons.options[i]!,
        ...(i === 0 ? { style: 'primary' as const } : {}),
      })),
      { label: '文で答える', value: buttons.text },
      { label: '答えない', value: buttons.skip, style: 'danger' as const },
    ],
    approval: {
      summary,
      details: details.map((d) => ({ label: d.label, value: d.value })),
      note,
    },
  };
}

/** Claude Code の承認のボタンを押したあとの返事。送っただけで「実行した」とは言わない。 */
export const agentApprovalAnswered = (
  result:
    | 'allowed'
    | 'allowed_session'
    | 'allowed_project'
    | 'denied'
    | 'awaiting_instruction'
    | 'awaiting_text'
    | 'answered'
    | 'next_question'
    | 'skipped'
    | 'instructed'
    | 'not_ruleable'
    | 'answered_on_mac'
    | 'expired'
    | 'gone'
    | 'not_yours',
): OutgoingMessage => ({
  text: {
    allowed: '承認を受け付けました。Claude Code に渡します（実行を確かめたら知らせます）。',
    allowed_session:
      '承認を受け付けました。このセッションの間、同じ種類の操作は確認なしで進めます（実行を確かめたら知らせます）。',
    allowed_project:
      '承認を受け付けました。このプロジェクトでは、同じ種類の操作を次から確認なしで進めます。「承認ルール」で一覧・取り消しができます。',
    denied: '拒否しました。Claude Code は実行せずに続けます。',
    awaiting_instruction:
      '指示を送ってください（次のメッセージを Claude Code に渡します。5 分以内）。この操作は実行しません。',
    awaiting_text:
      '答えを文で送ってください（次のメッセージをそのまま Claude Code への答えにします。5 分以内）。',
    answered: '答えを Claude Code に渡しました。',
    next_question: '答えを受け付けました。続きの質問にも答えてください。',
    skipped: '答えずに返しました。Claude Code には「答えない」と伝えます。',
    instructed: '指示を Claude Code に渡しました。この操作は実行せず、指示に沿って続けます。',
    not_ruleable:
      'この操作は継続許可にできません（毎回確認します）。今回だけ承認するか、拒否してください。',
    answered_on_mac: 'この確認は Mac で答え済みです。',
    expired: 'この確認は期限切れです。Mac の画面で答えてください。',
    gone: 'この確認はもう済んでいます。',
    not_yours: 'このボタンは操作できません。',
  }[result],
});
