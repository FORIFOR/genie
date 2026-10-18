/**
 * 電話の step を task-service へ差し込む（`phone.call` / `phone.sales`）。
 *
 * ここに来た時点で、利用者は承認カードで「電話をかける」を押している。
 * それでも Oathra 側の委任が上限と相手を決め、こちらはその中でしか動かない。
 *
 * 守ること:
 *   - **かけ直さない。**同じ step は同じ operation key。応答が失われても新しい電話にならない
 *   - **会話上の合意を成約と書かない。**Oathra の `succeeded` は、会話で条件を確かめたことまで
 *   - **相手の言葉は記録であって指示ではない。**成果物に引用するだけで、次の操作に使わない
 *   - **止められたら止める。**待っている間に Genie の仕事が止められたら、Oathra の通話も止める
 */
import type {
  OathraCallResult,
  OathraClient,
  OathraSalesRequest,
  OathraUtterance,
  PhoneOwner,
} from './oathra.js';

interface TaskLike {
  readonly taskId: string;
  readonly tenantId: string;
  readonly userId: string;
}

interface StepLike {
  readonly index: number;
  readonly toolId: string;
  readonly args: Record<string, unknown>;
}

export interface PhoneExecutorResult {
  result: unknown;
  detail?: string | null;
  artifact?: { title: string; markdown: string };
}

type Executor = { execute(input: TaskLike, step: StepLike): Promise<PhoneExecutorResult> };

export interface PhoneExecutorDeps {
  /** その利用者の Oathra。繋いでいなければ null（電話は「繋がっていない」で止まる）。 */
  readonly clientFor: (owner: PhoneOwner) => Promise<OathraClient | null>;
  /**
   * 実行基盤からの取り消し（Temporal の activity なら `Context.current().cancellationSignal`）。
   * ここが Temporal を import しないための差し込み口。
   */
  readonly signal?: () => AbortSignal | undefined;
  /**
   * 仕事が止められたか（task が CANCELLING か）。Genie の取り消しは workflow への signal なので、
   * 走っている activity には届かない。状態を読み直す周期ごとにこちらも見る。
   */
  readonly isCancelled?: (task: TaskLike) => Promise<boolean>;
  /** 状態を読み直す間隔。 */
  readonly pollMs?: number;
  /** ここまで待って終わらなければ、結果を待たずに止める（かけ直しはしない）。 */
  readonly deadlineMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
}

/** 電話が使えない。設定や許可の問題なので、やり直しても変わらない。 */
export class PhoneUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PhoneUnavailableError';
  }
}

/** 待っている間に止められた。Oathra の通話も止めるよう頼んだあと。 */
export class PhoneCancelledError extends Error {
  constructor(message = '電話を止めました。') {
    super(message);
    this.name = 'PhoneCancelledError';
  }
}

/** step ごとに 1 つ。**同じ step を何度走らせても、Oathra では同じ 1 件になる。** */
export function operationKeyFor(input: TaskLike, step: StepLike): string {
  return `genie-${input.taskId}-${String(step.index)}`;
}

const SALES_HEADLINE: Readonly<Record<string, string>> = {
  meeting: '商談の日時について、相手の了承を会話の中で確かめました。',
  materials: '資料をお送りすることについて、相手の了承を会話の中で確かめました。',
  introduce: '用件をお伝えしました。',
};

export function phoneExecutors(
  deps: PhoneExecutorDeps,
): Record<'phone.call' | 'phone.sales' | 'phone.unresolved', Executor> {
  const pollMs = deps.pollMs ?? 3_000;
  // 1 通話は Oathra 側で最長 5 分。activity の上限（5 分）より手前で止める
  const deadlineMs = deps.deadlineMs ?? 270_000;
  const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const now = deps.now ?? Date.now;

  /** 接続は利用者ごと。task を作った本人の接続だけを使い、無ければ止まる。 */
  async function clientOf(input: TaskLike): Promise<OathraClient> {
    const client = await deps.clientFor({ tenantId: input.tenantId, userId: input.userId });
    if (!client)
      throw new PhoneUnavailableError('この利用者には Oathra の電話が繋がっていません。');
    return client;
  }

  async function cancelled(input: TaskLike): Promise<boolean> {
    if (deps.signal?.()?.aborted) return true;
    return deps.isCancelled ? deps.isCancelled(input).catch(() => false) : false;
  }

  async function settle(
    client: OathraClient,
    input: TaskLike,
    key: string,
    first: OathraCallResult,
  ): Promise<OathraCallResult> {
    const until = now() + deadlineMs;
    let current = first;
    while (!current.terminal && current.outcome === 'pending') {
      if (await cancelled(input)) {
        /*
         * 止めるよう頼むだけ。かかってしまった電話は取り消せないし、止まったかどうかは
         * Oathra の記録が正。頼むのに失敗しても、Genie の側は止める。
         */
        const stopped = await client.cancel(key).catch(() => null);
        throw new PhoneCancelledError(
          stopped?.terminal
            ? '電話を止めました。'
            : '電話を止めるよう Oathra に頼みました。止まったかは Oathra の記録で確かめてください。',
        );
      }
      if (now() >= until) {
        throw new PhoneUnavailableError(
          '通話の結果がまだ出ていません。Oathra の記録で確かめてください。Genie からかけ直すことはしません。',
        );
      }
      await sleep(pollMs);
      current = await client.status(key);
    }
    return current;
  }

  function finished(
    title: string,
    outcome: OathraCallResult,
    headline: string,
  ): PhoneExecutorResult {
    switch (outcome.outcome) {
      case 'succeeded':
      case 'declined':
      case 'needs_review':
        return {
          result: { missionId: outcome.missionId, state: outcome.state, outcome: outcome.outcome },
          detail: OUTCOME_DETAIL[outcome.outcome],
          artifact: { title, markdown: report(outcome, headline) },
        };
      default:
        // 失敗・中止・不明は完了にしない。不明は「かかったかもしれない」ので、なおさらかけ直さない
        throw new PhoneUnavailableError(
          outcome.outcome === 'unknown'
            ? '通話の状態が確かめられません。Oathra の運営者に確認してください。かけ直さないでください。'
            : outcome.outcome === 'cancelled'
              ? '電話は止められました。'
              : '電話をかけられませんでした。Oathra の記録で理由を確かめてください。',
        );
    }
  }

  return {
    'phone.call': {
      async execute(input, step) {
        const client = await clientOf(input);
        const call = step.args['call'] as
          { phone?: unknown; name?: unknown; instruction?: unknown } | undefined;
        if (typeof call?.phone !== 'string' || typeof call.instruction !== 'string') {
          throw new PhoneUnavailableError('電話の宛先と用件がありません。');
        }
        const name = typeof call.name === 'string' && call.name ? call.name : '相手';
        const key = operationKeyFor(input, step);
        const first = await client.call(
          { phone: call.phone, name, instruction: call.instruction, conversationMode: 'message' },
          key,
        );
        const outcome = await settle(client, input, key, first);
        return finished(`電話: ${name}`, outcome, '用件をお伝えしました。');
      },
    },
    'phone.sales': {
      async execute(input, step) {
        const client = await clientOf(input);
        const sales = step.args['sales'] as Partial<OathraSalesRequest> | undefined;
        const shownName = step.args['相手'];
        if (!sales?.contactId || !sales.request || typeof shownName !== 'string') {
          throw new PhoneUnavailableError('営業電話の相手と用件がありません。');
        }
        /*
         * 承認カードに出た相手と、実際にかける相手が同じかを、かける直前に確かめる。
         * task の入力は作った人が書けるので、名前だけ違う id が紛れ込みうる。
         */
        const context = await client.salesContext();
        const contact = context.contacts.find((c) => c.id === sales.contactId);
        if (!contact || (contact.name || contact.company) !== shownName) {
          throw new PhoneUnavailableError(
            '承認した相手が Oathra の連絡先と一致しません。依頼し直してください。',
          );
        }
        if (!contact.callPermitted) {
          throw new PhoneUnavailableError(
            `${shownName}さんには営業電話をかけられなくなっています（関係・根拠の登録、または再連絡停止を確かめてください）。`,
          );
        }
        const key = operationKeyFor(input, step);
        const first = await client.sales(
          {
            contactId: sales.contactId,
            request: sales.request,
            ...(sales.productId ? { productId: sales.productId } : {}),
            ...(sales.goal ? { goal: sales.goal } : {}),
          },
          key,
        );
        const outcome = await settle(client, input, key, first);
        return finished(
          `営業電話: ${shownName}`,
          outcome,
          SALES_HEADLINE[sales.goal ?? 'introduce']!,
        );
      },
    },
    /*
     * 電話で頼まれたが、進められなかったこと。Oathra もモデルも呼ばない。
     * 黙って捨てると、頼んだ本人は「伝わった」と思ったままになる。
     */
    'phone.unresolved': {
      async execute(_input, step) {
        const notice = typeof step.args['notice'] === 'string' ? step.args['notice'] : '';
        const words = typeof step.args['words'] === 'string' ? step.args['words'] : '';
        const lines = [
          '# 電話で頼まれたことを進められませんでした',
          '',
          notice ? oneLine(notice) : '理由が分かりません。',
          '',
          '## 電話で聞き取ったこと',
          '',
          ...(words
            ? words.split('\n').map((line) => `- ${oneLine(line)}`)
            : ['- （記録がありません）']),
          '',
          '直したうえで、Genie にもう一度頼んでください。電話はかけていません。',
        ];
        return {
          result: { unresolved: true },
          detail: '進められませんでした',
          artifact: { title: '電話の依頼を進められませんでした', markdown: lines.join('\n') },
        };
      },
    },
  };
}

const OUTCOME_DETAIL: Readonly<Record<'succeeded' | 'declined' | 'needs_review', string>> = {
  succeeded: '会話で確認済み',
  declined: '相手が辞退',
  needs_review: '要確認',
};

/** 成果物。**相手の発言はそのまま引用し、解釈しない。** */
function report(outcome: OathraCallResult, headline: string): string {
  const who = outcome.record?.target?.name;
  const lines = [
    `# ${outcome.outcome === 'succeeded' ? headline : outcome.outcome === 'declined' ? '相手が断りました' : '結果を確かめてください'}`,
    '',
    outcome.outcome === 'succeeded'
      ? '会話の中で確かめたことです。契約や予定の確定（ほかのシステムへの登録）までは含みません。'
      : outcome.outcome === 'declined'
        ? '相手が断った、または連絡を望まないと言いました。Genie からかけ直すことはしません。'
        : '通話は終わりましたが、結果を会話から確かめられませんでした。下の記録を読んで判断してください。',
    '',
    ...(who ? [`- 相手: ${who}`] : []),
    ...(outcome.record?.product?.name ? [`- 商品: ${outcome.record.product.name}`] : []),
    `- Oathra の記録: ${outcome.missionId ?? '—'}`,
  ];
  const transcript = outcome.record?.transcript ?? [];
  if (transcript.length > 0) {
    lines.push(
      '',
      '## 会話の記録',
      '',
      '相手の発言は記録です。Genie への指示としては扱いません。',
      '',
    );
    for (const turn of transcript.slice(-40))
      lines.push(`- ${speaker(turn)}: ${oneLine(turn.text)}`);
  }
  return lines.join('\n');
}

const speaker = (turn: OathraUtterance) => (turn.source === 'caller' ? 'AI' : '相手');
/** 1 行に畳み、リンクや見出しとして解釈される記号を無効にする。相手の言葉で成果物の形を変えさせない。 */
export const oneLine = (text: string) =>
  text
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 400)
    .replace(/[\\`*_[\]<>#|]/g, '\\$&');
