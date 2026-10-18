/**
 * Slack の入口。署名が合わないものは読まない。DM の人の発話だけを受ける。
 */
import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  SLACK_SIGNATURE_WINDOW_MS,
  channelIdempotencyKey,
  normalizeSlackEvent,
  verifySlackSignature,
} from '../src/index.js';

const secret = 'test-signing-secret';
const now = 1_790_000_000_000;
const ts = String(now / 1000);

function sign(body: string, timestamp = ts, key = secret): string {
  return 'v0=' + createHmac('sha256', key).update(`v0:${timestamp}:${body}`).digest('hex');
}

const dm = (event: Record<string, unknown> = {}) => ({
  type: 'event_callback',
  team_id: 'T001',
  event_id: 'Ev001',
  event_time: now / 1000,
  event: {
    type: 'message',
    channel_type: 'im',
    channel: 'D001',
    user: 'U001',
    ts: '1790000000.000100',
    text: '明日の会議の資料をまとめて',
    ...event,
  },
});

describe('verifySlackSignature', () => {
  const body = JSON.stringify(dm());
  const raw = Buffer.from(body);

  it('accepts the signature Slack computes over the raw body', () => {
    expect(
      verifySlackSignature({
        signingSecret: secret,
        timestamp: ts,
        signature: sign(body),
        rawBody: raw,
        now: () => now,
      }),
    ).toBe(true);
  });

  it('rejects a body that was changed after signing', () => {
    const tampered = Buffer.from(body.replace('資料', '請求書'));
    expect(
      verifySlackSignature({
        signingSecret: secret,
        timestamp: ts,
        signature: sign(body),
        rawBody: tampered,
        now: () => now,
      }),
    ).toBe(false);
  });

  it('rejects a signature made with another secret', () => {
    expect(
      verifySlackSignature({
        signingSecret: secret,
        timestamp: ts,
        signature: sign(body, ts, 'other'),
        rawBody: raw,
        now: () => now,
      }),
    ).toBe(false);
  });

  it('rejects a replay outside the five-minute window, in either direction', () => {
    for (const skew of [SLACK_SIGNATURE_WINDOW_MS + 1000, -(SLACK_SIGNATURE_WINDOW_MS + 1000)]) {
      expect(
        verifySlackSignature({
          signingSecret: secret,
          timestamp: ts,
          signature: sign(body),
          rawBody: raw,
          now: () => now + skew,
        }),
      ).toBe(false);
    }
  });

  it('rejects missing headers, a malformed timestamp and an empty secret', () => {
    const base = { signingSecret: secret, rawBody: raw, now: () => now };
    expect(verifySlackSignature({ ...base, timestamp: undefined, signature: sign(body) })).toBe(
      false,
    );
    expect(verifySlackSignature({ ...base, timestamp: ts, signature: undefined })).toBe(false);
    expect(verifySlackSignature({ ...base, timestamp: '1e9', signature: sign(body) })).toBe(false);
    expect(
      verifySlackSignature({ ...base, signingSecret: '', timestamp: ts, signature: sign(body) }),
    ).toBe(false);
  });
});

describe('normalizeSlackEvent', () => {
  it('answers the URL verification challenge', () => {
    expect(normalizeSlackEvent({ type: 'url_verification', challenge: 'abc' })).toEqual({
      kind: 'url_verification',
      challenge: 'abc',
    });
  });

  it('turns a direct message into the common shape', () => {
    expect(normalizeSlackEvent(dm())).toEqual({
      kind: 'message',
      message: {
        provider: 'slack',
        eventId: 'Ev001',
        workspaceId: 'T001',
        subject: 'U001',
        destination: 'D001',
        threadKey: '1790000000.000100',
        text: '明日の会議の資料をまとめて',
        sentAt: now,
        replyToken: null,
      },
    });
  });

  it('keeps a reply inside its thread', () => {
    const result = normalizeSlackEvent(dm({ thread_ts: '1789999999.000001' }));
    expect(result.kind === 'message' && result.message.threadKey).toBe('1789999999.000001');
  });

  it('does not take instructions from bots, edits, channels or empty messages', () => {
    expect(normalizeSlackEvent(dm({ bot_id: 'B001' }))).toEqual({
      kind: 'ignored',
      reason: 'bot_message',
    });
    expect(normalizeSlackEvent(dm({ subtype: 'message_changed' }))).toEqual({
      kind: 'ignored',
      reason: 'subtype',
    });
    for (const channelType of ['channel', 'group', 'mpim']) {
      expect(normalizeSlackEvent(dm({ channel_type: channelType }))).toEqual({
        kind: 'ignored',
        reason: 'not_direct_message',
      });
    }
    expect(normalizeSlackEvent(dm({ text: '   ' }))).toEqual({
      kind: 'ignored',
      reason: 'empty_text',
    });
  });

  it('says why it did not take malformed or other events', () => {
    expect(normalizeSlackEvent(null)).toEqual({ kind: 'ignored', reason: 'malformed' });
    expect(normalizeSlackEvent({ type: 'app_rate_limited' })).toEqual({
      kind: 'ignored',
      reason: 'unsupported_event',
    });
    expect(normalizeSlackEvent(dm({ type: 'reaction_added' }))).toEqual({
      kind: 'ignored',
      reason: 'unsupported_event',
    });
    expect(normalizeSlackEvent(dm({ user: undefined }))).toEqual({
      kind: 'ignored',
      reason: 'malformed',
    });
  });
});

describe('channelIdempotencyKey', () => {
  it('gives a retry the same key, and stays within the Idempotency-Key limits', () => {
    expect(channelIdempotencyKey('slack', 'Ev001')).toBe('channel:slack:Ev001');
    expect(channelIdempotencyKey('slack', 'Ev001')).toBe(channelIdempotencyKey('slack', 'Ev001'));
    const long = channelIdempotencyKey('line', 'x'.repeat(300));
    expect(long.length).toBeLessThanOrEqual(128);
    expect(long).toBe(channelIdempotencyKey('line', 'x'.repeat(300)));
    expect(channelIdempotencyKey('slack', 'a').length).toBeGreaterThanOrEqual(8);
  });
});
