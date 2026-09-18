/**
 * タスクの計画。**純粋関数のみ**。
 *
 * ワークフローのコードは決定的でなければならないので、このファイルは
 * 乱数・時刻・I/O・Node の API に触れない。`@genie/contracts` も import しない
 * （uuidv7 が Web Crypto を触るため、ワークフローのサンドボックスに持ち込めない）。
 */

export type StepRisk =
  'READ' | 'REVERSIBLE_WRITE' | 'EXTERNAL_COMMIT' | 'DESTRUCTIVE' | 'REGULATED' | 'FINANCIAL';

/** 応答が失われても外部では完了している可能性がある操作は自動再実行しない。 */
export function requiresSingleAttempt(step: { readonly risk: StepRisk }): boolean {
  return step.risk !== 'READ' && step.risk !== 'REVERSIBLE_WRITE';
}

/** Generative work can be billed even when its response is lost. */
export function isMeteredStep(step: { readonly toolId: string }): boolean {
  return (
    step.toolId.startsWith('llm.') ||
    step.toolId.startsWith('research.') ||
    // A video artifact can be deleted locally, but the provider's generation
    // charge cannot be undone. An ambiguous timeout must not submit a new job.
    [
      'search.web',
      'general.answer',
      'general.compose',
      'meeting.transcribe',
      'meeting.summarize',
      'meeting.bundle',
      'video.render',
    ].includes(step.toolId)
  );
}

/** Carry the durable summary activity result into rendering; don't ask the LLM twice. */
export function withMeetingSummary(
  step: TaskStep,
  steps: readonly TaskStep[],
  results: readonly unknown[],
): TaskStep {
  if (step.toolId !== 'meeting.bundle') return step;
  const index = steps.findIndex((s) => s.index < step.index && s.toolId === 'meeting.summarize');
  if (index < 0 || results[index] === undefined) return step;
  return { ...step, args: { ...step.args, summary_result: results[index] } };
}

/** contracts の ComplianceProfile と同じ値。ここは import できない（冒頭の注意）。 */
export type StepComplianceProfile =
  'GENERAL' | 'ENTERPRISE' | 'REGULATED_HEALTH' | 'CARE' | 'FINANCIAL';

export interface TaskStep {
  readonly index: number;
  readonly toolId: string;
  readonly risk: StepRisk;
  readonly surface: 'local' | 'cloud';
  /** ユーザーに見せる自然文。tool 名を出さない（正本 §7.2 / §9.3）。 */
  readonly message: string;
  readonly args: Record<string, unknown>;
  /**
   * manifest の `requires_confirmation`。
   * **低リスクでも作者が確認を要求できる**（正本 §9.2）。
   * ここを運ばないと、宣言が検証されるだけで効かなくなる。
   */
  readonly requiresConfirmation?: boolean;
  /**
   * どの規制区分で実行されるか（正本 §22）。
   * 省略は `GENERAL`。**規制区分を運ばないと、規制の意味が無くなる。**
   */
  readonly complianceProfile?: StepComplianceProfile;
  /**
   * plugin が持ち込んだ規則（正本 §22）。
   * 中身は `@genie/contracts` の `PolicyDocument` だが、
   * このファイルは contracts を import できない（冒頭の注意）。
   */
  readonly policies?: readonly unknown[];
  /**
   * 落ちたときに代わりに試す tool（正本 §24）。
   * **同じ plugin の宣言済み tool だけ。**
   */
  readonly fallbacks?: readonly string[];
}

export interface TaskPlan {
  readonly steps: readonly TaskStep[];
  readonly artifact: {
    /** contracts の ArtifactType の部分集合。ここは import できない（冒頭の注意）。 */
    readonly type: 'REPORT' | 'DOCUMENT' | 'MEETING_BUNDLE' | 'OTHER';
    readonly title: string;
    readonly mimeType: string;
    readonly sourceMeetingId?: string;
  };
}

export const KNOWN_TASK_KINDS = [
  'echo',
  'research',
  'meeting.finalize',
  'mail.send',
  'computer.action',
  'computer.run',
] as const;
export type TaskKind = (typeof KNOWN_TASK_KINDS)[number];

export function isKnownTaskKind(kind: string): kind is TaskKind {
  return (KNOWN_TASK_KINDS as readonly string[]).includes(kind);
}

export class UnknownTaskKindError extends Error {
  constructor(kind: string) {
    super(`unknown task kind: ${kind}`);
    this.name = 'UnknownTaskKindError';
  }
}

const MAX_ECHO_STEPS = 20;

/**
 * Phase 0 の唯一の種別。API → workflow → イベント列 → object store → artifact の
 * 全経路を通すためだけのもの（実装仕様 §6.6）。
 */
function planEcho(input: Record<string, unknown>): TaskPlan {
  const message = typeof input['message'] === 'string' ? input['message'] : 'hello';
  const requested = typeof input['steps'] === 'number' ? Math.floor(input['steps']) : 1;
  const count = Math.min(Math.max(requested, 1), MAX_ECHO_STEPS);
  const requiresApproval = input['require_approval'] === true;

  const steps: TaskStep[] = [];
  for (let i = 0; i < count; i += 1) {
    steps.push({
      index: i,
      toolId: 'noop.echo',
      risk: 'READ',
      surface: 'cloud',
      message: `処理しています (${i + 1}/${count})`,
      args: { message, step: i },
    });
  }

  if (requiresApproval) {
    // 承認経路を通すための段。policy 側が EXTERNAL_COMMIT を承認必須と判定する。
    steps.push({
      index: count,
      toolId: 'noop.commit',
      risk: 'EXTERNAL_COMMIT',
      surface: 'cloud',
      message: '結果を確定します',
      args: { message },
    });
  }

  return {
    steps,
    artifact: {
      type: 'DOCUMENT',
      title: typeof input['title'] === 'string' ? input['title'] : 'Echo result',
      mimeType: 'text/markdown',
    },
  };
}

/**
 * Research。正本 §8.1 の流れを、UI/UX §13.1 が見せる 4 つの工程にまとめる。
 *
 * 工程は 4 つで固定なので**進捗率は本物**になる。
 * 各工程の中身（検索件数）は事前に決まらないので、それは detail 側で示す（§6.2）。
 */
function planResearch(input: Record<string, unknown>): TaskPlan {
  const question =
    typeof input['question'] === 'string' && input['question'].trim().length > 0
      ? input['question'].trim()
      : typeof input['message'] === 'string'
        ? input['message'].trim()
        : '';

  const steps: TaskStep[] = [
    {
      index: 0,
      toolId: 'research.plan',
      risk: 'READ',
      surface: 'cloud',
      message: '調べることを整理しています',
      args: { question },
    },
    {
      index: 1,
      toolId: 'research.search',
      risk: 'READ',
      surface: 'cloud',
      message: '公式資料と最新ニュースを照合中',
      args: { question },
    },
    {
      index: 2,
      toolId: 'research.verify',
      risk: 'READ',
      surface: 'cloud',
      message: '食い違いを確認しています',
      args: { question },
    },
    {
      index: 3,
      toolId: 'research.report',
      risk: 'READ',
      surface: 'cloud',
      message: 'レポートを作成しています',
      args: { question },
    },
  ];

  return {
    steps,
    artifact: { type: 'REPORT', title: question || '調査レポート', mimeType: 'text/markdown' },
  };
}

/**
 * 会議の finalize。正本 §11.2 Final Accuracy Path、Phase 3 実装仕様 §5。
 *
 * UI/UX §12.5「Finalize 中に window を閉じても継続」は、これを durable task に
 * することで満たす。会議のために別の仕組みを作らない（D-28）。
 */
function planMeetingFinalize(input: Record<string, unknown>): TaskPlan {
  const meetingId = typeof input['meeting_id'] === 'string' ? input['meeting_id'] : '';
  const title = typeof input['title'] === 'string' ? input['title'] : '会議';
  const args = { meeting_id: meetingId };

  const steps: TaskStep[] = [
    {
      index: 0,
      toolId: 'meeting.seal',
      risk: 'READ',
      surface: 'cloud',
      message: '録音を保存しています',
      args,
    },
    {
      index: 1,
      toolId: 'meeting.transcribe',
      risk: 'READ',
      surface: 'cloud',
      message: '高精度の文字起こしを作成中',
      args,
    },
    {
      index: 2,
      toolId: 'meeting.reconcile',
      risk: 'READ',
      surface: 'cloud',
      message: '話者を突き合わせています',
      args,
    },
    {
      index: 3,
      toolId: 'meeting.summarize',
      risk: 'READ',
      surface: 'cloud',
      message: '要点・決定事項・ToDo をまとめています',
      args,
    },
    {
      index: 4,
      toolId: 'meeting.bundle',
      risk: 'READ',
      surface: 'cloud',
      message: '議事録を保存しています',
      args,
    },
  ];

  return {
    steps,
    artifact: {
      type: 'MEETING_BUNDLE',
      title,
      mimeType: 'text/markdown',
      sourceMeetingId: meetingId,
    },
  };
}

/**
 * 返信を送る（「これ返して」の最後の 1 段）。正本 §9.2、Work Context 仕様 REPLY_IN_CONTEXT。
 *
 * 1 段だけ。**外へ出る操作なので承認が要り、端末の送る接続（gmail-actions）でしか動かない。**
 * 本文は本人が確認カードで見た（直した）もの。ここで作文しない。
 */
function planMailSend(input: Record<string, unknown>): TaskPlan {
  const to = Array.isArray(input['to'])
    ? input['to'].filter((v): v is string => typeof v === 'string')
    : [];
  const subject = typeof input['subject'] === 'string' ? input['subject'] : '';
  const body = typeof input['body'] === 'string' ? input['body'] : '';
  if (to.length === 0 || !subject || !body) {
    throw new UnknownTaskKindError('mail.send needs to, subject and body');
  }
  const source = typeof input['source'] === 'string' ? input['source'] : 'gmail';
  const inReplyTo = typeof input['in_reply_to'] === 'string' ? input['in_reply_to'] : null;
  if (source === 'outlook_mail') {
    // Outlook は既存メッセージへの返信（Graph の message: reply）。相手のメッセージ id が要る。
    if (!inReplyTo)
      throw new UnknownTaskKindError('outlook reply needs the message id to reply to');
    return {
      steps: [
        {
          index: 0,
          toolId: 'outlook.mail.reply',
          risk: 'EXTERNAL_COMMIT',
          surface: 'local',
          requiresConfirmation: true,
          message: `${to.join(', ')} に返信を送ります`,
          args: { message_id: inReplyTo, comment: body, to, subject, count: to.length },
        },
      ],
      artifact: { type: 'DOCUMENT', title: `返信: ${subject}`, mimeType: 'text/markdown' },
    };
  }
  return {
    steps: [
      {
        index: 0,
        toolId: 'mail.send',
        risk: 'EXTERNAL_COMMIT',
        surface: 'local',
        requiresConfirmation: true,
        message: `${to.join(', ')} に返信を送ります`,
        args: {
          to,
          subject,
          body,
          count: to.length,
          ...(typeof input['thread_id'] === 'string'
            ? { thread_id: input['thread_id'].replace(/^gmail:/, '') }
            : {}),
          ...(typeof input['in_reply_to'] === 'string'
            ? { in_reply_to: input['in_reply_to'] }
            : {}),
        },
      },
    ],
    artifact: { type: 'DOCUMENT', title: `返信: ${subject}`, mimeType: 'text/markdown' },
  };
}

function planComputerRun(input: Record<string, unknown>): TaskPlan {
  const goal = typeof input['goal'] === 'string' ? input['goal'].trim() : '';
  if (!goal) throw new UnknownTaskKindError('computer.run needs a goal');
  return {
    steps: [
      {
        index: 0,
        toolId: 'computer.run',
        risk: 'REVERSIBLE_WRITE',
        surface: 'local',
        requiresConfirmation: true,
        message: '画面を確認しながら操作します',
        args: { goal },
      },
    ],
    artifact: {
      type: 'OTHER',
      title: typeof input['title'] === 'string' ? input['title'] : goal,
      mimeType: 'application/json',
    },
  };
}

function planComputerAction(input: Record<string, unknown>): TaskPlan {
  const action = typeof input['action'] === 'string' ? input['action'] : '';
  const allowed = ['observe', 'click', 'type', 'key'] as const;
  if (!(allowed as readonly string[]).includes(action))
    throw new UnknownTaskKindError('computer.action needs observe, click, type, or key');
  const mutating = action !== 'observe';
  const args = Object.fromEntries(
    Object.entries(input).filter(([key]) => !['action', 'title'].includes(key)),
  );
  return {
    steps: [
      {
        index: 0,
        toolId: `computer.${action}`,
        risk: mutating ? 'REVERSIBLE_WRITE' : 'READ',
        surface: 'local',
        requiresConfirmation: mutating,
        message: mutating ? '画面を操作します' : '現在の画面を確認します',
        args,
      },
    ],
    artifact: {
      type: 'OTHER',
      title: typeof input['title'] === 'string' ? input['title'] : 'Computer action',
      mimeType: 'application/json',
    },
  };
}

export function planTask(kind: string, input: Record<string, unknown>): TaskPlan {
  switch (kind) {
    case 'echo':
      return planEcho(input);
    case 'research':
      return planResearch(input);
    case 'meeting.finalize':
      return planMeetingFinalize(input);
    case 'mail.send':
      return planMailSend(input);
    case 'computer.action':
      return planComputerAction(input);
    case 'computer.run':
      return planComputerRun(input);
    default:
      throw new UnknownTaskKindError(kind);
  }
}

export interface ApprovalCard {
  readonly summary: string;
  readonly details: { label: string; value: string }[];
  readonly impact: {
    readonly primary_action_label: string;
    readonly affected_count: number | null;
    readonly scope: 'internal' | 'external';
    readonly reversible: boolean;
    readonly recovery_note: string | null;
  };
}

/**
 * 承認カードに出す内容。tool 名や JSON を含めない（正本 §9.3）。
 *
 * 主ボタンの文言は「承認」ではなく**結果**を書く（UI/UX §14.1）。
 * クライアント側で組み立てられるようにサーバが影響範囲を持つ。
 */
export function approvalSummaryFor(step: TaskStep): ApprovalCard {
  const external =
    step.risk === 'EXTERNAL_COMMIT' ||
    step.risk === 'DESTRUCTIVE' ||
    step.risk === 'REGULATED' ||
    step.risk === 'FINANCIAL';
  const count = typeof step.args['count'] === 'number' ? step.args['count'] : null;

  return {
    summary: step.message,
    details: Object.entries(step.args)
      .filter(([, v]) => typeof v === 'string' || typeof v === 'number')
      .slice(0, 10)
      .map(([label, value]) => ({ label, value: String(value) })),
    impact: {
      primary_action_label: primaryActionLabel(step, count),
      affected_count: count,
      scope: external ? 'external' : 'internal',
      reversible: step.risk === 'REVERSIBLE_WRITE',
      recovery_note: step.risk === 'REVERSIBLE_WRITE' ? '実行後に取り消せます' : null,
    },
  };
}

function primaryActionLabel(step: TaskStep, count: number | null): string {
  const suffix = count === null ? '' : `${count}件`;
  switch (step.risk) {
    case 'DESTRUCTIVE':
      return suffix ? `${suffix}削除する` : '削除する';
    case 'FINANCIAL':
      return '注文を確定する';
    case 'REGULATED':
      return '記録を更新する';
    case 'EXTERNAL_COMMIT':
      return suffix ? `${suffix}実行する` : '実行する';
    default:
      return '実行する';
  }
}
