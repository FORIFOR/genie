import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ConnectorRuntime } from '../src/connector-steps.js';
import { apiExecutionAdapters } from '../src/execution-adapters.js';
import { mappedMcpAdapter } from '../src/execution-mcp.js';
import { PROTOCOL_VERSION } from '../../../packages/mcp/src/protocol.js';
import type { ExecutionIntent } from '../src/execution-policy.js';
import type { HostStep } from '../src/connector-steps.js';

const now = new Date('2026-09-19T00:00:00Z');
const proof: NonNullable<HostStep['approval']> = {
  approvalId: 'ap',
  operationId: 'execution.apply',
  decision: 'APPROVED',
  decidedBy: 'user',
  decidedAt: '2026-09-18T23:59:00Z',
  expiresAt: '2026-09-19T00:05:00Z',
};
const mail: ExecutionIntent = {
  operation: 'mail.draft',
  parameters: { to: ['a@example.com'], subject: '日程確認', body: 'こんにちは🌸' },
};
const event: ExecutionIntent = {
  operation: 'calendar.create',
  parameters: {
    title: '確認',
    start: '2026-09-20T10:00:00+09:00',
    end: '2026-09-20T11:00:00+09:00',
  },
};
const token = (accessToken: string) =>
  JSON.stringify({
    accessToken,
    refreshToken: 'refresh-' + accessToken,
    scopes: [],
    expiresAt: '2099-01-01T00:00:00Z',
  });
function connector(reply: (url: string, init: RequestInit) => unknown) {
  const reads: string[] = [];
  const calls: { url: string; method: string; auth: string; body: unknown }[] = [];
  const values: Record<string, string> = {
    'com.astra.gmail/gmail': token('OTHER_READ_ACCOUNT'),
    'com.astra.gmail/gmail-actions': token('DRAFT_ACCOUNT'),
    'com.astra.google-calendar/google-calendar': token('OTHER_CALENDAR_ACCOUNT'),
    'com.astra.google-calendar/google-calendar-actions': token('WRITE_CALENDAR_ACCOUNT'),
  };
  const runtime = new ConnectorRuntime({
    secrets: {
      async get(key) {
        reads.push(key);
        return values[key] ?? null;
      },
      async set() {},
      async delete() {},
    },
    credentialRefFor: (plugin, key) => 'keychain:' + plugin + '/' + key,
    grantedScopes: (plugin) =>
      plugin === 'com.astra.gmail' ? ['email.draft'] : ['calendar.write'],
    now: () => now,
    fetch: (async (url: string, init: RequestInit) => {
      calls.push({
        url,
        method: init.method ?? 'GET',
        auth: (init.headers as Record<string, string>)['authorization'] ?? '',
        body: init.body ? JSON.parse(String(init.body)) : null,
      });
      return new Response(JSON.stringify(reply(url, init)), { status: 200 });
    }) as typeof fetch,
  });
  return { runtime, reads, calls };
}
function draft(subject = '日程確認', body = 'こんにちは🌸') {
  return {
    id: 'd1',
    message: {
      id: 'm1',
      labelIds: ['DRAFT'],
      payload: {
        mimeType: 'text/plain',
        headers: [
          { name: 'To', value: 'a@example.com' },
          { name: 'Subject', value: subject },
        ],
        body: { data: Buffer.from(body).toString('base64url') },
      },
    },
  };
}
afterEach(() => vi.unstubAllGlobals());
describe('independent API readback, not write-response success', () => {
  it.each([false, true])(
    'checks Japanese draft through the same compose account (encoded=%s)',
    async (encoded) => {
      const h = connector((url, init) =>
        url.includes('?maxResults')
          ? { drafts: [] }
          : init.method === 'POST'
            ? { id: 'd1', message: { id: 'm1' } }
            : draft(
                encoded
                  ? '=?UTF-8?B?' + Buffer.from('日程確認').toString('base64') + '?='
                  : '日程確認',
              ),
      );
      const adapter = apiExecutionAdapters(h.runtime)[0]!;
      expect(await adapter.probe(mail)).toMatchObject({ route: 'api', verification: 'readback' });
      expect(h.calls.every((c) => c.method === 'GET')).toBe(true);
      expect(await adapter.execute(mail, proof, 'request')).toMatchObject({ verified: true });
      expect(h.calls.map((c) => c.method)).toEqual(['GET', 'POST', 'GET']);
      expect(h.calls.every((c) => c.auth === 'Bearer DRAFT_ACCOUNT')).toBe(true);
      expect(h.reads).not.toContain('com.astra.gmail/gmail');
      expect(h.calls[2]!.url).toContain('/drafts/d1?format=full');
    },
  );
  it('does not verify when the readback body differs', async () => {
    const h = connector((url, init) =>
      url.includes('?maxResults')
        ? { drafts: [] }
        : init.method === 'POST'
          ? { id: 'd1', verified: true }
          : draft('日程確認', 'changed'),
    );
    const adapter = apiExecutionAdapters(h.runtime)[0]!;
    expect(await adapter.execute(mail, proof, 'request')).toEqual({ verified: false });
    expect(h.calls.filter((c) => c.method === 'POST')).toHaveLength(1);
  });
  it('reads the created event independently with the exact write account and no attendees', async () => {
    const h = connector((url) =>
      url.includes('maxResults')
        ? { items: [] }
        : {
            id: 'e1',
            summary: '確認',
            start: { dateTime: '2026-09-20T01:00:00Z' },
            end: { dateTime: '2026-09-20T02:00:00Z' },
            attendees: [],
            status: 'confirmed',
          },
    );
    const adapter = apiExecutionAdapters(h.runtime)[1]!;
    expect(await adapter.probe(event)).toMatchObject({ verification: 'readback' });
    expect(await adapter.execute(event, proof, 'request')).toMatchObject({ verified: true });
    expect(h.calls.map((c) => c.method)).toEqual(['GET', 'POST', 'GET']);
    expect(h.calls.every((c) => c.auth === 'Bearer WRITE_CALENDAR_ACCOUNT')).toBe(true);
    expect(h.calls[1]!.url).toContain('sendUpdates=none');
    expect(h.calls[1]!.body).not.toHaveProperty('attendees');
    expect(h.reads).not.toContain('com.astra.google-calendar/google-calendar');
  });
  it('does not verify changed dates or added attendees', async () => {
    const h = connector((_url, init) => ({
      id: 'e1',
      summary: '確認',
      start: { dateTime: '2026-09-20T01:00:00Z' },
      end: { dateTime: '2026-09-20T02:00:00Z' },
      attendees: init.method === 'POST' ? [] : [{ email: 'other@example.com' }],
      status: 'confirmed',
    }));
    expect(await apiExecutionAdapters(h.runtime)[1]!.execute(event, proof, 'request')).toEqual({
      verified: false,
    });
  });
});

describe('mapped MCP execution through the real client', () => {
  it('probes without calling tools, then writes once and calls a distinct readback tool', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'genie-mcp-'));
    const path = join(directory, 'config.json');
    const calls: { method: string; params: Record<string, unknown> }[] = [];
    const config = {
      trusted: true,
      label: 'Test drafts',
      server: {
        id: 'test',
        transport: 'http',
        url: 'http://127.0.0.1:9999/mcp',
        tool_risks: { make_draft: 'EXTERNAL_COMMIT', read_draft: 'READ' },
      },
      bindings: [{ operation: 'mail.draft', writeTool: 'make_draft', readTool: 'read_draft' }],
    };
    await writeFile(path, JSON.stringify(config), { mode: 0o600 });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: unknown, init: RequestInit) => {
        expect(init.redirect).toBe('error');
        const q = JSON.parse(String(init.body));
        calls.push(q);
        const result =
          q.method === 'initialize'
            ? {
                protocolVersion: PROTOCOL_VERSION,
                capabilities: {},
                serverInfo: { name: 'fixture', version: '1' },
              }
            : q.method === 'tools/list'
              ? { tools: [{ name: 'make_draft' }, { name: 'read_draft' }, { name: 'send_mail' }] }
              : q.params.name === 'make_draft'
                ? { content: [], structuredContent: { id: 'd1', verified: true } }
                : { content: [], structuredContent: { id: 'd1', ...mail.parameters, draft: true } };
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: q.id, result }), { status: 200 });
      }),
    );
    try {
      const adapter = mappedMcpAdapter(path);
      expect(await adapter.probe(mail)).toMatchObject({ route: 'mcp', verification: 'readback' });
      expect(calls.some((c) => c.method === 'tools/call')).toBe(false);
      expect(await adapter.execute(mail, proof, 'request')).toMatchObject({ verified: true });
      expect(calls.filter((c) => c.method === 'tools/call').map((c) => c.params['name'])).toEqual([
        'make_draft',
        'read_draft',
      ]);
      await chmod(path, 0o666);
      await expect(adapter.probe(mail)).rejects.toThrow('user-owned');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  it('does not grant write permission from server hints or an untrusted config', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'genie-mcp-'));
    const path = join(directory, 'config.json');
    await writeFile(path, JSON.stringify({ trusted: false }), { mode: 0o600 });
    try {
      await expect(mappedMcpAdapter(path).probe(mail)).rejects.toThrow('trust');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
