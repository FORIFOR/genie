import { sql } from 'kysely';
/**
 * 手元でしか動かせない step の受け渡し。正本 §4.4・§16.1・§21。
 *
 * cloud 側は**実行しない。**「これをやってほしい」を置き、端末が取りに来て、
 * 端末で走らせ、結果だけが戻る。
 *
 * この形にしている理由はひとつ:
 * **connector の資格情報は端末の Keychain にしかない。**
 * cloud にトークンが無いなら、cloud で呼べる道は作らない。
 * 作れば、いつか「サーバにも置けば簡単になる」に負ける。
 *
 * ここが守ること:
 *   - 同じ step を二度置かない（**二重実行を作らない**）
 *   - 資格情報を引数に入れさせない
 *   - 取りに来ないまま古くなったものは、成功にも失敗にもせず期限切れにする
 *   - **失敗を成功として返さない**
 */
import {
  GenieError,
  looksLikeSecretName,
  looksLikeSecretValue,
  stateFromHeartbeat,
  uuidv7,
} from '@genie/contracts';
import { withTenant, type DbHandle } from '@genie/db';

/**
 * 承認された事実。cloud が発行し、**端末が使う前にもう一度確かめる。**
 *
 * 形は connector 側の `ApprovalProof` と揃える。ずれると、
 * 端末は「承認が無い」と判断して、承認済みの操作を止めてしまう。
 */
export interface ApprovalProof {
  readonly approvalId: string;
  readonly operationId: string;
  readonly decision: 'APPROVED' | 'REJECTED';
  readonly decidedBy: string;
  readonly decidedAt: string;
  readonly expiresAt: string;
}

export interface HostStepRequest {
  readonly id: string;
  readonly taskId: string;
  readonly stepIndex: number;
  readonly toolId: string;
  readonly args: Record<string, unknown>;
  readonly requestKey: string;
  /** 人が承認した跡。承認の要らない操作では null。 */
  readonly approval: ApprovalProof | null;
  readonly status: 'PENDING' | 'CLAIMED' | 'DONE' | 'FAILED';
  readonly hostId: string | null;
  readonly result: unknown;
  readonly error: { code: string; message: string } | null;
  readonly createdAt: string;
  readonly expiresAt: string;
}

export interface BridgeDeps {
  readonly db: DbHandle;
  readonly now?: () => Date;
  /** 端末が取りに来るのを待つ上限。 */
  readonly requestTtlMs?: number;
}

/**
 * 受け渡しの既定の寿命。
 *
 * 短すぎると昼休みで席を立っただけで切れる。長すぎると、
 * 端末が戻ったときに**もう誰も待っていない仕事**が走り出す。
 */
export const DEFAULT_REQUEST_TTL_MS = 15 * 60_000;

interface Row {
  id: string;
  task_id: string;
  step_index: number;
  tool_id: string;
  args: unknown;
  request_key: string;
  approval: unknown;
  status: string;
  host_id: string | null;
  result: unknown;
  error: unknown;
  created_at: Date;
  expires_at: Date;
}

function toRequest(row: Row): HostStepRequest {
  return {
    id: row.id,
    taskId: row.task_id,
    stepIndex: row.step_index,
    toolId: row.tool_id,
    args: (row.args ?? {}) as Record<string, unknown>,
    requestKey: row.request_key,
    approval: (row.approval ?? null) as ApprovalProof | null,
    status: row.status as HostStepRequest['status'],
    hostId: row.host_id,
    result: row.result ?? null,
    error: (row.error ?? null) as HostStepRequest['error'],
    createdAt: row.created_at.toISOString(),
    expiresAt: row.expires_at.toISOString(),
  };
}

export class HostBridge {
  readonly #db: DbHandle;
  readonly #now: () => Date;
  readonly #ttlMs: number;

  constructor(deps: BridgeDeps) {
    this.#db = deps.db;
    this.#now = deps.now ?? (() => new Date());
    this.#ttlMs = deps.requestTtlMs ?? DEFAULT_REQUEST_TTL_MS;
  }

  /** いま仕事を渡せる端末があるか。**無ければ止める理由になる。** */
  async hasOnlineHost(tenantId: string, userId: string): Promise<boolean> {
    const now = this.#now().getTime();
    const rows = await withTenant(this.#db, tenantId, (tx) =>
      tx
        .selectFrom('agent_hosts')
        .select(['last_seen_at', 'models'])
        .where('user_id', '=', userId)
        .execute(),
    );
    return rows.some(
      (row) =>
        stateFromHeartbeat(row.last_seen_at.toISOString(), now) === 'online' &&
        // モデルが無い端末は名乗っていても仕事を受けない
        row.models.length > 0,
    );
  }

  /**
   * 端末にやってもらう step を置く。
   *
   * **同じ step は二度置かない。**既にあるものを返す。
   * ここで新しい行を作ると、activity が再試行されるたびに
   * 同じ送信が積み上がる。
   */
  async request(input: {
    tenantId: string;
    taskId: string;
    stepIndex: number;
    toolId: string;
    args: Record<string, unknown>;
    approval?: ApprovalProof | null;
    /**
     * 同じ step の中で何度も頼むときの区別。
     *
     * connector は空のまま（1 step = 1 操作）。言語モデルは呼び出しの
     * 内容から作る。空のままにすると、**2 回目が 1 回目の結果を受け取る** —
     * 分解の答えが統合の答えとして返る。
     */
    requestKey?: string;
  }): Promise<HostStepRequest> {
    assertNoCredentials(input.args);
    const at = this.#now();

    const row = await withTenant(this.#db, input.tenantId, async (tx) => {
      const existing = await tx
        .selectFrom('host_step_requests')
        .selectAll()
        .where('task_id', '=', input.taskId)
        .where('step_index', '=', input.stepIndex)
        .where('request_key', '=', input.requestKey ?? '')
        .executeTakeFirst();
      if (existing) return existing;

      return tx
        .insertInto('host_step_requests')
        .values({
          id: uuidv7(),
          tenant_id: input.tenantId,
          task_id: input.taskId,
          step_index: input.stepIndex,
          tool_id: input.toolId,
          args: JSON.stringify(input.args),
          request_key: input.requestKey ?? '',
          approval: input.approval ? JSON.stringify(input.approval) : null,
          status: 'PENDING',
          created_at: at,
          expires_at: new Date(at.getTime() + this.#ttlMs),
        })
        .returningAll()
        .executeTakeFirstOrThrow();
    });
    return toRequest(row as Row);
  }

  /**
   * 端末が次の 1 件を取る。
   *
   * **一度に 1 件だけ、1 台だけ。**`FOR UPDATE SKIP LOCKED` で、
   * 2 台が同時に取りに来ても同じ行を掴まない。
   */
  async claimNext(input: { tenantId: string; hostId: string }): Promise<HostStepRequest | null> {
    const at = this.#now();
    const row = await withTenant(this.#db, input.tenantId, async (tx) => {
      const next = await tx
        .selectFrom('host_step_requests')
        .selectAll()
        .where('status', '=', 'PENDING')
        .where('expires_at', '>', at)
        .where((eb) =>
          eb.or([
            eb('tool_id', 'not like', 'execution.%'),
            eb.exists(
              eb
                .selectFrom('tasks')
                .innerJoin('agent_hosts', 'agent_hosts.user_id', 'tasks.created_by')
                .select('tasks.id')
                .whereRef('tasks.id', '=', 'host_step_requests.task_id')
                .where('tasks.tenant_id', '=', input.tenantId)
                .where('agent_hosts.tenant_id', '=', input.tenantId)
                .where('agent_hosts.id', '=', input.hostId),
            ),
          ]),
        )
        .where((eb) =>
          eb.or([
            eb('tool_id', '!=', 'execution.apply'),
            eb(sql<string>`args #>> '{prepared,deviceId}'`, '=', input.hostId),
          ]),
        )
        .orderBy('created_at', 'asc')
        .limit(1)
        .forUpdate()
        .skipLocked()
        .executeTakeFirst();
      if (!next) return null;

      return tx
        .updateTable('host_step_requests')
        .set({ status: 'CLAIMED', host_id: input.hostId, claimed_at: at })
        .where('id', '=', next.id)
        .returningAll()
        .executeTakeFirstOrThrow();
    });
    return row ? toRequest(row as Row) : null;
  }

  /**
   * 端末が結果を返す。
   *
   * **取った端末だけが返せる。**別の端末の結果を受け取ると、
   * 取り直しの境目で古い結果が新しい実行を上書きする。
   */
  async complete(input: {
    tenantId: string;
    requestId: string;
    hostId: string;
    result: unknown;
  }): Promise<void> {
    await this.#settle(input.tenantId, input.requestId, input.hostId, {
      status: 'DONE',
      // result が undefined でも DONE にできてしまわないよう、null を書く
      result: JSON.stringify(input.result ?? null),
    });
  }

  /** 端末が失敗を返す。**握り潰さず、そのまま失敗として残す。** */
  async fail(input: {
    tenantId: string;
    requestId: string;
    hostId: string;
    error: { code: string; message: string };
  }): Promise<void> {
    await this.#settle(input.tenantId, input.requestId, input.hostId, {
      status: 'FAILED',
      error: JSON.stringify(input.error),
    });
  }

  async #settle(
    tenantId: string,
    requestId: string,
    hostId: string,
    patch: Record<string, unknown>,
  ): Promise<void> {
    const at = this.#now();
    const updated = await withTenant(this.#db, tenantId, (tx) =>
      tx
        .updateTable('host_step_requests')
        .set({ ...patch, completed_at: at })
        .where('id', '=', requestId)
        .where('host_id', '=', hostId)
        // 決着済みのものを書き換えない
        .where('status', '=', 'CLAIMED')
        .returning('id')
        .executeTakeFirst(),
    );
    if (!updated) {
      throw new GenieError(
        'common.conflict',
        'this step was not claimed by that host, or it has already been settled',
      );
    }
  }

  async get(tenantId: string, requestId: string): Promise<HostStepRequest | null> {
    const row = await withTenant(this.#db, tenantId, (tx) =>
      tx
        .selectFrom('host_step_requests')
        .selectAll()
        .where('id', '=', requestId)
        .executeTakeFirst(),
    );
    return row ? toRequest(row as Row) : null;
  }

  /**
   * 取りに来ないまま古くなったものを片付ける。
   *
   * **成功にも失敗にもしない。**「端末が取りに来なかった」であって、
   * 「やってみて駄目だった」ではない。呼び出し側は待ち直せる。
   */
  async expireStale(tenantId: string): Promise<string[]> {
    const at = this.#now();
    const rows = await withTenant(this.#db, tenantId, (tx) =>
      tx
        .deleteFrom('host_step_requests')
        .where('status', '=', 'PENDING')
        .where('expires_at', '<=', at)
        .returning('id')
        .execute(),
    );
    return rows.map((row) => row.id);
  }
}

/**
 * 資格情報を引数に入れさせない。
 *
 * 端末は自分の Keychain から取る。cloud が渡す必要はない。
 * 渡せる形にしておくと、いつか誰かが渡す。
 *
 * **長さでは弾かない。**参照の検査（`looksLikeCredential`）をそのまま
 * 当てていた間、200 文字を超える引数がすべて資格情報扱いになっていた。
 * メール本文も、agent の指示書も、検索の抜粋も超える。
 * 結果、**長い本文のメールは端末へ渡せず、送れなかった。**
 *
 * 見るのは 2 つ:
 *   - 値が資格情報の形をしているか（`ya29.` / `ghp_` / JWT など）
 *   - 欄の名前が資格情報を指しているか（`token` / `api_key` など）
 */
function assertNoCredentials(args: Record<string, unknown>, depth = 0): void {
  if (depth > 6) return;

  for (const [key, value] of Object.entries(args)) {
    const named = looksLikeSecretName(key);
    if (typeof value === 'string' && (named || looksLikeSecretValue(value))) {
      throw new GenieError(
        'common.validation_failed',
        'a step handed to the device must not carry a credential; the device holds its own',
      );
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        if (typeof item === 'string' && (named || looksLikeSecretValue(item))) {
          throw new GenieError(
            'common.validation_failed',
            'a step handed to the device must not carry a credential; the device holds its own',
          );
        }
        if (item && typeof item === 'object') {
          assertNoCredentials(item as Record<string, unknown>, depth + 1);
        }
      }
      continue;
    }
    if (value && typeof value === 'object') {
      assertNoCredentials(value as Record<string, unknown>, depth + 1);
    }
  }
}
