/**
 * 利用者ごとの Oathra 接続（`phone_connections`）。
 *
 * **接続は 1 人のもの。**ほかの利用者の task や着信から、この人の接続は使わない。
 * トークンは `SecretBox` で封じて置き、読むのは withTenant の中だけ。
 * 着信の取り込みが「だれが繋いでいるか」を知るときだけ withIdentity で引く
 * （bootstrap.sql で列を限って GRANT してある。トークンは見えない）。
 */
import { uuidv7 } from '@genie/contracts';
import { withIdentity, withTenant, type DbHandle } from '@genie/db';
import { appendAuditEvent } from '@genie/telemetry';
import {
  checkedOrigin,
  type OathraConnection,
  type PhoneOwner,
  type PhoneSetup,
} from './oathra.js';
import { SecretKeyError, type SecretBox } from './secret.js';

export interface PhoneConnectionStatus {
  readonly baseUrl: string;
  readonly grantId: string;
  readonly connectedAt: string;
}

/** どの行の秘密か。封を別の行へ写しても開かないようにする。 */
const aadFor = (owner: PhoneOwner, grantId: string) =>
  `phone_connections:${owner.tenantId}:${owner.userId}:${grantId}`;

export class PhoneConnectionStore {
  constructor(
    private readonly deps: { readonly db: DbHandle; readonly secrets: SecretBox | null },
  ) {}

  /** 封の鍵があるか。無ければ保存できない（平文では置かない）。 */
  get canStore(): boolean {
    return this.deps.secrets !== null;
  }

  /** 繋ぎ直す。古い接続は切ってから、新しいものを 1 つだけ置く。 */
  async save(owner: PhoneOwner, connection: OathraConnection): Promise<PhoneConnectionStatus> {
    const secrets = this.deps.secrets;
    if (!secrets)
      throw new SecretKeyError('GENIE_SECRET_KEY が設定されていないので、接続を保存できません。');
    const baseUrl = checkedOrigin(connection.baseUrl);
    const sealed = secrets.seal(connection.token, aadFor(owner, connection.grantId));
    const now = new Date();
    await withTenant(this.deps.db, owner.tenantId, async (tx) => {
      await tx
        .updateTable('phone_connections')
        .set({ revoked_at: now })
        .where('user_id', '=', owner.userId)
        .where('revoked_at', 'is', null)
        .execute();
      await tx
        .insertInto('phone_connections')
        .values({
          id: uuidv7(),
          tenant_id: owner.tenantId,
          user_id: owner.userId,
          base_url: baseUrl,
          grant_id: connection.grantId,
          token_ciphertext: sealed,
          created_at: now,
        })
        .execute();
      // 何を預かったか。**トークンは書かない。**
      await appendAuditEvent(tx, owner.tenantId, {
        actorType: 'user',
        actorId: owner.userId,
        action: 'phone.connected',
        externalEffect: false,
        payload: { base_url: baseUrl, grant_id: connection.grantId, key_id: secrets.keyId },
      });
    });
    return { baseUrl, grantId: connection.grantId, connectedAt: now.toISOString() };
  }

  async status(owner: PhoneOwner): Promise<PhoneConnectionStatus | null> {
    const row = await withTenant(this.deps.db, owner.tenantId, (tx) =>
      tx
        .selectFrom('phone_connections')
        .select(['base_url', 'grant_id', 'created_at'])
        .where('user_id', '=', owner.userId)
        .where('revoked_at', 'is', null)
        .executeTakeFirst(),
    );
    return row
      ? { baseUrl: row.base_url, grantId: row.grant_id, connectedAt: row.created_at.toISOString() }
      : null;
  }

  /** 資格情報ごと。**呼び出し側はトークンをログに出さない。** */
  async connection(owner: PhoneOwner): Promise<OathraConnection | null> {
    const secrets = this.deps.secrets;
    if (!secrets) return null;
    const row = await withTenant(this.deps.db, owner.tenantId, (tx) =>
      tx
        .selectFrom('phone_connections')
        .select(['base_url', 'grant_id', 'token_ciphertext'])
        .where('user_id', '=', owner.userId)
        .where('revoked_at', 'is', null)
        .executeTakeFirst(),
    );
    if (!row) return null;
    return {
      baseUrl: row.base_url,
      grantId: row.grant_id,
      token: secrets.open(row.token_ciphertext, aadFor(owner, row.grant_id)),
    };
  }

  /** 切る。行は消さず、いつ切ったかを残す。 */
  async revoke(owner: PhoneOwner): Promise<boolean> {
    return withTenant(this.deps.db, owner.tenantId, async (tx) => {
      const result = await tx
        .updateTable('phone_connections')
        .set({ revoked_at: new Date() })
        .where('user_id', '=', owner.userId)
        .where('revoked_at', 'is', null)
        .executeTakeFirst();
      const revoked = Number(result.numUpdatedRows) > 0;
      if (revoked) {
        await appendAuditEvent(tx, owner.tenantId, {
          actorType: 'user',
          actorId: owner.userId,
          action: 'phone.disconnected',
          externalEffect: false,
        });
      }
      return revoked;
    });
  }

  /** いま繋いでいる利用者。着信の取り込みが使う。identity 接続が無ければ空。 */
  async owners(): Promise<PhoneOwner[]> {
    if (!this.deps.db.identity) return [];
    const rows = await withIdentity(this.deps.db, (tx) =>
      tx
        .selectFrom('phone_connections')
        .select(['tenant_id', 'user_id'])
        .where('revoked_at', 'is', null)
        .execute(),
    );
    return rows.map((r) => ({ tenantId: r.tenant_id, userId: r.user_id }));
  }
}

/**
 * 利用者ごとの接続を引く口。DB の接続が先、無ければ開発用の環境変数（1 人分）。
 *
 * 環境変数の接続（`GENIE_OATHRA_CONNECTION_FILE` + `GENIE_OATHRA_OWNER`）は、
 * DB に鍵を置かずに手元で試すための逃がし口。その 1 人にしか効かない。
 */
export interface PhoneConnections {
  connectionFor(owner: PhoneOwner): Promise<OathraConnection | null>;
  owners(): Promise<PhoneOwner[]>;
}

export function phoneConnections(deps: {
  readonly store?: PhoneConnectionStore | null;
  readonly fallback?: PhoneSetup | null;
}): PhoneConnections {
  const store = deps.store ?? null;
  const fallback = deps.fallback ?? null;
  const isFallbackOwner = (owner: PhoneOwner) =>
    !!fallback &&
    owner.tenantId === fallback.owner.tenantId &&
    owner.userId === fallback.owner.userId;
  return {
    async connectionFor(owner) {
      const saved = store ? await store.connection(owner) : null;
      if (saved) return saved;
      return isFallbackOwner(owner) ? fallback!.connection : null;
    },
    async owners() {
      const saved = store ? await store.owners() : [];
      const all = fallback ? [...saved, fallback.owner] : saved;
      const seen = new Set<string>();
      return all.filter((o) => {
        const key = `${o.tenantId}:${o.userId}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    },
  };
}
