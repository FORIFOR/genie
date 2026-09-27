import { describe, expect, it, vi } from 'vitest';
import { fileURLToPath } from 'node:url';
import { connectOathra, OathraClient } from '../src/oathra.js';
const id = '12345678-1234-1234-1234-123456789abc';
const input = { phone: '+819000000000', name: '架空の相手', instruction: '受付時間を確認する' };
const result = (value: unknown) => ({ content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value, isError: false });
describe('Oathra integration', () => {
  it('requires host confirmation before forwarding a draft; never calls a start tool', async () => {
    const callTool = vi.fn().mockResolvedValue(result({ apiVersion: 1, kind: 'oathra.phone-draft', missionId: id, status: 'DRAFT', dialed: false, humanReview: { required: true, missionId: id } }));
    const client = new OathraClient({ callTool, close: vi.fn() });
    await expect(client.draft(input, { approved: false })).rejects.toMatchObject({ code: 'plugin.permission_denied' });
    expect(callTool).not.toHaveBeenCalled();
    expect((await client.draft(input, { approved: true })).dialed).toBe(false);
    expect(callTool).toHaveBeenCalledExactlyOnceWith('oathra_phone_draft', input, { approved: true });
  });
  it('does not inherit retryable errors for an uncertain draft POST', async () => {
    const callTool = vi.fn().mockRejectedValue(Object.assign(new Error('lost response'), { retryable: true }));
    const client = new OathraClient({ callTool, close: vi.fn() });
    await expect(client.draft(input, { approved: true })).rejects.toMatchObject({ retryable: false });
    expect(callTool).toHaveBeenCalledTimes(1);
  });
  it('preserves incomplete and unknown instead of deriving completion from ended', async () => {
    for (const status of ['INCOMPLETE', 'UNKNOWN']) {
      const client = new OathraClient({ callTool: vi.fn().mockResolvedValue(result({ apiVersion: 1, kind: 'oathra.phone-result', missionId: id, status, state: 'ended', result: null })), close: vi.fn() });
      expect((await client.result(id)).status).toBe(status);
    }
  });
  it('refuses a response for a different mission', async () => {
    const client = new OathraClient({ callTool: vi.fn().mockResolvedValue(result({ apiVersion: 1, kind: 'oathra.phone-result', missionId: '00000000-0000-0000-0000-000000000000', status: 'COMPLETED', state: 'ended' })), close: vi.fn() });
    await expect(client.result(id)).rejects.toThrow();
  });
  it('connects through Genie\'s real MCP client and stdio channel, including initialized notification', async () => {
    const previous = process.env['UNRELATED_API_KEY']; process.env['UNRELATED_API_KEY'] = 'must-not-reach-child';
    const client = await connectOathra({ serverPath: fileURLToPath(new URL('./fixtures/oathra-server.mjs', import.meta.url)), gatewayUrl: 'http://127.0.0.1:4244', token: 'fake-local-test-token' });
    try {
      expect((await client.capabilities())['inheritedUnrelatedCredential']).toBe(false);
      expect((await client.draft(input, { approved: true })).status).toBe('DRAFT');
      expect((await client.result(id)).status).toBe('INCOMPLETE');
    } finally { await client.close(); if (previous === undefined) delete process.env['UNRELATED_API_KEY']; else process.env['UNRELATED_API_KEY'] = previous; }
  });
});
