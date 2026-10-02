import { describe, expect, it, vi } from 'vitest';
import { httpStepTransport } from '../src/step-transport.js';

describe('host execution authority transport', () => {
  it('carries unknown order identity through the failure endpoint', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(null, { status: 204 }));
    const transport = httpStepTransport({ baseUrl: 'https://genie.test', token: 'test', fetch });
    const result = {
      status: 'unknown',
      provider: 'fixture',
      mode: 'simulation',
      account: 'account',
      orderKey: 'order-1',
      quoteHash: 'a'.repeat(64),
    };
    await transport.fail(
      'req-1',
      'host-1',
      { code: 'transaction.result_unknown', message: '照会してください。' },
      result,
    );
    expect(fetch.mock.calls[0]?.[0]).toBe('https://genie.test/v1/host-steps/req-1/fail');
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toMatchObject({
      result,
      error: { code: 'transaction.result_unknown' },
    });
  });

  it('sends authenticated host/request identity and carries the abort signal', async () => {
    const signal = new AbortController().signal;
    const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json({ allowed: false }));
    const transport = httpStepTransport({ baseUrl: 'https://genie.test', token: 'test', fetch });
    expect(await transport.executionAllowed!('req-1', 'host-1', signal)).toBe(false);
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe('https://genie.test/v1/host-steps/req-1/authority');
    expect(init?.headers).toMatchObject({ authorization: 'Bearer test' });
    expect(JSON.parse(String(init?.body))).toEqual({ host_id: 'host-1' });
    expect(init?.signal).toBe(signal);
  });

  it('never interprets malformed responses or an old endpoint as permission', async () => {
    for (const response of [
      Response.json({}),
      Response.json({ allowed: 'true' }),
      new Response(null, { status: 204 }),
      new Response('not found', { status: 404 }),
    ]) {
      const transport = httpStepTransport({
        baseUrl: 'https://genie.test',
        token: 'test',
        fetch: async () => response,
      });
      await expect(transport.executionAllowed!('req-1', 'host-1')).rejects.toThrow();
    }
  });
});
