/**
 * Research Engine。正本 §8。
 *
 * 手順の間で状態を持ち回さない。**Evidence Ledger と research_runs が状態そのもの**。
 * activity は何度でも再実行され得るので、途中経過をメモリに置くと壊れる。
 */
import {
  GenieError,
  asksForJudgment,
  canonicalSha256,
  countContradictionPairs,
  uuidv7,
  type EvidenceLedger,
} from '@genie/contracts';
import { withTenant, type DbHandle, type ScopedDb } from '@genie/db';
import {
  candidateFrom,
  confidenceOf,
  dedupe,
  findContradictions,
  score,
  type ScoredCandidate,
} from './quality.js';
import type { Finding, LanguageModel, SearchProvider } from './providers.js';
import { ResearchLedgerService } from './ledger.js';

export { asksForJudgment };

/** 抜粋から主張を取り出す呼び出しを、同時にいくつまで端末へ頼むか。 */
const EXTRACT_CONCURRENCY = 4;

export interface ResearchDeps {
  readonly db: DbHandle;
  readonly search: SearchProvider;
  readonly model: LanguageModel;
  /** 1 つの下位クエリで拾う件数。増やすほど遅く、質は頭打ちになる。 */
  readonly hitsPerQuery?: number;
  readonly maxSubQueries?: number;
  readonly now?: () => Date;
}

export interface StepOutcome {
  readonly result: Record<string, unknown>;
  /** 進捗に添える一言。UI/UX §6.1 の「12 sources」に相当。 */
  readonly detail: string | null;
  readonly artifact?: { readonly title: string; readonly markdown: string };
}

export class ResearchService {
  readonly #db: DbHandle;
  readonly #search: SearchProvider;
  readonly #model: LanguageModel;
  readonly #hitsPerQuery: number;
  readonly #maxSubQueries: number;
  readonly #now: () => Date;

  constructor(deps: ResearchDeps) {
    this.#db = deps.db;
    this.#search = deps.search;
    this.#model = deps.model;
    this.#hitsPerQuery = deps.hitsPerQuery ?? 5;
    this.#maxSubQueries = deps.maxSubQueries ?? 4;
    this.#now = deps.now ?? (() => new Date());
  }

  /**
   * 途中で失敗したことを残す。
   *
   * **状態を残さないと、進行中のまま永久に見える。**
   * `research_runs.status` には FAILED があるのに、
   * これまで誰もそこへ遷移させていなかった。
   */
  async markFailed(tenantId: string, taskId: string): Promise<void> {
    await withTenant(this.#db, tenantId, (tx) =>
      tx
        .updateTable('research_runs')
        .set({ status: 'FAILED', updated_at: this.#now() })
        .where('task_id', '=', taskId)
        // 既に終わったものは触らない
        .where('status', 'not in', ['COMPLETE', 'FAILED'])
        .execute(),
    );
  }

  /** 質問を分解する。何を調べたかを後から説明できるよう、下位クエリを残す。 */
  async plan(tenantId: string, taskId: string, question: string): Promise<StepOutcome> {
    const subQueries = await this.#model.decompose(question, this.#maxSubQueries);

    await withTenant(this.#db, tenantId, async (tx) => {
      const existing = await this.#find(tx, taskId);
      if (existing) {
        // activity の再実行。作り直さない。
        await tx
          .updateTable('research_runs')
          .set({
            sub_queries: JSON.stringify(subQueries),
            status: 'SEARCHING',
            updated_at: this.#now(),
          })
          .where('id', '=', existing.id)
          .execute();
        return;
      }
      await tx
        .insertInto('research_runs')
        .values({
          id: uuidv7(),
          tenant_id: tenantId,
          task_id: taskId,
          question,
          sub_queries: JSON.stringify(subQueries),
          status: 'SEARCHING',
          created_at: this.#now(),
          updated_at: this.#now(),
        })
        .execute();
    });

    return {
      result: { sub_queries: subQueries },
      detail: `${subQueries.length} queries`,
    };
  }

  /** 検索して、抜粋から主張を取り出し、評価して台帳へ積む。 */
  async search(tenantId: string, taskId: string): Promise<StepOutcome> {
    const run = await this.#require(tenantId, taskId);
    const now = this.#now();
    const unique = dedupe(await this.#gather(run.question, run.sub_queries as string[], now));
    const sources = await this.#store(tenantId, run.id, unique, now);
    return { result: { sources, claims: unique.length }, detail: `${sources} sources` };
  }

  /**
   * 見立てを求める問いだけの段。1 回目で決まった対象の、足りない中身を探す。
   *
   * 「次の重賞を 1 つ選んで予想」は、1 回目でレース名までしか分からず、
   * 出走馬や成績は誰も探していなかった（実測 2026-10-03: 結論が開催日と距離だけ）。
   * 1 回目の主張に出た名前で、もう 1 回だけ探す。検索の段に入れると
   * 1 つの段の時間の上限（5 分）を超えたので、段を分けた。
   */
  async deepen(tenantId: string, taskId: string): Promise<StepOutcome> {
    const run = await this.#require(tenantId, taskId);
    const known = await withTenant(this.#db, tenantId, (tx) => this.#evidenceOf(tx, run.id));
    if (!this.#model.followUp || known.length === 0 || !asksForJudgment(run.question))
      return { result: { sources: 0, claims: 0 }, detail: null };

    const asked = run.sub_queries as string[];
    const queries = (
      await this.#model.followUp(
        run.question,
        known.map((row) => row.claim),
        this.#maxSubQueries,
      )
    ).filter((query) => !asked.includes(query));
    if (queries.length === 0) return { result: { sources: 0, claims: 0 }, detail: null };

    const now = this.#now();
    const unique = dedupe(await this.#gather(run.question, queries, now));
    const sources = await this.#store(tenantId, run.id, unique, now);
    return { result: { sources, claims: unique.length }, detail: `${sources} sources` };
  }

  /** 検索して、抜粋から主張を取り出す。**DB には触らない**（端末を待つので）。 */
  async #gather(
    question: string,
    queries: readonly string[],
    now: Date,
  ): Promise<ScoredCandidate[]> {
    // 下位クエリは互いに独立なので並列でよい（正本 §8.1 parallel search）
    const results = await Promise.all(
      queries.map((query) => this.#search.search(query, this.#hitsPerQuery)),
    );
    const hits = results.flat();
    const extracted: ScoredCandidate[][] = Array.from({ length: hits.length }, () => []);
    // 取り出しも互いに独立。1 件ずつ待っていた間、12 件で 1 分以上かかっていた。
    let next = 0;
    const worker = async (): Promise<void> => {
      while (next < hits.length) {
        const at = next++;
        const hit = hits[at]!;
        for (const claim of await this.#model.extractClaims(question, hit)) {
          extracted[at]!.push(
            score(candidateFrom(hit, claim.claim, claim.supportText, this.#search.name), now),
          );
        }
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(EXTRACT_CONCURRENCY, hits.length) }, () => worker()),
    );
    // 並べ方は検索の順のまま（並列にしても結果の順が揺れない）
    return extracted.flat();
  }

  /** 主張を台帳へ積み、この調査の出典の数を返す。 */
  async #store(
    tenantId: string,
    runId: string,
    unique: readonly ScoredCandidate[],
    now: Date,
  ): Promise<number> {
    return withTenant(this.#db, tenantId, async (tx) => {
      for (const candidate of unique) {
        await tx
          .insertInto('evidence')
          .values({
            id: uuidv7(),
            tenant_id: tenantId,
            research_run_id: runId,
            source_url: candidate.url,
            source_type: candidate.sourceType,
            publisher: candidate.publisher,
            // 見つけたときの姿を残す。URL だけだと、切れたら確かめられない。
            title: candidate.title,
            snippet: candidate.snippet,
            provider: candidate.provider,
            published_at: candidate.publishedAt ? new Date(candidate.publishedAt) : null,
            retrieved_at: now,
            claim: candidate.claim,
            support_text_ref: await canonicalSha256(candidate.supportText),
            quality_score: candidate.qualityScore.toFixed(2),
            freshness_score: candidate.freshnessScore.toFixed(2),
            created_at: now,
          })
          // 同じ run で同じ URL の同じ主張は積み直さない（再実行対策）
          .onConflict((oc) => oc.doNothing())
          .execute();
      }
      // 出典の数は台帳全体で数える（深掘りの段で足した分も含める）
      const rows = await tx
        .selectFrom('evidence')
        .select('source_url')
        .where('research_run_id', '=', runId)
        .execute();
      const sources = new Set(rows.map((row) => row.source_url)).size;
      await tx
        .updateTable('research_runs')
        .set({ source_count: sources, status: 'SYNTHESIZING', updated_at: now })
        .where('id', '=', runId)
        .execute();
      return sources;
    });
  }

  /** 突き合わせる。矛盾があれば確信度を上げない。 */
  async verify(tenantId: string, taskId: string): Promise<StepOutcome> {
    const run = await this.#require(tenantId, taskId);

    return withTenant(this.#db, tenantId, async (tx) => {
      const rows = await this.#evidenceOf(tx, run.id);
      const scored = rows.map((row) =>
        score(
          {
            url: row.source_url,
            claim: row.claim,
            sourceType: row.source_type as ScoredCandidate['sourceType'],
            publisher: row.publisher,
            publishedAt: row.published_at?.toISOString() ?? null,
            supportText: row.claim,
            title: row.title ?? '',
            snippet: row.snippet ?? '',
            provider: row.provider,
          },
          this.#now(),
        ),
      );
      const byKey = new Map(
        rows.map((row, index) => [
          scored[index]!.normalizedUrl + scored[index]!.normalizedClaim,
          row.id,
        ]),
      );
      const contradictions = findContradictions(scored);

      for (const contradiction of contradictions) {
        const leftId = byKey.get(
          contradiction.left.normalizedUrl + contradiction.left.normalizedClaim,
        );
        const rightId = byKey.get(
          contradiction.right.normalizedUrl + contradiction.right.normalizedClaim,
        );
        if (!leftId || !rightId) continue;
        // 双方向に記録する。片側からしか辿れないと、根拠を引くときに見落とす。
        await tx
          .updateTable('evidence')
          .set((eb) => ({ contradicts: eb.fn('array_append', ['contradicts', eb.val(rightId)]) }))
          .where('id', '=', leftId)
          .execute();
        await tx
          .updateTable('evidence')
          .set((eb) => ({ contradicts: eb.fn('array_append', ['contradicts', eb.val(leftId)]) }))
          .where('id', '=', rightId)
          .execute();
      }

      const confidence = confidenceOf(scored, contradictions);
      await tx
        .updateTable('research_runs')
        .set({ confidence, updated_at: this.#now() })
        .where('id', '=', run.id)
        .execute();

      return {
        result: { contradictions: contradictions.length, confidence },
        detail:
          contradictions.length > 0
            ? `${contradictions.length} contradictions`
            : 'no contradictions',
      };
    });
  }

  /** レポートを組み立てる。artifact 化は task 側の activity が行う。 */
  async report(tenantId: string, taskId: string): Promise<StepOutcome> {
    const run = await this.#require(tenantId, taskId);

    const rows = await withTenant(this.#db, tenantId, (tx) => this.#evidenceOf(tx, run.id));
    /*
     * **モデルを呼ぶ間、トランザクションを開いたままにしない。**
     *
     * 端末のモデルへの依頼は `host_step_requests` に行を置いて、端末が取りに来るのを待つ。
     * 入れ子の `withTenant` は外側のトランザクションに相乗りするので、ここを囲んだままだと
     * その行はコミットされず、端末からは見えない。誰も取らない依頼を上限まで待って落ちていた
     * （実測 2026-10-02: レポートの段だけ依頼が 1 件も残らず、10 分後に失敗）。
     * 同じトランザクションが tasks の行も掴むので、停止も失敗の記録も待たされていた。
     */
    const claims = rows.map((row) => row.claim);
    const summary = await this.#model.synthesize(run.question, claims);
    // 予想・評価を求められたときだけ、事実の結論とは別に見立てを足す。
    const assessment =
      this.#model.assess && claims.length > 0 && asksForJudgment(run.question)
        ? await this.#model.assess(run.question, claims)
        : [];
    const distinct = new Set(rows.map((row) => row.source_url));

    await withTenant(this.#db, tenantId, (tx) =>
      tx
        .updateTable('research_runs')
        .set({ status: 'COMPLETE', updated_at: this.#now() })
        .where('id', '=', run.id)
        .execute(),
    );

    return {
      result: { sources: distinct.size },
      detail: null,
      artifact: { title: run.question, markdown: composeReport(run, summary, rows, assessment) },
    };
  }

  /** Evidence Ledger。実装は ResearchLedgerService（読むだけなら db で足りる）。 */
  async ledger(tenantId: string, taskId: string): Promise<EvidenceLedger> {
    return new ResearchLedgerService(this.#db).ledger(tenantId, taskId);
  }

  async #find(tx: ScopedDb, taskId: string): Promise<RunRow | undefined> {
    const row = await tx
      .selectFrom('research_runs')
      .selectAll()
      .where('task_id', '=', taskId)
      .executeTakeFirst();
    return row as RunRow | undefined;
  }

  async #require(tenantId: string, taskId: string): Promise<RunRow> {
    const row = await withTenant(this.#db, tenantId, (tx) => this.#find(tx, taskId));
    if (!row) throw new GenieError('common.not_found', `no research run for task ${taskId}`);
    return row;
  }

  async #evidenceOf(tx: ScopedDb, runId: string): Promise<EvidenceRow[]> {
    const rows = await tx
      .selectFrom('evidence')
      .selectAll()
      .where('research_run_id', '=', runId)
      .orderBy('quality_score', 'desc')
      .orderBy('id', 'asc')
      .execute();
    return rows as unknown as EvidenceRow[];
  }
}

interface RunRow {
  id: string;
  question: string;
  sub_queries: unknown;
  source_count: number;
  confidence: string | null;
}

interface EvidenceRow {
  id: string;
  source_url: string;
  source_type: string;
  publisher: string | null;
  published_at: Date | null;
  retrieved_at: Date;
  claim: string;
  /** 見つけたときの姿。URL が切れても、ここは残る。 */
  title: string | null;
  snippet: string | null;
  /** どの検索が見つけたか。 */
  provider: string | null;
  quality_score: string;
  freshness_score: string;
  supports: string[];
  contradicts: string[];
}

/**
 * レポート。UI/UX §13.2 の Result に対応する。
 *
 * **結論を先に出す。**引用で埋めない。根拠は数と出典で示し、
 * 詳細は Evidence から辿る（§15 の Progressive Disclosure）。
 */
export function composeReport(
  run: Pick<RunRow, 'question' | 'confidence'>,
  summary: readonly Finding[],
  evidence: readonly EvidenceRow[],
  assessment: readonly Finding[] = [],
): string {
  const distinct = [...new Set(evidence.map((row) => row.source_url))];
  // 行数ではなく組の数。1 件の食い違いを 2 件と書かない。
  const contradictionCount = countContradictionPairs(evidence);
  const contradictions = evidence.filter((row) => row.contradicts.length > 0);
  const byType = new Map<string, number>();
  for (const row of evidence) byType.set(row.source_type, (byType.get(row.source_type) ?? 0) + 1);

  const lines: string[] = [
    `# ${run.question}`,
    '',
    '## 結論',
    '',
    /*
     * 結論には、立っている根拠を並べる。UI/UX §15。
     *
     * **番号だけでは辿れない。**報告を単体で読む人には、
     * どの出典を見ればよいかが分からない。だから URL まで書く。
     * 根拠を挙げられない結論は、そもそもここへ来ない（落としてある）。
     */
    ...(summary.length > 0
      ? summary.map(
          (point, index) =>
            `${index + 1}. ${point.text}\n   根拠: ${point.supports
              .map((position) => evidence[position]?.source_url)
              .filter((url): url is string => typeof url === 'string')
              .filter((url, at, all) => all.indexOf(url) === at)
              .map((url) => `[${url}](${url})`)
              .join(' / ')}`,
        )
      : ['確かなことは分かりませんでした。']),
    ...(assessment.length > 0
      ? [
          '',
          '## 見立て',
          '',
          // 事実の結論と混ぜない。読む人が「調べた事実」と「そこからの判断」を分けて読めるように。
          '上の根拠からの判断です。結果を保証するものではありません。',
          '',
          ...assessment.map(
            (point, index) =>
              `${index + 1}. ${point.text}\n   根拠: ${point.supports
                .map((position) => evidence[position]?.source_url)
                .filter((url): url is string => typeof url === 'string')
                .filter((url, at, all) => all.indexOf(url) === at)
                .map((url) => `[${url}](${url})`)
                .join(' / ')}`,
          ),
        ]
      : []),
    '',
    `${distinct.length} sources · confidence: ${run.confidence ?? 'low'} · contradictions: ${contradictionCount}`,
    '',
    '## 出典',
    '',
    ...[...byType.entries()].map(([type, count]) => `- ${type}: ${count}`),
    '',
    ...distinct.map((url) => `- ${url}`),
  ];

  if (contradictions.length > 0) {
    lines.push(
      '',
      '## 食い違い',
      '',
      // 見つけた食い違いは隠さない。結論の確信度を下げる根拠でもある。
      ...contradictions.map((row) => `- ${row.claim}（${row.source_url}）`),
    );
  }

  return lines.join('\n');
}
