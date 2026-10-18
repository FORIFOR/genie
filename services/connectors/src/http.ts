/**
 * 接続先への呼び出し。正本 §2.4・§21。
 *
 * **トークンはここを通らない。**端末が持っていて、呼ぶ直前に渡す。
 * サーバは参照しか持たない（`ConnectionService` が値を弾く）。
 */

/** 接続先が返す失敗。**種類で扱う。** */
export const CONNECTOR_FAILURES = [
  'not_connected',
  'token_expired',
  'permission_denied',
  'insufficient_scope',
  'rate_limited',
  'not_found',
  'timed_out',
  'provider_error',
] as const;
export type ConnectorFailure = (typeof CONNECTOR_FAILURES)[number];

export class ConnectorError extends Error {
  readonly reason: ConnectorFailure;
  constructor(reason: ConnectorFailure, message: string) {
    super(message);
    this.name = 'ConnectorError';
    this.reason = reason;
  }
}

/** 何をすれば直るか。§21。 */
export const CONNECTOR_RECOVERY: Readonly<Record<ConnectorFailure, string>> = {
  not_connected: 'このサービスにまだ接続していません。',
  token_expired: '接続の有効期限が切れました。つなぎ直してください。',
  permission_denied: 'このサービスを使う権限がありません。',
  insufficient_scope: '必要な許可が足りません。接続をやり直して許可してください。',
  rate_limited: '接続先が混み合っています。少し待って試してください。',
  not_found: '見つかりませんでした。',
  timed_out: '接続先が時間内に返りませんでした。',
  provider_error: '接続先で問題が起きました。',
};

/** access token を返す先。**端末が持っている。** */
export type TokenSource = () => Promise<string>;

export interface CallConfig {
  readonly token: TokenSource;
  readonly fetch?: typeof globalThis.fetch;
  readonly timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 15_000;

/** HTTP の状態を、扱える種類へ写す。 */
export function failureFor(
  status: number,
  message: string,
  providerReasons: readonly string[] = [],
): ConnectorFailure {
  if (status === 401) return 'token_expired';
  if (status === 403) {
    // Google uses 403 for these transient limits too. Prefer its explicit reason;
    // only fall back to standard limit phrases when no reason was supplied.
    // A mention of quota settings or rate-limit permissions is not a retry signal.
    if (
      providerReasons.some(
        (reason) => reason === 'rateLimitExceeded' || reason === 'userRateLimitExceeded',
      ) ||
      (providerReasons.length === 0 &&
        /^(?:too many requests:\s*)?(?:too many concurrent requests\b|(?:user[ -])?rate[ -]limit exceeded\b|quota exceeded\b)/i.test(
          message.trim(),
        ))
    )
      return 'rate_limited';
    // 権限が無いのと、許可の範囲が足りないのを分ける。直し方が違う。
    return /scope|insufficient/i.test(message) ? 'insufficient_scope' : 'permission_denied';
  }
  if (status === 404) return 'not_found';
  if (status === 429) return 'rate_limited';
  return 'provider_error';
}

export async function callJson<T>(
  url: string,
  init: { method: string; body?: unknown },
  config: CallConfig,
  signal?: AbortSignal,
): Promise<T> {
  const doFetch = config.fetch ?? globalThis.fetch;
  const timeout = AbortSignal.timeout(config.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  if (signal?.aborted) throw new ConnectorError('timed_out', 'cancelled before it started');

  /*
   * トークンは try の外で取る。
   *
   * 中に入れていた間、「まだ接続していません」が `timed_out` に化けていた。
   * 利用者には「接続先が時間内に返りませんでした」と出るので、
   * **繋いでいないことに気づけない。**理由の取り違えは、
   * 失敗そのものより始末が悪い。
   */
  const authorization = `Bearer ${await config.token()}`;

  let response: Response;
  try {
    response = await doFetch(url, {
      method: init.method,
      headers: { authorization, 'content-type': 'application/json' },
      signal: combined,
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
  } catch (error) {
    // 種類の分かっている失敗を、通信の失敗に塗り替えない
    if (error instanceof ConnectorError) throw error;
    throw new ConnectorError('timed_out', error instanceof Error ? error.message : String(error));
  }

  const text = await response.text();
  if (response.status === 204 || text.length === 0) return {} as T;

  let body: unknown;
  try {
    body = JSON.parse(text) as unknown;
  } catch {
    // 読めない本文を成功として通さない
    throw new ConnectorError(
      'provider_error',
      `the provider replied with ${response.status} and no readable body`,
    );
  }

  if (!response.ok) {
    const error = (body as { error?: { message?: unknown; errors?: unknown } } | null)?.error;
    const message =
      typeof error?.message === 'string' ? error.message : `status ${response.status}`;
    const reasons = Array.isArray(error?.errors)
      ? error.errors.flatMap((entry: unknown) => {
          if (entry === null || typeof entry !== 'object') return [];
          const reason = (entry as { reason?: unknown }).reason;
          return typeof reason === 'string' && reason ? [reason] : [];
        })
      : [];
    throw new ConnectorError(failureFor(response.status, message, reasons), message);
  }
  return body as T;
}
