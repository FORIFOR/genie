/**
 * 言語モデルを、端末で動かす。正本 §4.4・§16.1・§21、UI/UX §22。
 *
 * **Genie は共通の API キーを持たない。**利用者が持ち込んだ利用権
 * （Claude Code のログイン、あるいは自分の API キー）は端末の側にあるので、
 * 呼ぶのも端末になる。cloud は「これを聞いてほしい」を置いて待つだけ。
 *
 * ここが守ること:
 *
 *   - **端末が居なければ、運営側のモデルへ乗り換えない。**待つ。
 *     乗り換えると、利用者が選んだ経路と料金の外で処理が走る
 *   - 1 つの step から何度も呼ぶので、**呼び出しごとに鍵を作る。**
 *     鍵が同じなら結果を使い回し、違えば別の依頼になる
 *   - モデルの出力を信用しない。**形が違えば捨てる**
 */
import { canonicalSha256 } from '@genie/contracts';
import { groundedFindings } from './anthropic.js';
import type {
  ExtractedClaim,
  Finding,
  LanguageModel,
  SearchHit,
  VisualAttachment,
} from './providers.js';

/** 端末への受け渡し口。`@genie/service-agent-host` の `HostStepExecutor` が満たす。 */
export interface HostCall {
  execute(
    input: { taskId: string; tenantId: string; userId: string },
    step: { index: number; toolId: string; args: Record<string, unknown>; requestKey: string },
  ): Promise<{ result: unknown }>;
}

/** どの仕事の一部として呼ぶか。受け渡しは仕事に紐づく。 */
export interface HostModelContext {
  readonly taskId: string;
  readonly tenantId: string;
  readonly userId: string;
  readonly stepIndex: number;
}

export interface HostLanguageModelDeps {
  readonly host: HostCall;
  /** いまどの仕事の中に居るか。**無ければ呼べない。** */
  readonly context: () => HostModelContext | null;
  /** 端末で使うモデルの呼び名。capability report に出す。 */
  readonly implementation?: string;
}

export class HostLanguageModel implements LanguageModel {
  readonly name: string;
  /**
   * 代役ではない。**本物のモデルを、端末で呼んでいる。**
   *
   * 端末が居ないときに代役へ落ちるのではなく、止まる。
   * だからここを true にすると、事実と合わない。
   */
  readonly isStandIn = false;

  readonly #deps: HostLanguageModelDeps;

  constructor(deps: HostLanguageModelDeps) {
    this.#deps = deps;
    this.name = deps.implementation ?? 'device';
  }

  async decompose(question: string, max: number): Promise<string[]> {
    const result = await this.#ask('llm.decompose', { question, max });
    return stringsOf(result, 'queries').slice(0, max);
  }

  async extractClaims(question: string, hit: SearchHit): Promise<ExtractedClaim[]> {
    const result = await this.#ask('llm.extract_claims', {
      question,
      snippet: hit.snippet,
      title: hit.title,
      url: hit.url,
    });
    const raw = Array.isArray((result as { claims?: unknown })?.claims)
      ? (result as { claims: unknown[] }).claims
      : [];

    return raw
      .map((item) => ({
        claim: stringOf(item, 'claim'),
        supportText: stringOf(item, 'supportText'),
      }))
      .filter(
        (item) =>
          item.claim.length > 0 &&
          item.supportText.length > 0 &&
          /*
           * **根拠は抜粋の中に実在する文字列でなければ捨てる。**
           * ここを緩めると、Evidence Ledger に
           * 「もっともらしいが原文に無い」根拠が積まれる。
           */
          hit.snippet.includes(item.supportText),
      );
  }

  async synthesize(question: string, claims: readonly string[]): Promise<Finding[]> {
    const result = await this.#ask('llm.synthesize', { question, claims: [...claims] });
    const raw = Array.isArray((result as { findings?: unknown })?.findings)
      ? (result as { findings: unknown[] }).findings
      : [];

    return groundedFindings(
      raw.map((item) => ({
        text: stringOf(item, 'text'),
        supports: Array.isArray((item as { supports?: unknown })?.supports)
          ? (item as { supports: unknown[] }).supports.filter(
              (n): n is number => typeof n === 'number',
            )
          : [],
      })),
      claims.length,
    );
  }

  async followUp(question: string, claims: readonly string[], max: number): Promise<string[]> {
    const result = await this.#ask('llm.follow_up', { question, claims: [...claims], max });
    return stringsOf(result, 'queries').slice(0, max);
  }

  async assess(question: string, claims: readonly string[]): Promise<Finding[]> {
    const result = await this.#ask('llm.assess', { question, claims: [...claims] });
    const raw = Array.isArray((result as { assessments?: unknown })?.assessments)
      ? (result as { assessments: unknown[] }).assessments
      : [];
    return groundedFindings(
      raw.map((item) => ({
        text: stringOf(item, 'text'),
        supports: Array.isArray((item as { supports?: unknown })?.supports)
          ? (item as { supports: unknown[] }).supports.filter(
              (n): n is number => typeof n === 'number',
            )
          : [],
      })),
      claims.length,
    );
  }

  async answer(
    question: string,
    context?: string,
    attachments?: readonly VisualAttachment[],
  ): Promise<string> {
    const result = await this.#ask('llm.answer', {
      question,
      ...(context ? { context } : {}),
      // 画像は id で渡す。端末が `visual-context/<id>.png` を読む。画素は cloud を通らない。
      ...(attachments && attachments.length > 0
        ? { images: attachments.map((a) => ({ id: a.id, kind: a.kind, label: a.label })) }
        : {}),
    });
    return textOf(result, 'answer');
  }

  async compose(
    instruction: string,
    context?: string,
    attachments?: readonly VisualAttachment[],
  ): Promise<string> {
    const result = await this.#ask('llm.compose', {
      instruction,
      ...(context ? { context } : {}),
      ...(attachments && attachments.length > 0
        ? { images: attachments.map((a) => ({ id: a.id, kind: a.kind, label: a.label })) }
        : {}),
    });
    return textOf(result, 'text');
  }

  async detectContradictions(
    claims: readonly string[],
  ): Promise<{ left: number; right: number }[]> {
    const result = await this.#ask('llm.contradictions', { claims: [...claims] });
    const raw = Array.isArray((result as { pairs?: unknown })?.pairs)
      ? (result as { pairs: unknown[] }).pairs
      : [];
    return raw
      .map((item) => ({
        left: numberOf(item, 'left'),
        right: numberOf(item, 'right'),
      }))
      .filter(
        (pair) =>
          // 範囲の外を指す組は捨てる。存在しない主張の矛盾は矛盾ではない。
          Number.isInteger(pair.left) &&
          Number.isInteger(pair.right) &&
          pair.left >= 0 &&
          pair.right >= 0 &&
          pair.left < claims.length &&
          pair.right < claims.length &&
          pair.left !== pair.right,
      );
  }

  async #ask(toolId: string, args: Record<string, unknown>): Promise<unknown> {
    const context = this.#deps.context();
    if (context === null) {
      /*
       * 仕事の外から呼ばれた。**代役で答えない。**
       * ここで何かを返すと、どの利用権で処理したのか説明できなくなる。
       */
      throw new Error('a model call needs a task to belong to');
    }

    const { result } = await this.#deps.host.execute(
      { taskId: context.taskId, tenantId: context.tenantId, userId: context.userId },
      {
        index: context.stepIndex,
        toolId,
        args,
        // 同じ問いなら結果を使い回す。違う問いは別の依頼になる。
        requestKey: await canonicalSha256({ toolId, args }),
      },
    );
    return result;
  }
}

function stringsOf(result: unknown, key: string): string[] {
  const value = (result as Record<string, unknown> | null)?.[key];
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === 'string' && v.trim().length > 0);
}

/**
 * 文章を取り出す。**形が違えば空ではなく失敗にする。**
 *
 * 空文字を返すと、画面には「答えはありません」と出る。
 * 読み取れなかったのと、答えが無いのは別のこと。
 */
function textOf(result: unknown, key: string): string {
  const value = (result as Record<string, unknown> | null)?.[key];
  if (typeof value !== 'string' || value.trim().length === 0 || /^[\s{}\[\]\":,`]*$/.test(value)) {
    throw new Error('the model did not answer in a form we could read');
  }
  return value.trim();
}

function stringOf(item: unknown, key: string): string {
  const value = (item as Record<string, unknown> | null)?.[key];
  return typeof value === 'string' ? value.trim() : '';
}

function numberOf(item: unknown, key: string): number {
  const value = (item as Record<string, unknown> | null)?.[key];
  return typeof value === 'number' ? value : Number.NaN;
}
