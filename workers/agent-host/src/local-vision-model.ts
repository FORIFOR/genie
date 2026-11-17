import { HttpLlmClient } from './http-llm.js';
import { LlmRuntime } from './llm-steps.js';

/** Explicit local-only computer vision. Conversation selection is never changed. */
export async function localVisionRuntime(
  model: string,
  endpoint: string,
  fetch: typeof globalThis.fetch = globalThis.fetch,
): Promise<LlmRuntime> {
  if (
    !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,159}$/.test(model) ||
    /(?:^|[:/_-])cloud(?:$|[:/_-])/i.test(model)
  )
    throw new Error('Computer vision requires an installed local Ollama model');
  // The client enforces loopback, no URL credentials, and no redirect following.
  const client = new HttpLlmClient({
    kind: 'local',
    endpoint,
    model,
    reasoningEffort: 'none',
    fetch,
  });
  const url = new URL(endpoint);
  if (url.pathname.replace(/\/$/, '') !== '/v1')
    throw new Error('Computer vision requires the local Ollama /v1 endpoint');
  const response = await fetch(`${url.origin}/api/show`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model }),
    redirect: 'error',
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error('Local computer vision metadata is unavailable');
  const metadata = (await response.json()) as {
    remote_host?: unknown;
    remote_model?: unknown;
    model_info?: Record<string, unknown>;
    capabilities?: unknown;
  };
  if (
    !metadata ||
    metadata.remote_host ||
    metadata.remote_model ||
    !metadata.model_info ||
    !Object.keys(metadata.model_info).length ||
    !Array.isArray(metadata.capabilities) ||
    !metadata.capabilities.includes('vision')
  )
    throw new Error('Computer vision requires verified local Ollama vision capability');
  const runtime = new LlmRuntime({ allowedKinds: ['local'], http: { local: client } });
  if (!(await runtime.options()).some((option) => option.kind === 'local' && option.available))
    throw new Error('The selected local computer vision model is unavailable');
  return runtime;
}
