/**
 * 外部依存の境界。Phase 2 実装仕様 §1.1。
 *
 * LLM プロバイダは未決（Phase 0 §18 OQ-3）。決まるまで待つと Phase 2 が丸ごと止まるので、
 * Phase 0 の `TokenVerifier` と同じ手を使う: interface を切り、決定的な実装で先へ進める。
 *
 * **モデルに依存しない部分は本物を作る。**品質評価・重複排除・矛盾検出・
 * Evidence Ledger・レポートの組み立ては、モデルが無くても成立する。
 */

export type SourceType = 'official' | 'filing' | 'news' | 'internal' | 'other';

export interface SearchHit {
  readonly url: string;
  readonly title: string;
  /** 検索結果の抜粋。本文の取得は fetch 側の責務。 */
  readonly snippet: string;
  readonly publisher: string | null;
  readonly publishedAt: string | null;
  readonly sourceType: SourceType;
}

export interface SearchProvider {
  readonly name: string;
  /** 代役か。本番で代役のまま起動していないかの判定に使う。 */
  readonly isStandIn: boolean;
  search(query: string, limit: number): Promise<SearchHit[]>;
}

/**
 * 結論 1 つ。**立っている根拠の番号を持つ。**
 *
 * 番号は `synthesize` に渡した `claims` の位置。
 * 空の `supports` は「根拠が無い結論」なので、呼び出し側が落とす。
 */
export interface Finding {
  readonly text: string;
  readonly supports: readonly number[];
}

export interface ExtractedClaim {
  readonly claim: string;
  /** 抜粋のどこを根拠にしたか。原文全体は object store 側に置く。 */
  readonly supportText: string;
}

/**
 * 問いに添えられた端末内の画像（スクショ等）。id とラベルだけ。
 *
 * **画素はここに無い。**実体は端末の受け渡し場所にあり、端末で走る
 * モデル呼び出しが読む。cloud で動く実装（Anthropic API / 代役）は
 * 画像を見られないので、この引数を黙って無視してよい —— ただし
 * 見たふりはしない。
 */
export interface VisualAttachment {
  readonly id: string;
  readonly kind: 'screenshot' | 'clipboard_image';
  readonly label: string;
}

export interface LanguageModel {
  readonly name: string;
  readonly isStandIn: boolean;
  /** 質問を、独立に検索できる下位クエリへ分解する。 */
  decompose(question: string, max: number): Promise<string[]>;
  /** 抜粋から、確認できる主張を取り出す。 */
  extractClaims(question: string, hit: SearchHit): Promise<ExtractedClaim[]>;
  /**
   * 根拠から結論をまとめる。
   *
   * **どの根拠に立っているかを一緒に返す。**返さないと、
   * 出来上がった結論を後から根拠へ辿れない。§8 の Evidence Ledger は
   * 「根拠がある」ことではなく「**この結論はこの根拠に立つ**」ことを
   * 見せるためのもので、対応が無ければ台帳は飾りになる。
   */
  synthesize(question: string, claims: readonly string[]): Promise<Finding[]>;
  /**
   * 予想・評価・比較を求められたときの見立て。**事実の結論とは分けて出す。**
   *
   * 根拠の番号を持たない見立ては捨てる（結論と同じ規則）。
   * 実装していないモデルは見立てを出さない（報告は事実だけになる）。
   */
  assess?(question: string, claims: readonly string[]): Promise<Finding[]>;
  /**
   * 1 回目の主張で対象が決まった後、問いに答えるのに足りない中身を探す検索語。
   * 主張に出た名前を使う。足りていれば空を返す。
   */
  followUp?(question: string, claims: readonly string[], max: number): Promise<string[]>;
  /**
   * 自由な問いに答える。正本 §2.2 General Assistant。
   *
   * 調査と違い、根拠を集めない。**知らないことは知らないと言う**のは
   * 呼び出し側では強制できないので、指示の側で頼む。
   */
  answer(
    question: string,
    context?: string,
    attachments?: readonly VisualAttachment[],
  ): Promise<string>;

  /** 文章を書く。下書きまでで、送りはしない。画像（端末内）について書くときは attachments。 */
  compose(
    instruction: string,
    context?: string,
    attachments?: readonly VisualAttachment[],
  ): Promise<string>;

  /**
   * 意味の矛盾を見つける。
   *
   * 数値の食い違いは `quality.findContradictions` が規則で拾う。
   * 否定や言い換えを跨ぐものは規則では確実に拾えないので、ここに置いてある。
   * 実装が無い間は「見つからない」ではなく「**まだ調べていない**」であることを、
   * 呼び出し側が扱えるように optional にしてある。
   */
  detectContradictions?(claims: readonly string[]): Promise<{ left: number; right: number }[]>;
}

/**
 * 決定的な検索。テストと、プロバイダが決まるまでの開発に使う。
 * **本番では使わない**（起動時に拒否する呼び出し側の責務）。
 */
export class StaticSearchProvider implements SearchProvider {
  readonly name = 'static';
  readonly isStandIn = true;
  readonly #hits: readonly SearchHit[];

  constructor(hits: readonly SearchHit[]) {
    this.#hits = hits;
  }

  async search(query: string, limit: number): Promise<SearchHit[]> {
    const needle = query.toLowerCase();
    const matched = this.#hits.filter(
      (hit) =>
        hit.title.toLowerCase().includes(needle) || hit.snippet.toLowerCase().includes(needle),
    );
    // 一致が無ければ全部返す。検索の質を試すのはここの役目ではない。
    return (matched.length > 0 ? matched : this.#hits).slice(0, limit);
  }
}

/**
 * 決定的な言語モデル。
 *
 * 実モデルの代わりに、規則で同じことをする。**賢くしない。**
 * ここが賢いと、モデルが無くても動いてしまい、差し替えの必要に気づけなくなる。
 */
export class DeterministicLanguageModel implements LanguageModel {
  readonly name = 'deterministic';
  readonly isStandIn = true;

  async decompose(question: string, max: number): Promise<string[]> {
    // 「A と B」「A、B」で割る。割れなければ質問そのもの。
    const parts = question
      .split(/[、,]|\sand\s|\sと\s/)
      .map((part) => part.trim())
      .filter((part) => part.length >= 2);
    return (parts.length > 1 ? parts : [question.trim()]).slice(0, max);
  }

  async extractClaims(_question: string, hit: SearchHit): Promise<ExtractedClaim[]> {
    // 抜粋を文で割り、意味のある長さのものだけを主張として扱う
    return hit.snippet
      .split(/[。.]\s*/)
      .map((sentence) => sentence.trim())
      .filter((sentence) => sentence.length >= 8)
      .slice(0, 5)
      .map((sentence) => ({ claim: sentence, supportText: sentence }));
  }

  async synthesize(_question: string, claims: readonly string[]): Promise<Finding[]> {
    // 上位の主張をそのまま結論にする。要約はしない（できないので、するふりをしない）
    return claims.slice(0, 3).map((text, index) => ({ text, supports: [index] }));
  }

  /**
   * 答えられない。**答えたふりをしない。**
   *
   * 代役がもっともらしい文を返すと、モデルを繋いでいないことに
   * 誰も気づかないまま使われる。空文字を返すのも同じことなので、断る。
   */
  async answer(): Promise<string> {
    throw new Error('no language model is connected; this stand-in cannot answer');
  }

  async compose(): Promise<string> {
    throw new Error('no language model is connected; this stand-in cannot write');
  }
}
