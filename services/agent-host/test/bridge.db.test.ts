/**
 * 手元でしか動かせない step の受け渡し。正本 §4.4・§16.1・§21。
 *
 *   ./infra/db/with-test-db.sh pnpm --filter @genie/service-agent-host test
 *
 * 見るのは 4 つ:
 *   - 同じ step を二度置かない
 *   - 資格情報を運ばない
 *   - 失敗を成功にしない
 *   - 取りに来ないものを、やってみて駄目だったことにしない
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { uuidv7 } from '@genie/contracts';
import { createDb, withIdentity, withTenant, type DbHandle } from '@genie/db';
import { AgentHostService } from '../src/service.js';
import { HostBridge } from '../src/bridge.js';

const url = process.env['TEST_DATABASE_URL'];
const identityUrl = process.env['TEST_IDENTITY_DATABASE_URL'];

describe.skipIf(!url)('the host bridge', () => {
  let db: DbHandle;
  let hosts: AgentHostService;
  let bridge: HostBridge;
  let clock = Date.parse('2026-08-27T12:00:00.000Z');

  const tenantId = uuidv7();
  const userId = uuidv7();
  let hostId = '';
  let otherHostId = '';

  const now = (): Date => new Date(clock);

  const makeTask = async (): Promise<string> => {
    const taskId = uuidv7();
    await withTenant(db, tenantId, (tx) =>
      tx
        .insertInto('tasks')
        .values({
          id: taskId,
          tenant_id: tenantId,
          created_by: userId,
          conversation_id: null,
          kind: 'research',
          title: 'テスト',
          status: 'RUNNING',
          input: JSON.stringify({}),
          idempotency_key: `k-${taskId}`,
          workflow_id: `wf-${taskId}`,
        })
        .execute(),
    );
    return taskId;
  };

  beforeAll(async () => {
    db = createDb({
      url: url!,
      identityUrl,
      maxConnections: 8,
      identityMaxConnections: 2,
      idleTimeoutMillis: 5_000,
      connectionTimeoutMillis: 5_000,
      statementTimeoutMillis: 20_000,
      applicationName: 'astra-bridge-test',
    });

    await withIdentity(db, async (tx) => {
      await tx
        .insertInto('tenants')
        .values({ id: tenantId, name: 'bridge-test', kind: 'personal' })
        .onConflict((oc) => oc.doNothing())
        .execute();
      await tx
        .insertInto('users')
        .values({ id: userId, email: `bridge-${userId}@example.com`, display_name: '橋渡し試験' })
        .onConflict((oc) => oc.doNothing())
        .execute();
      await tx
        .insertInto('memberships')
        .values({ tenant_id: tenantId, user_id: userId, role: 'owner' })
        .onConflict((oc) => oc.doNothing())
        .execute();
    });

    hosts = new AgentHostService({ db, now });
    bridge = new HostBridge({ db, now, requestTtlMs: 60_000 });
  }, 120_000);

  beforeEach(async () => {
    clock = Date.parse('2026-08-27T12:00:00.000Z');
    await withTenant(db, tenantId, (tx) => tx.deleteFrom('host_step_requests').execute());
    hostId = (
      await hosts.heartbeat({ tenantId, userId, deviceLabel: 'macbook', models: ['claude_code'] })
    ).id;
    otherHostId = (
      await hosts.heartbeat({ tenantId, userId, deviceLabel: 'other-mac', models: ['claude_code'] })
    ).id;
  });

  afterAll(async () => {
    await db?.close();
  });

  it('pins execution.apply to the device holding the immutable prepared plan', async () => {
    const taskId = await makeTask();
    const request = await bridge.request({
      tenantId,
      taskId,
      stepIndex: 1,
      toolId: 'execution.apply',
      args: { prepared: { deviceId: hostId } },
    });
    expect(await bridge.claimNext({ tenantId, hostId: otherHostId })).toBeNull();
    expect((await bridge.claimNext({ tenantId, hostId }))?.id).toBe(request.id);
  });

  it('does not claim an execution.apply request with no pinned device', async () => {
    await bridge.request({
      tenantId,
      taskId: await makeTask(),
      stepIndex: 1,
      toolId: 'execution.apply',
      args: { prepared: {} },
    });
    expect(await bridge.claimNext({ tenantId, hostId })).toBeNull();
  });

  it('does not prepare another member execution on this account', async () => {
    const otherUser = uuidv7();
    await withIdentity(db, async (tx) => {
      await tx
        .insertInto('users')
        .values({ id: otherUser, email: `other-${otherUser}@example.com`, display_name: 'Other' })
        .execute();
      await tx
        .insertInto('memberships')
        .values({ tenant_id: tenantId, user_id: otherUser, role: 'member' })
        .execute();
    });
    const taskId = await makeTask();
    await withTenant(db, tenantId, (tx) =>
      tx.updateTable('tasks').set({ created_by: otherUser }).where('id', '=', taskId).execute(),
    );
    await bridge.request({
      tenantId,
      taskId,
      stepIndex: 0,
      toolId: 'execution.prepare',
      args: { goal: 'a task' },
    });
    expect(await bridge.claimNext({ tenantId, hostId })).toBeNull();
  });

  it('says a device is there while it keeps answering', async () => {
    expect(await bridge.hasOnlineHost(tenantId, userId)).toBe(true);
    // 90 秒応答が無ければ、居ないものとして扱う
    clock += 200_000;
    expect(await bridge.hasOnlineHost(tenantId, userId)).toBe(false);
  });

  it('does not hand work to a device that has no model', async () => {
    const empty = uuidv7();
    await withIdentity(db, (tx) =>
      tx
        .insertInto('tenants')
        .values({ id: empty, name: 'empty', kind: 'personal' })
        .onConflict((oc) => oc.doNothing())
        .execute(),
    );
    await hosts.heartbeat({ tenantId, userId, deviceLabel: 'macbook', models: [] });
    await hosts.heartbeat({ tenantId, userId, deviceLabel: 'other-mac', models: [] });
    expect(await bridge.hasOnlineHost(tenantId, userId)).toBe(false);
  });

  it('places one request per step, however many times it is asked', async () => {
    const taskId = await makeTask();
    const first = await bridge.request({
      tenantId,
      taskId,
      stepIndex: 0,
      toolId: 'mail.send',
      args: { to: 'a@example.com' },
    });
    const again = await bridge.request({
      tenantId,
      taskId,
      stepIndex: 0,
      toolId: 'mail.send',
      args: { to: 'a@example.com' },
    });
    // activity の再試行で送信が積み上がらないこと
    expect(again.id).toBe(first.id);
    const rows = await withTenant(db, tenantId, (tx) =>
      tx.selectFrom('host_step_requests').selectAll().where('task_id', '=', taskId).execute(),
    );
    expect(rows).toHaveLength(1);
  });

  it('refuses to carry a credential to the device', async () => {
    const taskId = await makeTask();
    await expect(
      bridge.request({
        tenantId,
        taskId,
        stepIndex: 0,
        toolId: 'mail.send',
        args: {
          token: 'ya29.a0AfH6SMBxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
        },
      }),
    ).rejects.toMatchObject({ code: 'common.validation_failed' });
  });

  it('lets a long email body through', async () => {
    /*
     * 参照の検査（200 文字超は値そのもの）を任意の引数へ当てていた間、
     * **長い本文のメールは端末へ渡せず、送れなかった。**
     * メール本文も、agent の指示書も、検索の抜粋も 200 文字を超える。
     */
    const taskId = await makeTask();
    const placed = await bridge.request({
      tenantId,
      taskId,
      stepIndex: 0,
      toolId: 'mail.draft.create',
      args: { to: ['a@example.com'], subject: '週次報告', body: 'あ'.repeat(3000) },
    });
    expect(placed.status).toBe('PENDING');
  });

  it('refuses anything in a field named like a secret, however short', async () => {
    // 形で見分けられない秘密もある。名前の側からも見る。
    const taskId = await makeTask();
    for (const args of [
      { api_key: 'short' },
      { password: 'x' },
      { authorization: 'Basic abc' },
      { nested: { access_token: 'x' } },
    ]) {
      await expect(
        bridge.request({ tenantId, taskId, stepIndex: 1, toolId: 'mail.send', args }),
      ).rejects.toMatchObject({ code: 'common.validation_failed' });
    }
  });

  it('finds a credential hiding inside a list', async () => {
    const taskId = await makeTask();
    await expect(
      bridge.request({
        tenantId,
        taskId,
        stepIndex: 2,
        toolId: 'mail.send',
        args: { notes: ['ふつうの文', 'ghp_0123456789abcdefghijklmnopqrstuvwxyz'] },
      }),
    ).rejects.toMatchObject({ code: 'common.validation_failed' });
  });

  it('refuses a credential buried inside a nested argument', async () => {
    const taskId = await makeTask();
    await expect(
      bridge.request({
        tenantId,
        taskId,
        stepIndex: 0,
        toolId: 'mail.send',
        args: {
          message: {
            auth: {
              bearer: 'ya29.a0AfH6SMBxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
            },
          },
        },
      }),
    ).rejects.toMatchObject({ code: 'common.validation_failed' });
  });

  it('gives one step to exactly one device', async () => {
    const taskId = await makeTask();
    await bridge.request({ tenantId, taskId, stepIndex: 0, toolId: 'mail.send', args: {} });

    const [a, b] = await Promise.all([
      bridge.claimNext({ tenantId, hostId }),
      bridge.claimNext({ tenantId, hostId: otherHostId }),
    ]);

    const taken = [a, b].filter(Boolean);
    expect(taken).toHaveLength(1);
    expect(taken[0]!.status).toBe('CLAIMED');
  });

  it('hands back nothing when there is nothing to do', async () => {
    expect(await bridge.claimNext({ tenantId, hostId })).toBeNull();
  });

  it('takes the result only from the device that claimed the step', async () => {
    const taskId = await makeTask();
    const request = await bridge.request({
      tenantId,
      taskId,
      stepIndex: 0,
      toolId: 'mail.send',
      args: {},
    });
    const claimed = await bridge.claimNext({ tenantId, hostId });

    await expect(
      bridge.complete({
        tenantId,
        requestId: request.id,
        hostId: claimed!.hostId === hostId ? otherHostId : hostId,
        result: { sent: true },
      }),
    ).rejects.toMatchObject({ code: 'common.conflict' });

    await bridge.complete({
      tenantId,
      requestId: request.id,
      hostId: claimed!.hostId!,
      result: { messageId: 'm1' },
    });
    const settled = await bridge.get(tenantId, request.id);
    expect(settled).toMatchObject({ status: 'DONE', result: { messageId: 'm1' } });
  });

  it('will not settle the same step twice', async () => {
    const taskId = await makeTask();
    const request = await bridge.request({
      tenantId,
      taskId,
      stepIndex: 0,
      toolId: 'mail.send',
      args: {},
    });
    const claimed = await bridge.claimNext({ tenantId, hostId });
    await bridge.complete({
      tenantId,
      requestId: request.id,
      hostId: claimed!.hostId!,
      result: { messageId: 'm1' },
    });

    // 再接続した端末が古い結果を投げ直しても、確定したものは動かない
    await expect(
      bridge.complete({
        tenantId,
        requestId: request.id,
        hostId: claimed!.hostId!,
        result: { messageId: 'DUPLICATE' },
      }),
    ).rejects.toMatchObject({ code: 'common.conflict' });
    expect((await bridge.get(tenantId, request.id))!.result).toMatchObject({ messageId: 'm1' });
  });

  it('keeps a failure a failure', async () => {
    const taskId = await makeTask();
    const request = await bridge.request({
      tenantId,
      taskId,
      stepIndex: 0,
      toolId: 'mail.send',
      args: {},
    });
    const claimed = await bridge.claimNext({ tenantId, hostId });
    await bridge.fail({
      tenantId,
      requestId: request.id,
      hostId: claimed!.hostId!,
      error: { code: 'connector.insufficient_scope', message: '必要な許可が足りません。' },
    });

    const settled = await bridge.get(tenantId, request.id);
    expect(settled!.status).toBe('FAILED');
    expect(settled!.result).toBeNull();
    expect(settled!.error).toMatchObject({ code: 'connector.insufficient_scope' });
  });

  it('lets a step whose result is null still count as done', async () => {
    const taskId = await makeTask();
    const request = await bridge.request({
      tenantId,
      taskId,
      stepIndex: 0,
      toolId: 'mail.trash',
      args: {},
    });
    const claimed = await bridge.claimNext({ tenantId, hostId });
    // trash は何も返さない。DONE なのに結果欄が空、で制約に落ちないこと
    await bridge.complete({
      tenantId,
      requestId: request.id,
      hostId: claimed!.hostId!,
      result: undefined,
    });
    expect((await bridge.get(tenantId, request.id))!.status).toBe('DONE');
  });

  it('does not call an unclaimed step a failure when it simply went stale', async () => {
    const taskId = await makeTask();
    const request = await bridge.request({
      tenantId,
      taskId,
      stepIndex: 0,
      toolId: 'mail.send',
      args: {},
    });

    clock += 30_000;
    expect(await bridge.expireStale(tenantId)).toEqual([]);

    clock += 60_000;
    expect(await bridge.expireStale(tenantId)).toEqual([request.id]);
    // 失敗として残さない。端末が取りに来なかっただけで、送ってみて駄目だったのではない
    expect(await bridge.get(tenantId, request.id)).toBeNull();
  });

  it('does not hand out a step that already went stale', async () => {
    const taskId = await makeTask();
    await bridge.request({ tenantId, taskId, stepIndex: 0, toolId: 'mail.send', args: {} });
    clock += 90_000;
    expect(await bridge.claimNext({ tenantId, hostId })).toBeNull();
  });
});
