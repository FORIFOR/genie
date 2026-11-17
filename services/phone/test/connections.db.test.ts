/**
 * 利用者ごとの電話の接続（phone_connections）。
 *   ./infra/db/with-test-db.sh pnpm --filter @genie/service-phone test
 *
 * 見ること: 1 人 1 つ・繋ぎ直しで古いものは切れる・トークンは封じて置かれる・
 * ほかのテナントからは見えない・identity からは「だれが繋いでいるか」しか読めない。
 */
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { uuidv7 } from '@genie/contracts';
import { createDb, withIdentity, withTenant, type DbHandle } from '@genie/db';
import { PhoneConnectionStore, phoneConnections } from '../src/connections.js';
import { secretBox } from '../src/secret.js';

const url = process.env['TEST_DATABASE_URL'];
const identityUrl = process.env['TEST_IDENTITY_DATABASE_URL'];

describe.skipIf(!url)('PhoneConnectionStore', () => {
  let db: DbHandle;
  const tenantId = uuidv7();
  const otherTenantId = uuidv7();
  const userId = uuidv7();
  const otherUserId = uuidv7();
  const box = secretBox(randomBytes(32).toString('hex'));
  const owner = () => ({ tenantId, userId });
  const connection = (grantId: string) => ({
    baseUrl: 'https://oathra.example',
    token: `agent-token-${grantId}-0123456789`,
    grantId,
  });

  beforeAll(async () => {
    db = createDb({
      url: url!,
      identityUrl,
      maxConnections: 4,
      identityMaxConnections: 2,
      idleTimeoutMillis: 5_000,
      connectionTimeoutMillis: 5_000,
      statementTimeoutMillis: 20_000,
      applicationName: 'astra-phone-test',
    });
    await withIdentity(db, async (tx) => {
      for (const id of [tenantId, otherTenantId]) {
        await tx.insertInto('tenants').values({ id, name: 'P', kind: 'personal' }).execute();
      }
      for (const id of [userId, otherUserId]) {
        await tx
          .insertInto('users')
          .values({ id, email: `p-${id}@example.com`, display_name: 'P' })
          .execute();
      }
    });
  });

  afterAll(async () => {
    await db?.close();
  });

  it('預かったトークンは封じて置かれ、本人のテナントでだけ開ける', async () => {
    const store = new PhoneConnectionStore({ db, secrets: box });
    const saved = await store.save(owner(), connection('g-1'));
    expect(saved).toMatchObject({ baseUrl: 'https://oathra.example', grantId: 'g-1' });
    expect(await store.connection(owner())).toEqual(connection('g-1'));

    const raw = await withTenant(db, tenantId, (tx) =>
      tx
        .selectFrom('phone_connections')
        .select('token_ciphertext')
        .where('user_id', '=', userId)
        .execute(),
    );
    expect(raw).toHaveLength(1);
    expect(raw[0]!.token_ciphertext).not.toContain('agent-token');

    // ほかのテナントからは見えない
    expect(await store.connection({ tenantId: otherTenantId, userId })).toBeNull();
  });

  it('繋ぎ直すと古い接続は切れ、有効なのは 1 つだけ', async () => {
    const store = new PhoneConnectionStore({ db, secrets: box });
    await store.save(owner(), connection('g-2'));
    expect((await store.status(owner()))?.grantId).toBe('g-2');
    const rows = await withTenant(db, tenantId, (tx) =>
      tx
        .selectFrom('phone_connections')
        .select(['grant_id', 'revoked_at'])
        .where('user_id', '=', userId)
        .execute(),
    );
    expect(rows.filter((r) => r.revoked_at === null).map((r) => r.grant_id)).toEqual(['g-2']);
    const audits = await withTenant(db, tenantId, (tx) =>
      tx
        .selectFrom('audit_events')
        .select(['action', 'payload'])
        .where('action', '=', 'phone.connected')
        .execute(),
    );
    expect(audits.length).toBeGreaterThanOrEqual(2);
    expect(JSON.stringify(audits)).not.toContain('agent-token');
  });

  it('鍵が無ければ保存せず、読めない', async () => {
    const store = new PhoneConnectionStore({ db, secrets: null });
    expect(store.canStore).toBe(false);
    await expect(store.save(owner(), connection('g-3'))).rejects.toThrow(/GENIE_SECRET_KEY/);
    expect(await store.connection(owner())).toBeNull();
  });

  it('identity からは、だれが繋いでいるかだけが分かる（トークンの列は読めない）', async () => {
    const store = new PhoneConnectionStore({ db, secrets: box });
    await store.save({ tenantId: otherTenantId, userId: otherUserId }, connection('g-9'));
    const owners = await store.owners();
    expect(owners).toEqual(
      expect.arrayContaining([
        { tenantId, userId },
        { tenantId: otherTenantId, userId: otherUserId },
      ]),
    );
    await expect(
      withIdentity(db, (tx) => sql`select token_ciphertext from phone_connections`.execute(tx)),
    ).rejects.toThrow(/permission denied/);
  });

  it('切ったら使えない。環境変数の接続は、その 1 人にだけ残る', async () => {
    const store = new PhoneConnectionStore({ db, secrets: box });
    expect(await store.revoke(owner())).toBe(true);
    expect(await store.revoke(owner())).toBe(false);
    expect(await store.status(owner())).toBeNull();

    const fallback = { owner: owner(), connection: connection('env') };
    const connections = phoneConnections({ store, fallback });
    expect(await connections.connectionFor(owner())).toEqual(connection('env'));
    expect(await connections.connectionFor({ tenantId, userId: otherUserId })).toBeNull();
  });
});
