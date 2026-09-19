import type { LanguageModelKind } from '@genie/contracts';

export class HttpLlmError extends Error {
  constructor(
    readonly code:
      'output_limit' | 'empty_output' | 'timeout' | 'image_unavailable' | 'image_unsupported',
    message: string,
  ) {
    super(message);
    this.name = 'HttpLlmError';
  }
}

export interface HttpLlmImage {
  readonly mimeType: 'image/png';
  readonly data: Buffer;
}

export interface HttpLlmConfig {
  readonly kind: LanguageModelKind;
  readonly endpoint: string;
  readonly model: string;
  readonly apiKey?: string;
  readonly timeoutMs?: number;
  readonly maxOutputTokens?: number;
  readonly reasoningEffort?: 'none' | 'low' | 'medium' | 'high';
  readonly fetch?: typeof globalThis.fetch;
}

/** OpenAI互換のchat/completionsを使うAPI／ローカルサーバー用の薄い境界。 */
export class HttpLlmClient {
  readonly #config: HttpLlmConfig;
  readonly #fetch: typeof globalThis.fetch;

  constructor(config: HttpLlmConfig) {
    if (
      config.maxOutputTokens !== undefined &&
      (!Number.isInteger(config.maxOutputTokens) ||
        config.maxOutputTokens < 1 ||
        config.maxOutputTokens > 16384)
    ) {
      throw new Error('maxOutputTokens must be an integer from 1 to 16384');
    }
    if (config.kind === 'local') {
      const url = new URL(config.endpoint);
      if (
        !['localhost', '127.0.0.1', '[::1]', '::1'].includes(url.hostname) ||
        !['http:', 'https:'].includes(url.protocol) ||
        url.username ||
        url.password ||
        url.search ||
        url.hash
      ) {
        throw new Error('Local inference requires a loopback endpoint');
      }
    }
    this.#config = config;
    this.#fetch = config.fetch ?? globalThis.fetch;
  }

  async probe(): Promise<{ available: boolean; version: string | null; reason: string | null }> {
    try {
      const response = await this.#fetch(`${this.#config.endpoint.replace(/\/$/, '')}/models`, {
        headers: this.#headers(),
        redirect: 'error',
        signal: AbortSignal.timeout(this.#config.timeoutMs ?? 10_000),
      });
      if (response.ok && this.#config.kind === 'local') {
        const body = (await response.json()) as { data?: { id?: string }[] };
        const normalize = (name: string) => name.replace(/:latest$/, '');
        if (
          !body.data?.some((model) => normalize(model.id ?? '') === normalize(this.#config.model))
        )
          return {
            available: false,
            version: null,
            reason: `Local model ${this.#config.model} is not installed`,
          };
      }
      return response.ok
        ? { available: true, version: this.#config.model, reason: null }
        : {
            available: false,
            version: null,
            reason: `${this.#config.kind} endpoint returned ${response.status}`,
          };
    } catch {
      return {
        available: false,
        version: null,
        reason: `${this.#config.kind} endpoint is unavailable`,
      };
    }
  }

  async ask(
    prompt: string,
    images: readonly HttpLlmImage[] = [],
    signal?: AbortSignal,
  ): Promise<unknown> {
    const content = await this.#request(prompt, true, false, images, signal);
    try {
      return JSON.parse(content) as unknown;
    } catch {
      return content;
    }
  }

  /** A document is already text. Do not make the model JSON-escape its prose. */
  async askText(
    prompt: string,
    creative = false,
    images: readonly HttpLlmImage[] = [],
    signal?: AbortSignal,
  ): Promise<string> {
    return this.#request(prompt, false, creative, images, signal);
  }

  async #request(
    prompt: string,
    structured: boolean,
    creative = false,
    images: readonly HttpLlmImage[] = [],
    signal?: AbortSignal,
  ): Promise<string> {
    if (!prompt.trim()) throw new Error('LLM prompt is empty');
    if (
      images.length > 4 ||
      images.reduce((sum, image) => sum + image.data.length, 0) > 20 * 1024 * 1024
    )
      throw new HttpLlmError('image_unavailable', 'Image request exceeds the attachment limit');
    const response = await this.#fetch(
      `${this.#config.endpoint.replace(/\/$/, '')}/chat/completions`,
      {
        method: 'POST',
        redirect: 'error',
        headers: { ...this.#headers(), 'content-type': 'application/json' },
        body: JSON.stringify({
          model: this.#config.model,
          // Direct OpenAI uses the limit that includes reasoning tokens. Other
          // compatible servers (including Ollama) retain their max_tokens field.
          [new URL(this.#config.endpoint).hostname === 'api.openai.com'
            ? 'max_completion_tokens'
            : 'max_tokens']: this.#config.maxOutputTokens ?? 4096,
          messages: [
            {
              role: 'system',
              content: structured
                ? 'Return the requested JSON object only. Use the supplied evidence accurately; do not invent facts.'
                : '利用者が求めた本文だけを返してください。指示・ルールの復唱や自己評価は不要です。本文のみと指定されたら見出しを足さないでください。根拠が足りない問いには、不明な点と理由を短く答えてください。提供された事実と提案を区別し、事実を書き換えないでください。',
            },
            {
              role: 'user',
              content: images.length
                ? [
                    { type: 'text', text: prompt },
                    ...images.map((image) => ({
                      type: 'image_url',
                      image_url: {
                        url: `data:${image.mimeType};base64,${image.data.toString('base64')}`,
                      },
                    })),
                  ]
                : prompt,
            },
          ],
          ...(this.#config.reasoningEffort
            ? { reasoning_effort: this.#config.reasoningEffort }
            : {}),
          ...(structured ? { response_format: { type: 'json_object' } } : {}),
          ...(this.#config.kind === 'local' ? { temperature: creative ? 0.6 : 0 } : {}),
        }),
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(this.#config.timeoutMs ?? 120_000)])
          : AbortSignal.timeout(this.#config.timeoutMs ?? 120_000),
      },
    ).catch((error: unknown) => {
      if (error instanceof Error && ['TimeoutError', 'AbortError'].includes(error.name))
        throw new HttpLlmError('timeout', 'LLM request timed out');
      throw error;
    });
    if (!response.ok) {
      if (images.length && response.status === 400)
        throw new HttpLlmError('image_unsupported', 'Model rejected the image request');
      throw new Error(`${this.#config.kind} request failed (${response.status})`);
    }
    const body = (await response.json()) as {
      choices?: readonly { message?: { content?: unknown }; finish_reason?: string }[];
    };
    if (body.choices?.[0]?.finish_reason === 'length')
      throw new HttpLlmError('output_limit', 'LLM output limit reached');
    const content = body.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || !content.trim())
      throw new HttpLlmError('empty_output', 'LLM returned empty content');
    return content;
  }

  #headers(): Record<string, string> {
    return this.#config.apiKey ? { authorization: `Bearer ${this.#config.apiKey}` } : {};
  }
}
