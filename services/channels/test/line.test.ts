/**
 * LINE の入口。署名が合わないものは読まない。1:1 の text だけを受ける。
 */
import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { MemoryChannelInbox, normalizeLineWebhook, verifyLineSignature } from '../src/index.js';

const secret = 'test-channel-secret';

const textEvent = (over: Record<string, unknown> = {}) => ({
  type: 'message',
  mode: 'active',
  timestamp: 1_790_000_000_000,
  webhookEventId: '01HXLINEEVENT0001',
  deliveryContext: { isRedelivery: false },
  replyToken: 'reply-token-1',
  source: { type: 'user', userId: 'Uline001' },
  message: { type: 'text', id: '1', text: '田中さんに電話する件、まとめておいて' },
  ...over,
});

const webhook = (events: unknown[]) => ({ destination: 'Ubot001', events });

describe('verifyLineSignature', () => {
  const body = JSON.stringify(webhook([textEvent()]));
  const raw = Buffer.from(body);
  const good = createHmac('sha256', secret).update(body).digest('base64');

  it('accepts the signature LINE computes over the raw body', () => {
    expect(verifyLineSignature({ channelSecret: secret, signature: good, rawBody: raw })).toBe(
      true,
    );
  });

  it('rejects a changed body, another secret and a missing header', () => {
    expect(
      verifyLineSignature({
        channelSecret: secret,
        signature: good,
        rawBody: Buffer.from(body.replace('田中', '佐藤')),
      }),
    ).toBe(false);
    expect(verifyLineSignature({ channelSecret: 'other', signature: good, rawBody: raw })).toBe(
      false,
    );
    expect(verifyLineSignature({ channelSecret: secret, signature: undefined, rawBody: raw })).toBe(
      false,
    );
  });
});

describe('normalizeLineWebhook', () => {
  it('turns a 1:1 text message into the common shape', () => {
    expect(normalizeLineWebhook(webhook([textEvent()]))).toEqual({
      messages: [
        {
          provider: 'line',
          eventId: '01HXLINEEVENT0001',
          workspaceId: 'Ubot001',
          subject: 'Uline001',
          destination: 'Uline001',
          threadKey: 'Uline001',
          text: '田中さんに電話する件、まとめておいて',
          sentAt: 1_790_000_000_000,
          replyToken: 'reply-token-1',
        },
      ],
      actions: [],
      ignored: [],
    });
  });

  it('accepts the empty verification delivery without taking anything', () => {
    expect(normalizeLineWebhook(webhook([]))).toEqual({ messages: [], actions: [], ignored: [] });
  });

  it('keeps the messages it can take and says why it skipped the others', () => {
    const result = normalizeLineWebhook(
      webhook([
        textEvent({ webhookEventId: 'g', source: { type: 'group', groupId: 'G1', userId: 'U' } }),
        textEvent({ webhookEventId: 's', message: { type: 'sticker', id: '2' } }),
        textEvent({ webhookEventId: 'f', type: 'follow' }),
        textEvent({ webhookEventId: 'w', mode: 'standby' }),
        textEvent({ webhookEventId: 'e', message: { type: 'text', id: '3', text: ' ' } }),
        textEvent({ webhookEventId: 'ok' }),
        { type: 'message' },
      ]),
    );
    expect(result.messages.map((m) => m.eventId)).toEqual(['ok']);
    expect(result.ignored).toEqual([
      { eventId: 'g', reason: 'not_direct_message' },
      { eventId: 's', reason: 'not_text' },
      { eventId: 'f', reason: 'unsupported_event' },
      { eventId: 'w', reason: 'standby_mode' },
      { eventId: 'e', reason: 'empty_text' },
      { eventId: null, reason: 'malformed' },
    ]);
  });

  it('reads nothing from a malformed body', () => {
    expect(normalizeLineWebhook({ events: 'x' }).messages).toEqual([]);
    expect(normalizeLineWebhook({ events: [] }).ignored).toEqual([
      { eventId: null, reason: 'malformed' },
    ]);
  });
});

describe('MemoryChannelInbox', () => {
  it('takes a delivery once, even when it is redelivered', async () => {
    const inbox = new MemoryChannelInbox();
    expect(await inbox.claim('line', 'ev1')).toBe(true);
    expect(await inbox.claim('line', 'ev1')).toBe(false);
    // 提供者が違えば別の配信
    expect(await inbox.claim('slack', 'ev1')).toBe(true);
  });

  it('forgets a delivery only after the retention period', async () => {
    let now = 0;
    const inbox = new MemoryChannelInbox({ ttlMs: 1000, now: () => now });
    expect(await inbox.claim('slack', 'ev1')).toBe(true);
    now = 999;
    expect(await inbox.claim('slack', 'ev1')).toBe(false);
    now = 2001;
    expect(await inbox.claim('slack', 'ev1')).toBe(true);
  });
});
