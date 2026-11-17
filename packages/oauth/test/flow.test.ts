/**
 * 端末で走らせる OAuth2 + PKCE。正本 §21。
 *
 * 資格情報が要らないところは全部ここで確かめる。
 * **提供者が居ないことを、試験しない理由にしない。**
 */
import { describe, expect, it, vi } from 'vitest';
import {
  AUTHORIZATION_TIMEOUT_MS,
  MAX_VERIFIER_LENGTH,
  MIN_VERIFIER_LENGTH,
  REFRESH_LEEWAY_MS,
  TokenStore,
  acceptCallback,
  beginAuthorization,
  createPkce,
  credentialRef,
  exchangeCode,
  isLoopbackRedirect,
  needsRefresh,
  randomToken,
  refresh,
  type ProviderConfig,
  type TokenSet,
} from '../src/index.js';

const NOW = Date.parse('2026-08-27T12:00:00.000Z');

const config = (over: Partial<ProviderConfig> = {}): ProviderConfig => ({
  provider: 'example',
  authorizeUrl: 'https://auth.example.com/authorize',
  tokenUrl: 'https://auth.example.com/token',
  clientId: 'client-1',
  redirectUri: 'http://127.0.0.1:53682/callback',
  scopes: ['mail.read', 'mail.send'],
  ...over,
});

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('PKCE', () => {
  it('produces an S256 challenge, never plain', async () => {
    const pkce = await createPkce();
    // plain は、コードを盗れる相手には何の防御にもならない
    expect(pkce.method).toBe('S256');
    expect(pkce.challenge).not.toBe(pkce.verifier);
    expect(pkce.challenge).not.toMatch(/[+/=]/);
  });

  it('refuses a verifier outside the length the RFC allows', async () => {
    await expect(createPkce('short')).rejects.toThrow(/43\.\.128/);
    await expect(createPkce('a'.repeat(MAX_VERIFIER_LENGTH + 1))).rejects.toThrow();
    await expect(createPkce('a'.repeat(MIN_VERIFIER_LENGTH))).resolves.toBeTruthy();
  });

  it('is the same challenge for the same verifier', async () => {
    const a = await createPkce('a'.repeat(50));
    const b = await createPkce('a'.repeat(50));
    expect(a.challenge).toBe(b.challenge);
  });

  it('does not repeat itself', () => {
    const seen = new Set(Array.from({ length: 50 }, () => randomToken()));
    expect(seen.size).toBe(50);
  });
});

describe('where the provider may send the user back', () => {
  it('accepts loopback only (RFC 8252)', () => {
    expect(isLoopbackRedirect('http://127.0.0.1:53682/callback')).toBe(true);
    expect(isLoopbackRedirect('http://[::1]:53682/callback')).toBe(true);
    // 他所へ折り返させない。認可コードを持ち出す経路になる。
    expect(isLoopbackRedirect('https://example.com/callback')).toBe(false);
    expect(isLoopbackRedirect('http://evil.example.com/callback')).toBe(false);
    expect(isLoopbackRedirect('astra://callback')).toBe(false);
    expect(isLoopbackRedirect('nonsense')).toBe(false);
  });

  it('refuses to start with anything else', async () => {
    await expect(
      beginAuthorization(config({ redirectUri: 'https://example.com/cb' })),
    ).rejects.toThrow(/loopback/);
  });
});

describe('starting the sign-in', () => {
  it('says so up front when nothing is configured', async () => {
    // 始めてから気付かせない
    await expect(beginAuthorization(config({ clientId: '' }))).rejects.toThrow(/no client id/);
  });

  it('carries the challenge, the state and the scopes', async () => {
    const { url, pending } = await beginAuthorization(config(), () => NOW);
    const parsed = new URL(url);
    expect(parsed.searchParams.get('response_type')).toBe('code');
    expect(parsed.searchParams.get('code_challenge_method')).toBe('S256');
    expect(parsed.searchParams.get('code_challenge')).toBe(pending.pkce.challenge);
    expect(parsed.searchParams.get('state')).toBe(pending.state);
    expect(parsed.searchParams.get('scope')).toBe('mail.read mail.send');
    // verifier は決して外へ出さない
    expect(url).not.toContain(pending.pkce.verifier);
  });

  it('passes provider-specific parameters through', async () => {
    const { url } = await beginAuthorization(
      config({ extraAuthorizeParams: { access_type: 'offline' } }),
    );
    expect(new URL(url).searchParams.get('access_type')).toBe('offline');
  });
});

describe('coming back', () => {
  const pending = async () => (await beginAuthorization(config(), () => NOW)).pending;

  it('refuses a callback whose state does not match', async () => {
    const p = await pending();
    // 他人が仕込んだコードを、本人のものとして受け取らない
    expect(() => acceptCallback(p, { code: 'c', state: 'someone else' }, () => NOW)).toThrow(
      /did not match/,
    );
    expect(() => acceptCallback(p, { code: 'c' }, () => NOW)).toThrow(/did not match/);
  });

  it('refuses a window that was left open too long', async () => {
    const p = await pending();
    expect(() =>
      acceptCallback(p, { code: 'c', state: p.state }, () => NOW + AUTHORIZATION_TIMEOUT_MS + 1),
    ).toThrow(/too long/);
  });

  it('passes the provider refusal through instead of swallowing it', async () => {
    const p = await pending();
    expect(() =>
      acceptCallback(
        p,
        { error: 'access_denied', error_description: '利用者が拒否しました', state: p.state },
        () => NOW,
      ),
    ).toThrow('利用者が拒否しました');
  });

  it('refuses a callback with no code at all', async () => {
    const p = await pending();
    expect(() => acceptCallback(p, { state: p.state }, () => NOW)).toThrow(/no authorization code/);
  });

  it('accepts the one that matches', async () => {
    const p = await pending();
    expect(acceptCallback(p, { code: 'the-code', state: p.state }, () => NOW)).toEqual({
      code: 'the-code',
    });
  });
});

describe('exchanging the code', () => {
  it('sends the verifier, and never the challenge', async () => {
    const { pending } = await beginAuthorization(config(), () => NOW);
    const seen: string[] = [];
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      seen.push(String(init.body));
      return jsonResponse({ access_token: 'a', expires_in: 3600, scope: 'mail.read' });
    });

    await exchangeCode(pending, 'the-code', fetchImpl, () => NOW);
    const body = new URLSearchParams(seen[0]!);
    // ここを省くと、盗まれたコードがそのまま使える
    expect(body.get('code_verifier')).toBe(pending.pkce.verifier);
    expect(body.get('grant_type')).toBe('authorization_code');
    expect(body.get('code')).toBe('the-code');
    expect(body.get('code_challenge')).toBeNull();
  });

  it('leaves out a client secret a native app does not have', async () => {
    const { pending } = await beginAuthorization(config(), () => NOW);
    const seen: string[] = [];
    await exchangeCode(
      pending,
      'c',
      async (_u, init) => {
        seen.push(String(init.body));
        return jsonResponse({ access_token: 'a' });
      },
      () => NOW,
    );
    expect(new URLSearchParams(seen[0]!).get('client_secret')).toBeNull();
  });

  it('does not invent an expiry the provider did not give', async () => {
    const { pending } = await beginAuthorization(config(), () => NOW);
    const tokens = await exchangeCode(
      pending,
      'c',
      async () => jsonResponse({ access_token: 'a' }),
      () => NOW,
    );
    // 分からないものを「まだ有効」と言わない
    expect(tokens.expiresAt).toBeNull();
  });

  it('does not treat the requested scopes as granted', async () => {
    const { pending } = await beginAuthorization(config(), () => NOW);
    const tokens = await exchangeCode(
      pending,
      'c',
      async () => jsonResponse({ access_token: 'a' }),
      () => NOW,
    );
    // 返らないなら分からない。要求した分を許されたことにしない。
    expect(tokens.grantedScopes).toEqual([]);

    const partial = await exchangeCode(
      pending,
      'c',
      async () => jsonResponse({ access_token: 'a', scope: 'mail.read' }),
      () => NOW,
    );
    expect(partial.grantedScopes).toEqual(['mail.read']);
  });

  it('reports what the provider said when it refused', async () => {
    const { pending } = await beginAuthorization(config(), () => NOW);
    await expect(
      exchangeCode(
        pending,
        'c',
        async () =>
          jsonResponse({ error: 'invalid_grant', error_description: 'コードが古い' }, 400),
        () => NOW,
      ),
    ).rejects.toThrow('コードが古い');
  });

  it('does not pretend to succeed on an unreadable reply', async () => {
    const { pending } = await beginAuthorization(config(), () => NOW);
    await expect(
      exchangeCode(
        pending,
        'c',
        async () => new Response('<html>502</html>', { status: 502 }),
        () => NOW,
      ),
    ).rejects.toThrow(/502/);
  });

  it('refuses a 200 that carries no token', async () => {
    const { pending } = await beginAuthorization(config(), () => NOW);
    await expect(
      exchangeCode(
        pending,
        'c',
        async () => jsonResponse({ token_type: 'Bearer' }),
        () => NOW,
      ),
    ).rejects.toThrow(/no access token/);
  });
});

describe('refreshing', () => {
  it('requests the connection scopes explicitly when refreshing Microsoft access', async () => {
    let submitted = '';
    const next = await refresh(
      config({ provider: 'microsoft', scopes: ['Mail.Read', 'User.Read'] }),
      'refresh-value',
      async (_url, init) => {
        submitted = String(init?.body);
        return jsonResponse({ access_token: 'read-access', scope: 'Mail.Read User.Read' });
      },
    );
    expect(new URLSearchParams(submitted).get('scope')).toBe('Mail.Read User.Read');
    expect(next.grantedScopes).toEqual(['Mail.Read', 'User.Read']);
  });
  const tokens = (over: Partial<TokenSet> = {}): TokenSet => ({
    accessToken: 'a',
    refreshToken: 'r',
    expiresAt: new Date(NOW + 3600_000).toISOString(),
    grantedScopes: ['mail.read'],
    tokenType: 'Bearer',
    idToken: null,
    ...over,
  });

  it('waits until the leeway, then acts', () => {
    expect(needsRefresh(tokens(), NOW)).toBe(false);
    expect(
      needsRefresh(tokens({ expiresAt: new Date(NOW + REFRESH_LEEWAY_MS).toISOString() }), NOW),
    ).toBe(true);
  });

  it('does not try without a refresh token', () => {
    expect(
      needsRefresh(tokens({ refreshToken: null, expiresAt: new Date(NOW).toISOString() }), NOW),
    ).toBe(false);
  });

  it('treats an unreadable expiry as due', () => {
    // 分からないものを「まだ大丈夫」と言わない
    expect(needsRefresh(tokens({ expiresAt: 'なにか' }), NOW)).toBe(true);
  });

  it('keeps the old refresh token when the provider omits it', async () => {
    const next = await refresh(
      config(),
      'the-old-one',
      async () => jsonResponse({ access_token: 'new', expires_in: 3600 }),
      () => NOW,
    );
    // null にすると、次の更新ができなくなって黙ってサインアウトする
    expect(next.refreshToken).toBe('the-old-one');
    expect(next.accessToken).toBe('new');
  });

  it('takes a rotated refresh token when the provider sends one', async () => {
    const next = await refresh(
      config(),
      'old',
      async () => jsonResponse({ access_token: 'new', refresh_token: 'rotated' }),
      () => NOW,
    );
    expect(next.refreshToken).toBe('rotated');
  });
});

describe('where the tokens live', () => {
  const memory = () => {
    const map = new Map<string, string>();
    return {
      map,
      store: {
        set: async (k: string, v: string) => void map.set(k, v),
        get: async (k: string) => map.get(k) ?? null,
        delete: async (k: string) => void map.delete(k),
      },
    };
  };

  it('hands back a reference, never the value', async () => {
    const { map, store } = memory();
    const ref = await new TokenStore(store).save('com.acme.mail', 'gmail', {
      accessToken: 'ya29.secret',
      refreshToken: 'r',
      expiresAt: null,
      grantedScopes: [],
      tokenType: 'Bearer',
      idToken: null,
    });
    expect(ref).toBe(credentialRef('com.acme.mail', 'gmail'));
    // 参照から値を推測できない
    expect(ref).not.toContain('ya29');
    expect([...map.values()].join()).toContain('ya29.secret');
  });

  it('returns nothing rather than half a token', async () => {
    const { map, store } = memory();
    map.set('com.acme.mail/gmail', '{ broken');
    expect(await new TokenStore(store).load('keychain:com.acme.mail/gmail')).toBeNull();

    map.set('com.acme.mail/gmail', JSON.stringify({ refreshToken: 'r' }));
    expect(await new TokenStore(store).load('keychain:com.acme.mail/gmail')).toBeNull();
  });

  it('forgets on disconnect', async () => {
    const { map, store } = memory();
    const tokenStore = new TokenStore(store);
    const ref = await tokenStore.save('p', 'c', {
      accessToken: 'a',
      refreshToken: null,
      expiresAt: null,
      grantedScopes: [],
      tokenType: 'Bearer',
      idToken: null,
    });
    await tokenStore.forget(ref);
    expect(map.size).toBe(0);
  });
});

describe('token client binding', () => {
  it.each(['google', 'microsoft'])(
    'records the actual %s client used for both code exchange and refresh',
    async (provider) => {
      const c = config({ provider, scopes: ['Mail.Read'] });
      const { pending } = await beginAuthorization(c, () => NOW);
      const fetchImpl = vi.fn(async () =>
        jsonResponse({ access_token: 'access', scope: 'Mail.Read' }),
      );
      expect((await exchangeCode(pending, 'code', fetchImpl, () => NOW)).clientId).toBe(c.clientId);
      const renewed = await refresh(c, 'existing-refresh', fetchImpl, () => NOW);
      expect(renewed.clientId).toBe(c.clientId);
      expect(renewed.refreshToken).toBe('existing-refresh');
    },
  );
  it('does not refresh Microsoft without explicit scopes', async () => {
    const fetchImpl = vi.fn();
    await expect(
      refresh(config({ provider: 'microsoft', scopes: [] }), 'refresh', fetchImpl),
    ).rejects.toThrow();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
