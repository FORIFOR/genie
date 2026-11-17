/**
 * 端末で走らせる認可コードフロー。RFC 6749 + RFC 8252（native app）。
 *
 * 正本 §21: **OAuth の交換は端末側で行い、トークンは Keychain へ置く。**
 * サーバへ渡すのは、その置き場所の参照だけ。
 *
 * ここが持つのは判断と組み立てだけで、
 * 画面も、待ち受けも、保管も持たない（差し替えられるように外へ出してある）。
 */
import { createPkce, randomToken, type Pkce } from './pkce.js';

export interface ProviderConfig {
  /** 提供者の名前。`google` / `microsoft` など。 */
  readonly provider: string;
  readonly authorizeUrl: string;
  readonly tokenUrl: string;
  readonly clientId: string;
  /**
   * native app では持たない（RFC 8252 §8.5）。
   * 提供者が必須にしている場合だけ入れる。**無いのが既定。**
   */
  readonly clientSecret?: string;
  /** 折り返し先。loopback だけを許す（RFC 8252 §7.3）。 */
  readonly redirectUri: string;
  readonly scopes: readonly string[];
  /** 提供者ごとの追加パラメータ（Google の `access_type` など）。 */
  readonly extraAuthorizeParams?: Readonly<Record<string, string>>;
}

/** 折り返しを待っている間だけ持つもの。**使い捨て。** */
export interface PendingAuthorization {
  readonly state: string;
  readonly pkce: Pkce;
  readonly config: ProviderConfig;
  readonly startedAt: number;
}

/** 折り返しを待つ上限。開きっぱなしを永久に有効にしない。 */
export const AUTHORIZATION_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * loopback だけを許す。RFC 8252 §7.3。
 *
 * **他所へ折り返させない。**任意の URL を許すと、
 * 認可コードを外へ持ち出す経路になる。
 */
export function isLoopbackRedirect(uri: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:') return false;
  return parsed.hostname === '127.0.0.1' || parsed.hostname === '[::1]';
}

export async function beginAuthorization(
  config: ProviderConfig,
  now: () => number = Date.now,
): Promise<{ url: string; pending: PendingAuthorization }> {
  if (!isLoopbackRedirect(config.redirectUri)) {
    throw new Error(`redirect_uri must be a loopback address (got ${config.redirectUri})`);
  }
  if (!config.clientId) {
    // 設定が無いなら、無いと言う。**始めてから気付かせない。**
    throw new Error(`${config.provider} has no client id configured`);
  }

  const pkce = await createPkce();
  const state = randomToken();
  const url = new URL(config.authorizeUrl);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', config.clientId);
  url.searchParams.set('redirect_uri', config.redirectUri);
  url.searchParams.set('scope', config.scopes.join(' '));
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', pkce.challenge);
  url.searchParams.set('code_challenge_method', pkce.method);
  for (const [key, value] of Object.entries(config.extraAuthorizeParams ?? {})) {
    url.searchParams.set(key, value);
  }

  return { url: url.toString(), pending: { state, pkce, config, startedAt: now() } };
}

export interface CallbackParams {
  readonly code?: string | undefined;
  readonly state?: string | undefined;
  readonly error?: string | undefined;
  readonly error_description?: string | undefined;
}

/**
 * 折り返しを受け取ってよいか。
 *
 * **state が合わないものを通さない。**通すと、他人が仕込んだ
 * 認可コードを本人のものとして受け取ってしまう（CSRF）。
 */
export function acceptCallback(
  pending: PendingAuthorization,
  params: CallbackParams,
  now: () => number = Date.now,
): { code: string } {
  if (params.error) {
    // 提供者が断った理由をそのまま伝える。握り潰さない。
    throw new Error(params.error_description ?? params.error);
  }
  if (!params.state || params.state !== pending.state) {
    throw new Error('the callback did not match the request that started it');
  }
  if (now() - pending.startedAt > AUTHORIZATION_TIMEOUT_MS) {
    // 開きっぱなしの窓を、あとから使わせない
    throw new Error('this sign-in took too long; start it again');
  }
  if (!params.code) throw new Error('the callback carried no authorization code');
  return { code: params.code };
}

export interface TokenSet {
  /** Client used for the successful exchange/refresh; absent only on legacy credentials. */
  readonly clientId?: string;
  /** Local account display metadata shared with the native connection UI. */
  readonly accountLabel?: string;
  readonly accessToken: string;
  readonly refreshToken: string | null;
  /** 期限。提供者が返さなければ null（**勝手に決めない**）。 */
  readonly expiresAt: string | null;
  /** 実際に許された scope。要求した scope ではない。 */
  readonly grantedScopes: readonly string[];
  readonly tokenType: string;
  /** OpenID の ID トークン。scope に openid が無ければ null。サインインはこれだけを使う。 */
  readonly idToken: string | null;
  /**
   * 提供者が更新を断った時刻（`invalid_grant`）。つなぎ直すまで更新は通らない。
   * host が自分の更新分の項目にだけ書く（Mac アプリへは指紋だけを別のファイルで知らせる）。
   */
  readonly renewalRejectedAt?: string;
}

interface TokenResponseBody {
  access_token?: unknown;
  refresh_token?: unknown;
  expires_in?: unknown;
  scope?: unknown;
  token_type?: unknown;
  id_token?: unknown;
  error?: unknown;
  error_description?: unknown;
}

function parseTokenResponse(
  body: TokenResponseBody,
  requested: readonly string[],
  now: number,
): TokenSet {
  if (typeof body.error === 'string') {
    // 種類（`invalid_grant` など）は code に残す。呼ぶ側が「つなぎ直し」を見分けられるように。
    throw Object.assign(
      new Error(typeof body.error_description === 'string' ? body.error_description : body.error),
      { code: body.error },
    );
  }
  if (typeof body.access_token !== 'string' || body.access_token.length === 0) {
    throw new Error('the provider returned no access token');
  }

  const expiresIn = typeof body.expires_in === 'number' ? body.expires_in : null;
  return {
    accessToken: body.access_token,
    refreshToken: typeof body.refresh_token === 'string' ? body.refresh_token : null,
    // 返ってこなければ null。**期限を推測して「まだ有効」と言わない。**
    expiresAt: expiresIn === null ? null : new Date(now + expiresIn * 1000).toISOString(),
    /*
     * 提供者が scope を返さないときは、**要求した分を許されたことにしない。**
     * 返らないなら分からない、が正しい。空で返す。
     */
    grantedScopes: typeof body.scope === 'string' ? body.scope.split(/\s+/).filter(Boolean) : [],
    tokenType: typeof body.token_type === 'string' ? body.token_type : 'Bearer',
    idToken: typeof body.id_token === 'string' ? body.id_token : null,
  };
}

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

async function post(
  config: ProviderConfig,
  form: Record<string, string>,
  fetchImpl: FetchLike,
): Promise<TokenResponseBody> {
  const body = new URLSearchParams(form);
  if (config.clientSecret) body.set('client_secret', config.clientSecret);

  const response = await fetchImpl(config.tokenUrl, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'application/json',
    },
    body: body.toString(),
  });

  const text = await response.text();
  let parsed: TokenResponseBody;
  try {
    parsed = JSON.parse(text) as TokenResponseBody;
  } catch {
    // 本文が読めないときも、状態だけは伝える
    throw new Error(`the provider replied with ${response.status} and no readable body`);
  }
  if (!response.ok && typeof parsed.error !== 'string') {
    throw new Error(`the provider replied with ${response.status}`);
  }
  return parsed;
}

export async function exchangeCode(
  pending: PendingAuthorization,
  code: string,
  fetchImpl: FetchLike,
  now: () => number = Date.now,
): Promise<TokenSet> {
  const body = await post(
    pending.config,
    {
      grant_type: 'authorization_code',
      code,
      redirect_uri: pending.config.redirectUri,
      client_id: pending.config.clientId,
      // PKCE。**ここを省くと、盗まれたコードがそのまま使える。**
      code_verifier: pending.pkce.verifier,
    },
    fetchImpl,
  );
  return {
    ...parseTokenResponse(body, pending.config.scopes, now()),
    clientId: pending.config.clientId,
  };
}

export async function refresh(
  config: ProviderConfig,
  refreshToken: string,
  fetchImpl: FetchLike,
  now: () => number = Date.now,
): Promise<TokenSet> {
  if (config.provider === 'microsoft' && config.scopes.length === 0)
    throw new Error('Microsoft refresh requires explicit scopes');
  const body = await post(
    config,
    {
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: config.clientId,
      ...(config.provider === 'microsoft' ? { scope: config.scopes.join(' ') } : {}),
    },
    fetchImpl,
  );
  const next = {
    ...parseTokenResponse(body, config.scopes, now()),
    clientId: config.clientId,
  };
  /*
   * 更新の応答が refresh token を返さない提供者がある。
   * **そのときは今までのものを使い続ける。**null にすると、
   * 次の更新ができなくなって、黙ってサインアウトする。
   */
  return next.refreshToken === null ? { ...next, refreshToken } : next;
}

/** 更新に取りかかる余裕。切れてから慌てない。 */
export const REFRESH_LEEWAY_MS = 60_000;

/**
 * いま更新すべきか。
 *
 * **期限が分からないものを「まだ大丈夫」と言わない。**
 * 分からないなら、使ってみて断られたときに更新する側へ倒す。
 */
export function needsRefresh(tokens: TokenSet, now: number = Date.now()): boolean {
  if (tokens.refreshToken === null) return false;
  if (tokens.expiresAt === null) return false;
  const at = Date.parse(tokens.expiresAt);
  return !Number.isFinite(at) || at - now <= REFRESH_LEEWAY_MS;
}
