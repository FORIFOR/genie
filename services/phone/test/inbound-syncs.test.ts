/**
 * 繋いでいる人ごとの着信の取り込み。**1 人の失敗で全員を止めない・繋ぎ直したら読み直す。**
 */
import { describe, expect, it, vi } from 'vitest';
import { InboundPhoneSyncs } from '../src/inbound.js';
import { OathraError, type OathraClient, type OathraConnection } from '../src/oathra.js';
import type { PhoneConnections } from '../src/connections.js';

const alice = { tenantId: 't-1', userId: 'alice' };
const bob = { tenantId: 't-2', userId: 'bob' };

const callFrom = (callId: string) => ({
  callId,
  finishedAt: '2026-10-18T01:00:00.000Z',
  state: 'COMPLETED',
  from: '+819000000001',
  name: '着信',
  fromOwner: true,
  reception: false,
  transcript: [{ source: 'callee' as const, text: '会議資料をまとめておいて。' }],
});

describe('InboundPhoneSyncs', () => {
  it('人ごとにその人の Oathra で読み、断られた人がいても他の人は進める', async () => {
    const connections: Record<string, OathraConnection> = {
      alice: { baseUrl: 'https://a.example', token: 'ta', grantId: 'ga' },
      bob: { baseUrl: 'https://b.example', token: 'tb', grantId: 'gb' },
    };
    const store: PhoneConnections = {
      owners: async () => [alice, bob],
      connectionFor: async (o) => connections[o.userId] ?? null,
    };
    const clients = new Map<string, OathraClient>();
    const clientOf = vi.fn((c: OathraConnection) => {
      const pages = c.grantId === 'ga' ? [{ calls: [callFrom('a1')], next: 1 }] : [];
      const client = {
        inbound: vi.fn(async () => {
          if (c.grantId === 'gb') throw new OathraError('inbound_not_delegated', 403);
          return pages.shift() ?? { calls: [], next: 1 };
        }),
      } as unknown as OathraClient;
      clients.set(c.grantId, client);
      return client;
    });
    const created: { userId: string; idempotencyKey: string }[] = [];
    const ownerRequest = vi.fn(async (_o: unknown, _c: OathraClient, text: string) => ({
      kind: 'k',
      input: { text },
    }));
    const log = vi.fn();
    const syncs = new InboundPhoneSyncs({
      connections: store,
      clientOf,
      tasks: {
        create: async (p) => {
          created.push({ userId: p.userId, idempotencyKey: p.idempotencyKey });
          return { task: { id: 'x' }, deduplicated: false };
        },
      },
      ownerRequest,
      messageRequest: (i) => ({ kind: 'k', input: { ...i } }),
      log,
    });

    expect(await syncs.syncOnce()).toEqual({
      owners: 2,
      seen: 1,
      created: 1,
      skipped: 0,
      failed: 1,
    });
    expect(created).toEqual([{ userId: 'alice', idempotencyKey: 'oathra-inbound:a1' }]);
    expect(ownerRequest.mock.calls[0]![1]).toBe(clients.get('ga'));
    expect(log).toHaveBeenCalledWith(
      'phone.inbound.sync_failed',
      expect.objectContaining({ user_id: 'bob', code: 'inbound_not_delegated' }),
    );
    // トークンはログに出ない
    expect(JSON.stringify(log.mock.calls)).not.toContain('tb');

    // 同じ接続なら同じ client を使い続け、繋ぎ直したら作り直す
    await syncs.syncOnce();
    expect(clientOf).toHaveBeenCalledTimes(2);
    connections['alice'] = { baseUrl: 'https://a.example', token: 'ta2', grantId: 'ga2' };
    await syncs.syncOnce();
    expect(clientOf).toHaveBeenCalledTimes(3);
  });
});
