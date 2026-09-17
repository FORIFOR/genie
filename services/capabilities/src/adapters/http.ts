import type { CapabilityExecutionContext } from '../protocol.js';

export function normalizeBaseUrl(value: string, allowRemote = false): string {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Capability endpoint must use http or https');
  if (url.username || url.password || url.search || url.hash) throw new Error('Capability endpoint must not contain credentials, query or fragment');
  const loopback = url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '::1';
  if (!allowRemote && !loopback) throw new Error('Remote capability endpoints require allowRemote=true');
  return url.href.replace(/\/$/, '');
}

export async function jsonRequest<T>(
  context: CapabilityExecutionContext,
  url: string,
  init: RequestInit,
  headers: Readonly<Record<string, string>> = {},
): Promise<T> {
  const requestInit: RequestInit = {
    ...init,
    headers: {
      accept: 'application/json',
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...headers,
      ...(init.headers ?? {}),
    },
  };
  if (context.signal) requestInit.signal = context.signal;
  const response = await context.fetch(url, requestInit);
  const text = await response.text();
  let body: unknown = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  if (!response.ok) {
    // Do not copy arbitrary upstream error text into the Evidence Envelope returned
    // by Genie. The upstream body can contain implementation details or secrets.
    const target = new URL(url);
    throw new Error(`Capability endpoint returned HTTP ${response.status} for ${target.pathname}`);
  }
  return body as T;
}

export async function wait(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return;
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    const onAbort = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error('Capability execution aborted'));
    };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
  });
}
