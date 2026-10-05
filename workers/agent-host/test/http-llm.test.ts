import { describe, expect, it, vi } from 'vitest';
import { HttpLlmClient } from '../src/http-llm.js';

describe('HTTP/local LLM adapter', () => {
  it('sends image bytes as multimodal content in one bounded request', async () => {
    const data = Buffer.from('89504e470d0a1a0a', 'hex');
    const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => {
      expect(JSON.parse(String(init?.body)).messages[1].content).toEqual([
        { type: 'text', text: 'この画像を解説' },
        {
          type: 'image_url',
          image_url: { url: 'data:image/png;base64,' + data.toString('base64') },
        },
      ]);
      return Response.json({ choices: [{ message: { content: '画像の説明' } }] });
    });
    const client = new HttpLlmClient({
      kind: 'local',
      endpoint: 'http://localhost/v1',
      model: 'vision',
      fetch,
    });
    expect(await client.askText('この画像を解説', false, [{ mimeType: 'image/png', data }])).toBe(
      '画像の説明',
    );
    expect(fetch).toHaveBeenCalledTimes(1);
    await expect(
      client.askText(
        'q',
        false,
        Array.from({ length: 5 }, () => ({ mimeType: 'image/png' as const, data })),
      ),
    ).rejects.toMatchObject({ code: 'image_unavailable' });
    expect(fetch).toHaveBeenCalledTimes(1);
    fetch.mockResolvedValueOnce(new Response('{}', { status: 400 }));
    await expect(
      client.askText('q', false, [{ mimeType: 'image/png', data }]),
    ).rejects.toMatchObject({ code: 'image_unsupported' });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it('probes and sends through an OpenAI-compatible endpoint without exposing the key in the body', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      if (String(input).endsWith('/models')) return new Response('{}', { status: 200 });
      expect(init?.headers).toMatchObject({ authorization: 'Bearer secret' });
      const body = JSON.parse(String(init?.body)) as {
        model: string;
        messages: { content: string }[];
      };
      expect(body.model).toBe('local-model');
      expect(JSON.stringify(body)).not.toContain('secret');
      expect(body).toMatchObject({ response_format: { type: 'json_object' } });
      return new Response(
        JSON.stringify({ choices: [{ message: { content: '{"answer":"ok"}' } }] }),
        { status: 200 },
      );
    });
    const client = new HttpLlmClient({
      kind: 'openai_api',
      endpoint: 'http://127.0.0.1:11434/v1',
      model: 'local-model',
      apiKey: 'secret',
      fetch,
    });
    await expect(client.probe()).resolves.toMatchObject({ available: true });
    await expect(client.ask('hello')).resolves.toEqual({ answer: 'ok' });
  });
});

describe('bounded generation costs', () => {
  it('sets an output ceiling and does not retry errors or truncated generations', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => {
      expect(JSON.parse(String(init?.body)).max_tokens).toBe(4096);
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: '{"answer":"cut"}' }, finish_reason: 'length' }],
        }),
      );
    });
    const client = new HttpLlmClient({
      kind: 'openai_api',
      endpoint: 'https://example.test/v1',
      model: 'test',
      fetch,
    });
    await expect(client.ask('question')).rejects.toThrow('output limit');
    expect(fetch).toHaveBeenCalledTimes(1);
    /*
     * 429 は「使える分を使い切った」として扱う。待って掛け直せば通ることもあるが、
     * それは有料へ上がるかどうかを利用者が決める前に使い続けることになる。
     * 他の失敗はこれまでどおり、状態番号のまま上へ返す。どちらも掛け直さない。
     */
    fetch.mockResolvedValueOnce(new Response('{}', { status: 429 }));
    await expect(client.ask('question')).rejects.toMatchObject({ code: 'quota_exhausted' });
    fetch.mockResolvedValueOnce(new Response('{}', { status: 503 }));
    await expect(client.ask('question')).rejects.toThrow('503');
    expect(fetch).toHaveBeenCalledTimes(3);
    await expect(client.ask('   ')).rejects.toThrow('empty');
    expect(fetch).toHaveBeenCalledTimes(3);
  });
  it('permits a configured output budget but rejects unbounded values', async () => {
    for (const maxOutputTokens of [0, -1, NaN, Infinity, 1.5, 16385]) {
      expect(
        () =>
          new HttpLlmClient({
            kind: 'local',
            endpoint: 'http://localhost/v1',
            model: 'test',
            maxOutputTokens,
          }),
      ).toThrow();
    }
    const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => {
      expect(JSON.parse(String(init?.body)).max_tokens).toBe(512);
      return new Response(
        JSON.stringify({ choices: [{ message: { content: '{"answer":"ok"}' } }] }),
      );
    });
    await new HttpLlmClient({
      kind: 'local',
      endpoint: 'http://localhost/v1',
      model: 'test',
      maxOutputTokens: 512,
      fetch,
    }).ask('question');
  });
});

it('does not treat a remote endpoint as free local inference', () => {
  for (const endpoint of [
    'https://example.test/v1',
    'http://localhost.evil.test/v1',
    'http://u:p@localhost/v1',
  ]) {
    expect(() => new HttpLlmClient({ kind: 'local', endpoint, model: 'local' })).toThrow(
      'loopback',
    );
  }
});

it('uses the reasoning-inclusive completion limit for direct OpenAI', async () => {
  const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    expect(body.max_completion_tokens).toBe(4096);
    expect(body.max_tokens).toBeUndefined();
    return new Response(JSON.stringify({ choices: [{ message: { content: '{"answer":"ok"}' } }] }));
  });
  await new HttpLlmClient({
    kind: 'openai_api',
    endpoint: 'https://api.openai.com/v1',
    model: 'configured-model',
    fetch,
  }).ask('question');
});

it('keeps written documents as text and wraps no JSON around the model output', async () => {
  const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => {
    expect(JSON.parse(String(init?.body))).toMatchObject({ temperature: 0, max_tokens: 4096 });
    expect(JSON.parse(String(init?.body)).response_format).toBeUndefined();
    return new Response(
      JSON.stringify({
        choices: [
          { message: { content: '## 構成案\n「引用」と日本語の本文。' }, finish_reason: 'stop' },
        ],
      }),
    );
  });
  const client = new HttpLlmClient({
    kind: 'local',
    endpoint: 'http://127.0.0.1:11434/v1',
    model: 'test',
    fetch,
  });
  await expect(client.askText('構成案を作成')).resolves.toBe('## 構成案\n「引用」と日本語の本文。');
  expect(fetch).toHaveBeenCalledTimes(1);
});

it('only sets thinking effort when explicitly configured and keeps a single bounded call', async () => {
  const fetch = vi.fn<typeof globalThis.fetch>(async (_input, init) => {
    expect(JSON.parse(String(init?.body))).toMatchObject({
      reasoning_effort: 'none',
      max_tokens: 4096,
    });
    return Response.json({ choices: [{ message: { content: '本文' }, finish_reason: 'stop' }] });
  });
  const client = new HttpLlmClient({
    kind: 'local',
    endpoint: 'http://localhost:11434/v1',
    model: 'qwen3:14b',
    reasoningEffort: 'none',
    fetch,
  });
  expect(await client.askText('本文を書いて')).toBe('本文');
  expect(fetch).toHaveBeenCalledTimes(1);
});

it('does not advertise an uninstalled local model just because Ollama is running', async () => {
  const fetch = vi.fn<typeof globalThis.fetch>(async () =>
    Response.json({ data: [{ id: 'llama3.2:latest' }] }),
  );
  const existing = new HttpLlmClient({
    kind: 'local',
    endpoint: 'http://localhost:11434/v1',
    model: 'llama3.2',
    fetch,
  });
  const missing = new HttpLlmClient({
    kind: 'local',
    endpoint: 'http://localhost:11434/v1',
    model: 'not-installed',
    fetch,
  });
  expect((await existing.probe()).available).toBe(true);
  expect(await missing.probe()).toMatchObject({
    available: false,
    reason: 'Local model not-installed is not installed',
  });
});
