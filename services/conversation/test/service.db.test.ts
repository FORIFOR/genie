/**
 * ConversationService の DB 側。正本 §7.3、Phase 7 §2。
 *   ./infra/db/with-test-db.sh pnpm --filter @genie/service-conversation test
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { COMPACTION_BATCH, RECENT_TURN_WINDOW, uuidv7 } from '@genie/contracts';
import { createDb, withIdentity, type DbHandle } from '@genie/db';
import { ConversationService } from '../src/service.js';

const url = process.env['TEST_DATABASE_URL'];
const identityUrl = process.env['TEST_IDENTITY_DATABASE_URL'];

describe.skipIf(!url)('ConversationService', () => {
  let db: DbHandle;
  let service: ConversationService;
  const tenantId = uuidv7();
  const otherTenantId = uuidv7();
  const userId = uuidv7();

  beforeAll(async () => {
    db = createDb({
      url: url!,
      identityUrl,
      maxConnections: 6,
      identityMaxConnections: 2,
      idleTimeoutMillis: 5_000,
      connectionTimeoutMillis: 5_000,
      statementTimeoutMillis: 20_000,
      applicationName: 'astra-conversation-test',
    });
    await withIdentity(db, async (tx) => {
      for (const id of [tenantId, otherTenantId]) {
        await tx.insertInto('tenants').values({ id, name: 'C', kind: 'personal' }).execute();
      }
      await tx
        .insertInto('users')
        .values({ id: userId, email: `c-${userId}@example.com`, display_name: 'C' })
        .execute();
      await tx
        .insertInto('memberships')
        .values({ tenant_id: tenantId, user_id: userId, role: 'owner' })
        .execute();
    });
    service = new ConversationService({ db });
  }, 60_000);

  afterAll(async () => {
    await db?.close();
  });

  it('starts a conversation with a state attached', async () => {
    const { id, state } = await service.start(tenantId, userId, { title: '相談' });
    expect(state.id).toBe(id);
    expect(state.response_mode).toBe('text');
    expect(state.referents).toEqual([]);
  });

  it('retains order terms through service recreation and serializes concurrent slot answers', async () => {
    const { id } = await service.start(tenantId, userId);
    const initial = await service.advanceCheckoutOrder(
      tenantId,
      userId,
      id,
      uuidv7(),
      'マックを注文して',
    );
    await service.advanceCheckoutOrder(tenantId, userId, id, uuidv7(), 'ポテトM2個');
    await service.advanceCheckoutOrder(tenantId, userId, id, uuidv7(), '注文を中断して');
    const recreated = new ConversationService({ db });
    expect((await recreated.state(tenantId, id)).checkout_draft).toMatchObject({
      status: 'paused',
      itemsText: 'ポテトM2個',
      orderKey: initial!.draft.orderKey,
    });
    await recreated.advanceCheckoutOrder(tenantId, userId, id, uuidv7(), '注文を再開して');
    await Promise.all([
      recreated.advanceCheckoutOrder(tenantId, userId, id, uuidv7(), 'できるだけ早く'),
      recreated.advanceCheckoutOrder(tenantId, userId, id, uuidv7(), '上限2000円'),
    ]);
    const draft = (await recreated.state(tenantId, id)).checkout_draft!;
    expect(draft).toMatchObject({
      requestedTime: 'asap',
      maxTotalMinor: 2000,
      itemsText: 'ポテトM2個',
      orderKey: initial!.draft.orderKey,
      status: 'collecting',
    });
    expect(draft.dispatchTurnId).not.toBeNull();
    const taskId = uuidv7();
    await recreated.markCheckoutDispatched(tenantId, userId, id, draft.orderKey, taskId);
    const repeat = await new ConversationService({ db }).advanceCheckoutOrder(
      tenantId,
      userId,
      id,
      uuidv7(),
      'マックを注文して',
    );
    expect(repeat!.prepare).toBeNull();
    expect(repeat!.taskId).toBe(taskId);
  });

  it('refuses order changes from another owner or tenant', async () => {
    const { id } = await service.start(tenantId, userId);
    await service.advanceCheckoutOrder(tenantId, userId, id, uuidv7(), 'ドミノでピザを注文して');
    await expect(
      service.advanceCheckoutOrder(tenantId, uuidv7(), id, uuidv7(), '上限1000円'),
    ).rejects.toMatchObject({ code: 'common.not_found' });
    await expect(
      service.advanceCheckoutOrder(otherTenantId, userId, id, uuidv7(), '上限1000円'),
    ).rejects.toMatchObject({ code: 'common.not_found' });
    await expect(
      service.markCheckoutDispatched(tenantId, uuidv7(), id, 'other', uuidv7()),
    ).rejects.toMatchObject({ code: 'common.not_found' });
    expect((await service.state(tenantId, id)).checkout_draft!.maxTotalMinor).toBeNull();
  });

  it('keeps voice and text in the same conversation', async () => {
    // 正本 §2: 入力様式は属性でしかない
    const { id } = await service.start(tenantId, userId);
    await service.append({
      tenantId,
      conversationId: id,
      role: 'user',
      modality: 'voice',
      text: '声で言った',
    });
    await service.append({
      tenantId,
      conversationId: id,
      role: 'user',
      modality: 'text',
      text: '打って言った',
    });
    const turns = await service.recentTurns(tenantId, id);
    expect(turns.map((t) => t.modality)).toEqual(['voice', 'text']);
  });

  it('marks an interrupted answer instead of deleting it', async () => {
    // 消すと、何が起きたか分からなくなる（D-50）
    const { id } = await service.start(tenantId, userId);
    await service.append({
      tenantId,
      conversationId: id,
      role: 'assistant',
      modality: 'text',
      text: '途中まで書いた答え',
    });

    const interrupted = await service.interruptLastAssistantTurn(tenantId, id);
    expect(interrupted?.interrupted).toBe(true);
    expect(interrupted?.text).toBe('途中まで書いた答え');

    // 二度目は何も起きない
    expect(await service.interruptLastAssistantTurn(tenantId, id)).toBeNull();
  });

  it('has nothing to interrupt when the user spoke last', async () => {
    const { id } = await service.start(tenantId, userId);
    await service.append({
      tenantId,
      conversationId: id,
      role: 'user',
      modality: 'text',
      text: 'まだ答えていない',
    });
    expect(await service.interruptLastAssistantTurn(tenantId, id)).toBeNull();
  });

  it('does not compact a conversation that is still short', async () => {
    const { id } = await service.start(tenantId, userId);
    for (let i = 0; i < 3; i += 1) {
      await service.append({
        tenantId,
        conversationId: id,
        role: 'user',
        modality: 'text',
        text: `短い ${i}`,
      });
    }
    expect(await service.compact(tenantId, id, async () => '要約')).toBeNull();
  });

  it('folds the older turns and says which ones it folded', async () => {
    // 捨てたのではなく畳んだことが分かるように残す
    const { id } = await service.start(tenantId, userId);
    const total = RECENT_TURN_WINDOW + COMPACTION_BATCH + 2;
    for (let i = 0; i < total; i += 1) {
      await service.append({
        tenantId,
        conversationId: id,
        role: i % 2 === 0 ? 'user' : 'assistant',
        modality: 'text',
        text: `turn ${i}`,
      });
    }

    const summary = await service.compact(
      tenantId,
      id,
      async (turns) => `${turns.length} 件のやりとり`,
    );
    expect(summary).not.toBeNull();
    expect(summary!.turn_count).toBe(COMPACTION_BATCH);
    expect(summary!.covers_from).toBeTruthy();
    expect(summary!.covers_to).toBeTruthy();

    const kept = await service.summaries(tenantId, id);
    expect(kept).toHaveLength(1);
  });

  it('refuses to store an empty summary', async () => {
    const { id } = await service.start(tenantId, userId);
    for (let i = 0; i < RECENT_TURN_WINDOW + COMPACTION_BATCH; i += 1) {
      await service.append({
        tenantId,
        conversationId: id,
        role: 'user',
        modality: 'text',
        text: `t${i}`,
      });
    }
    // 要約できなかったものを、空のまま残さない
    expect(await service.compact(tenantId, id, async () => '   ')).toBeNull();
  });

  it('says another tenant’s conversation does not exist', async () => {
    const { id } = await service.start(tenantId, userId);
    await expect(service.state(otherTenantId, id)).rejects.toThrow(/not found/);
    expect(await service.recentTurns(otherTenantId, id)).toEqual([]);
  });
});
