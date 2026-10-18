/**
 * Oathra への口。実際の Gateway は叩かない。
 */
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { OathraError, checkedOrigin, oathraClient, phoneSetupFromEnv } from '../src/oathra.js';

const connection = { baseUrl: 'https://oathra.example', token: 'agent-token', grantId: 'g-1' };

describe('oathraClient', () => {
  it('委任の API を、bearer と idempotency key 付きで呼ぶ', async () => {
    const fetchImpl = vi.fn(
      async (_url: string, _init?: RequestInit) =>
        new Response(JSON.stringify({ state: 'QUEUED' }), { status: 202 }),
    );
    const client = oathraClient(connection, fetchImpl as unknown as typeof fetch);
    await client.sales({ contactId: 'c1', request: '案内', goal: 'materials' }, 'genie-task-0');
    const [url, init] = fetchImpl.mock.calls[0]! as [string, RequestInit];
    expect(url).toBe('https://oathra.example/v1/agent/sales/calls');
    expect(init.method).toBe('POST');
    expect(init.redirect).toBe('error');
    expect(init.headers).toMatchObject({
      authorization: 'Bearer agent-token',
      'idempotency-key': 'genie-task-0',
    });
    expect(JSON.parse(String(init.body))).toEqual({
      grantId: 'g-1',
      sales: { contactId: 'c1', request: '案内', goal: 'materials' },
    });

    await client.inbound(42);
    expect(fetchImpl.mock.calls[1]![0]).toBe(
      'https://oathra.example/v1/agent/phone/inbound?grantId=g-1&after=42',
    );
  });

  it('断られたら、向こうのコードのまま投げる', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: 'recipient_not_delegated' }), { status: 403 }),
    );
    const client = oathraClient(connection, fetchImpl as unknown as typeof fetch);
    await expect(
      client.call({ phone: '090', name: 'x', instruction: 'y' }, 'genie-task-0'),
    ).rejects.toMatchObject(new OathraError('recipient_not_delegated', 403));
  });

  it('不正な operation key は送らない', async () => {
    const fetchImpl = vi.fn();
    const client = oathraClient(connection, fetchImpl as unknown as typeof fetch);
    await expect(
      client.call({ phone: '090', name: 'x', instruction: 'y' }, 'short'),
    ).rejects.toThrow(TypeError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('checkedOrigin', () => {
  it('HTTPS の origin と loopback の HTTP だけ', () => {
    expect(checkedOrigin('https://oathra.example/')).toBe('https://oathra.example');
    expect(checkedOrigin('http://127.0.0.1:4244')).toBe('http://127.0.0.1:4244');
    for (const bad of [
      'http://oathra.example',
      'https://u:p@oathra.example',
      'https://oathra.example/v1',
      'https://oathra.example/?a=1',
    ]) {
      expect(() => checkedOrigin(bad)).toThrow(TypeError);
    }
  });
});

describe('phoneSetupFromEnv', () => {
  const tenant = '0190a5f0-0000-7000-8000-000000000001';
  const user = '0190a5f0-0000-7000-8000-000000000002';
  const file = (mode: number) => {
    const path = join(mkdtempSync(join(tmpdir(), 'genie-phone-')), 'connection.json');
    writeFileSync(path, JSON.stringify(connection));
    chmodSync(path, mode);
    return path;
  };

  it('どちらも無ければ null、片方だけなら設定の間違い', () => {
    expect(phoneSetupFromEnv({})).toBeNull();
    expect(() => phoneSetupFromEnv({ GENIE_OATHRA_OWNER: `${tenant}:${user}` })).toThrow();
    expect(() => phoneSetupFromEnv({ GENIE_OATHRA_CONNECTION_FILE: file(0o600) })).toThrow();
  });

  it('0600 の接続ファイルと持ち主を読む', () => {
    expect(
      phoneSetupFromEnv({
        GENIE_OATHRA_CONNECTION_FILE: file(0o600),
        GENIE_OATHRA_OWNER: `${tenant}:${user}`,
      }),
    ).toEqual({ connection, owner: { tenantId: tenant, userId: user } });
  });

  it.skipIf(process.platform === 'win32')('他人が読める接続ファイルは断る', () => {
    expect(() =>
      phoneSetupFromEnv({
        GENIE_OATHRA_CONNECTION_FILE: file(0o644),
        GENIE_OATHRA_OWNER: `${tenant}:${user}`,
      }),
    ).toThrow(/chmod 600/);
  });

  it('持ち主は <tenantId>:<userId> の UUID', () => {
    expect(() =>
      phoneSetupFromEnv({ GENIE_OATHRA_CONNECTION_FILE: file(0o600), GENIE_OATHRA_OWNER: 'alice' }),
    ).toThrow(/UUID/);
  });
});
