import { describe, expect, it } from 'vitest';
import { callJson } from '../src/http.js';

describe('connector HTTP failure classification', () => {
  it.each(['rateLimitExceeded', 'userRateLimitExceeded'])(
    'classifies Google 403 %s without depending on its private message',
    async (reason) => {
      const fetch = (async () =>
        Response.json(
          { error: { message: 'PRIVATE_PROVIDER_DETAIL', errors: [{ reason }] } },
          { status: 403 },
        )) as typeof globalThis.fetch;
      await expect(
        callJson(
          'https://provider.example.invalid/read',
          { method: 'GET' },
          {
            token: async () => 'synthetic-token',
            fetch,
          },
        ),
      ).rejects.toMatchObject({ reason: 'rate_limited' });
    },
  );

  it.each([
    'Rate Limit Exceeded',
    'User Rate Limit Exceeded',
    'User-rate limit exceeded. Retry after a delay.',
    'Too many concurrent requests for user',
    'Too many requests: Too many concurrent requests for user',
    'Quota exceeded for quota metric read requests',
  ])('recognizes a standard 403 limit message when no reason is provided: %s', async (message) => {
    const fetch = (async () =>
      Response.json({ error: { message } }, { status: 403 })) as typeof globalThis.fetch;
    await expect(
      callJson(
        'https://provider.example.invalid/read',
        { method: 'GET' },
        {
          token: async () => 'synthetic-token',
          fetch,
        },
      ),
    ).rejects.toMatchObject({ reason: 'rate_limited' });
  });

  it.each([
    {
      status: 403,
      message: 'Permission denied',
      reason: 'forbidden',
      expected: 'permission_denied',
    },
    { status: 403, message: 'Gmail API has not been used', expected: 'permission_denied' },
    { status: 403, message: 'Insufficient authentication scopes', expected: 'insufficient_scope' },
    { status: 403, message: 'Access to quota settings is denied', expected: 'permission_denied' },
    {
      status: 403,
      message: 'Permission denied to read rate limits',
      expected: 'permission_denied',
    },
    {
      status: 403,
      message: 'Quota exceeded',
      reason: 'domainPolicy',
      expected: 'permission_denied',
    },
    {
      status: 403,
      message: 'Daily Limit Exceeded',
      reason: 'dailyLimitExceeded',
      expected: 'permission_denied',
    },
    {
      status: 401,
      message: 'Rate Limit Exceeded',
      reason: 'rateLimitExceeded',
      expected: 'token_expired',
    },
    { status: 429, message: 'Limit reached', expected: 'rate_limited' },
  ])(
    'preserves non-rate and existing HTTP classifications: $status $message',
    async ({ status, message, reason, expected }) => {
      const fetch = (async () =>
        Response.json(
          { error: { message, ...(reason ? { errors: [{ reason }] } : {}) } },
          { status },
        )) as typeof globalThis.fetch;
      await expect(
        callJson(
          'https://provider.example.invalid/read',
          { method: 'GET' },
          {
            token: async () => 'synthetic-token',
            fetch,
          },
        ),
      ).rejects.toMatchObject({ reason: expected });
    },
  );

  it('ignores malformed provider reason entries without treating them as permission to retry', async () => {
    const fetch = (async () =>
      Response.json(
        {
          error: {
            message: 'Access denied',
            errors: [null, {}, { reason: 1 }, { reason: 'notRateLimitExceeded' }],
          },
        },
        { status: 403 },
      )) as typeof globalThis.fetch;
    await expect(
      callJson(
        'https://provider.example.invalid/read',
        { method: 'GET' },
        {
          token: async () => 'synthetic-token',
          fetch,
        },
      ),
    ).rejects.toMatchObject({ reason: 'permission_denied' });
  });
});
