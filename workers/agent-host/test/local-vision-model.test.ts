import { describe, expect, it, vi } from 'vitest';
import { localVisionRuntime } from '../src/local-vision-model.js';
import { LlmRuntime } from '../src/llm-steps.js';

const model = 'qwen3.5:9b';
const endpoint = 'http://127.0.0.1:11434/v1';
const localMetadata = {
  model_info: { architecture: 'qwen35' },
  capabilities: ['completion', 'vision'],
};
function transport(metadata: unknown = localMetadata, installed = true) {
  return vi.fn<typeof globalThis.fetch>(async (url, init) => {
    expect(init?.redirect).toBe('error');
    if (String(url).endsWith('/api/show')) {
      expect(JSON.parse(String(init?.body))).toEqual({ model });
      return Response.json(metadata);
    }
    expect(String(url)).toBe(`${endpoint}/models`);
    return Response.json({ data: installed ? [{ id: model }] : [] });
  });
}

describe('independent local computer vision', () => {
  it('keeps conversation selection and grants only the installed local vision model', async () => {
    const conversation = new LlmRuntime({
      allowedKinds: ['claude_code'],
      others: [
        {
          kind: 'claude_code',
          available: true,
          credential: 'claude_code',
          reason: null,
          implementation: 'test',
        },
      ],
    });
    const fetch = transport();
    const vision = await localVisionRuntime(model, endpoint, fetch);
    expect((await conversation.options()).map((option) => option.kind)).toEqual(['claude_code']);
    expect(await vision.options()).toEqual([
      { kind: 'local', available: true, credential: 'none', reason: null, implementation: model },
    ]);
    // A caller cannot change the override into an external model through step arguments.
    const outcome = await vision.run({
      toolId: 'llm.plan_computer_action',
      args: { vision_model_kind: 'claude_code' },
    } as never);
    expect(outcome).toMatchObject({ ok: false, error: { code: 'llm.no_model' } });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it('refuses cloud aliases, remote destinations and unsupported endpoints before requests', async () => {
    const fetch = transport();
    for (const [name, url] of [
      ['qwen:cloud', endpoint],
      [model, 'https://remote.example/v1'],
      [model, 'http://user:secret@127.0.0.1:11434/v1'],
      [model, 'http://127.0.0.1:11434/other'],
    ])
      await expect(localVisionRuntime(name!, url!, fetch)).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });
  it('refuses renamed remote models, missing metadata, non-vision models and absent installations', async () => {
    for (const metadata of [
      { ...localMetadata, remote_host: 'https://ollama.com' },
      { ...localMetadata, remote_model: 'remote-model' },
      {},
      { ...localMetadata, model_info: {} },
      { ...localMetadata, capabilities: ['completion'] },
    ])
      await expect(localVisionRuntime(model, endpoint, transport(metadata))).rejects.toThrow();
    await expect(
      localVisionRuntime(model, endpoint, transport(localMetadata, false)),
    ).rejects.toThrow('unavailable');
  });
});
