/**
 * Connector の接続状態。正本 §2.4・§21。
 *
 * 守るのは 2 つ:
 *
 *   - **資格情報そのものを持たない。**保管庫の参照だけを持つ。
 *     平文のトークンをアプリの DB に置くと、DB を読める全員が読める
 *   - **繋がっていない connector の tool を、黙って動かさない。**
 *     何も起きないのと、繋がっていないのは違う
 */
import {
  GenieError,
  looksLikeCredential,
  uuidv7,
  type ConnectorDecl,
  type PluginManifest,
} from '@genie/contracts';
import { withSystem, withTenant, type DbHandle } from '@genie/db';

export type ConnectionState = 'CONNECTED' | 'EXPIRED' | 'REVOKED' | 'ERROR';

export interface Connection {
  readonly id: string;
  readonly pluginId: string;
  readonly connectorId: string;
  readonly provider: string;
  readonly state: ConnectionState;
  readonly grantedScopes: readonly string[];
  readonly accountLabel: string | null;
  readonly expiresAt: string | null;
  readonly lastError: string | null;
}

export interface ConnectInput {
  readonly tenantId: string;
  readonly userId: string;
  readonly pluginId: string;
  readonly connectorId: string;
  /**
   * 保管庫の参照。**値ではない。**
   * `keychain:...` / `secret-manager:...` のような形を想定する。
   */
  readonly credentialRef: string;
  /** 実際に許可された scope。要求した scope ではない。 */
  readonly grantedScopes: readonly string[];
  readonly accountLabel?: string | null;
  readonly expiresAt?: string | null;
}

export class ConnectionService {
  readonly #db: DbHandle;
  readonly #now: () => Date;

  constructor(deps: { db: DbHandle; now?: () => Date }) {
    this.#db = deps.db;
    this.#now = deps.now ?? (() => new Date());
  }

  /**
   * 繋ぐ。
   *
   * **参照だけを受け取る。**値を渡されたら断る。
   * ここを緩めると、いずれ誰かがトークンをそのまま入れる。
   */
  async connect(input: ConnectInput): Promise<Connection> {
    if (looksLikeCredential(input.credentialRef)) {
      throw new GenieError(
        'common.validation_failed',
        'a connection stores a reference to a credential, never the credential itself',
      );
    }

    const decl = await this.#declarationFor(input.pluginId, input.connectorId);
    // 宣言に無い scope は記録しない。実際に許された分だけを残す。
    const declared = new Set(decl.scopes);
    const granted = input.grantedScopes.filter((s) => declared.has(s));

    const at = this.#now();
    const row = await withTenant(this.#db, input.tenantId, async (tx) => {
      // 繋ぎ直しは、前のものを失効させてから
      await tx
        .updateTable('connector_connections')
        .set({ state: 'REVOKED', revoked_at: at, updated_at: at })
        .where('plugin_id', '=', input.pluginId)
        .where('connector_id', '=', input.connectorId)
        .where('state', '!=', 'REVOKED')
        .execute();

      return tx
        .insertInto('connector_connections')
        .values({
          id: uuidv7(),
          tenant_id: input.tenantId,
          plugin_id: input.pluginId,
          connector_id: input.connectorId,
          provider: decl.provider,
          state: 'CONNECTED',
          granted_scopes: granted,
          credential_ref: input.credentialRef,
          account_label: input.accountLabel ?? null,
          connected_by: input.userId,
          connected_at: at,
          expires_at: input.expiresAt ? new Date(input.expiresAt) : null,
          updated_at: at,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
    });
    return toConnection(row);
  }

  /**
   * どこかに、生きている接続が 1 つでもあるか。
   *
   * 起動時の能力の名乗りに使う。**設定を見ても、設定が正しいかは
   * 分からない。**繋がった実績があるかどうかだけが確かめられる事実で、
   * 繋がっているなら同意画面もコードの交換も保管も通っている。
   *
   * テナントを跨いで数えるので `withSystem`。**中身は読まない** —
   * 見るのは「有無」だけで、誰の何かは要らない。
   */
  async anyConnected(): Promise<boolean> {
    const row = await withSystem(this.#db, (tx) =>
      tx
        .selectFrom('connector_connections')
        .select('id')
        .where('state', '=', 'CONNECTED')
        .limit(1)
        .executeTakeFirst(),
    );
    return row !== undefined;
  }

  async list(tenantId: string, pluginId?: string): Promise<Connection[]> {
    const rows = await withTenant(this.#db, tenantId, (tx) => {
      let query = tx
        .selectFrom('connector_connections')
        .selectAll()
        .where('state', '!=', 'REVOKED');
      if (pluginId) query = query.where('plugin_id', '=', pluginId);
      return query.orderBy('id', 'desc').execute();
    });
    return rows.map(toConnection);
  }

  /** 本人が提供者へつないだもの（切ったものは除く）。新しい順。いま切れているかを本人に答えるのに使う。 */
  async ofUser(
    tenantId: string,
    userId: string,
    provider: string,
  ): Promise<{ state: ConnectionState; accountLabel: string | null; connectedAt: Date }[]> {
    const rows = await withTenant(this.#db, tenantId, (tx) =>
      tx
        .selectFrom('connector_connections')
        .select(['state', 'account_label', 'connected_at'])
        .where('connected_by', '=', userId)
        .where('provider', '=', provider)
        .where('state', '!=', 'REVOKED')
        .orderBy('connected_at', 'desc')
        .execute(),
    );
    return rows.map((r) => ({
      state: r.state as ConnectionState,
      accountLabel: r.account_label,
      connectedAt: r.connected_at,
    }));
  }

  /** 切る。**参照も消す。**残しておく理由が無い。 */
  async disconnect(tenantId: string, pluginId: string, connectorId: string): Promise<void> {
    const at = this.#now();
    const result = await withTenant(this.#db, tenantId, (tx) =>
      tx
        .updateTable('connector_connections')
        .set({ state: 'REVOKED', revoked_at: at, credential_ref: null, updated_at: at })
        .where('plugin_id', '=', pluginId)
        .where('connector_id', '=', connectorId)
        .where('state', '!=', 'REVOKED')
        .executeTakeFirst(),
    );
    if (Number(result.numUpdatedRows) === 0) {
      throw new GenieError('plugin.not_found', 'no such connection');
    }
  }

  /**
   * その tool を動かしてよいか。
   *
   * **繋がっていないことを、何も起きなかったことにしない。**
   * 黙って no-op にすると、利用者は「動いたが結果が無い」と受け取る。
   */
  async assertUsable(tenantId: string, pluginId: string, connectorId: string): Promise<Connection> {
    const rows = await this.list(tenantId, pluginId);
    const connection = rows.find((c) => c.connectorId === connectorId);

    if (!connection) {
      throw new GenieError('host.not_connected', `${pluginId}/${connectorId} is not connected yet`);
    }
    if (connection.state !== 'CONNECTED') {
      throw new GenieError(
        'host.not_connected',
        `${pluginId}/${connectorId} is ${connection.state.toLowerCase()}`,
      );
    }
    if (connection.expiresAt && Date.parse(connection.expiresAt) <= this.#now().getTime()) {
      // 期限切れを「繋がっている」と言わない
      throw new GenieError('host.not_connected', `${pluginId}/${connectorId} has expired`);
    }
    return connection;
  }

  /** 期限切れ・失敗を記録する。**繋がっているふりをしない。** */
  async markUnusable(
    tenantId: string,
    pluginId: string,
    connectorId: string,
    state: 'EXPIRED' | 'ERROR',
    reason?: string,
  ): Promise<void> {
    await withTenant(this.#db, tenantId, (tx) =>
      tx
        .updateTable('connector_connections')
        .set({ state, last_error: reason ?? null, updated_at: this.#now() })
        .where('plugin_id', '=', pluginId)
        .where('connector_id', '=', connectorId)
        .where('state', '=', 'CONNECTED')
        .execute(),
    );
  }

  async #declarationFor(pluginId: string, connectorId: string): Promise<ConnectorDecl> {
    const row = await withSystem(this.#db, (tx) =>
      tx
        .selectFrom('plugins')
        .innerJoin('plugin_versions', (join) =>
          join
            .onRef('plugin_versions.plugin_id', '=', 'plugins.id')
            .onRef('plugin_versions.version', '=', 'plugins.latest_version'),
        )
        .select(['plugin_versions.manifest as manifest'])
        .where('plugins.id', '=', pluginId)
        .executeTakeFirst(),
    );
    if (!row) throw new GenieError('plugin.not_found', `no plugin ${pluginId}`);

    const manifest = row.manifest as unknown as PluginManifest;
    const decl = manifest.connectors.find((c) => c.id === connectorId);
    // 宣言していない connector には繋がない
    if (!decl) {
      throw new GenieError(
        'plugin.not_found',
        `${pluginId} does not declare a connector "${connectorId}"`,
      );
    }
    return decl;
  }
}

function toConnection(row: Record<string, unknown>): Connection {
  return {
    id: row['id'] as string,
    pluginId: row['plugin_id'] as string,
    connectorId: row['connector_id'] as string,
    provider: row['provider'] as string,
    state: row['state'] as ConnectionState,
    grantedScopes: (row['granted_scopes'] ?? []) as string[],
    accountLabel: (row['account_label'] ?? null) as string | null,
    expiresAt: row['expires_at'] instanceof Date ? row['expires_at'].toISOString() : null,
    lastError: (row['last_error'] ?? null) as string | null,
    // credential_ref は返さない。**外へ出す理由が無い。**
  };
}
