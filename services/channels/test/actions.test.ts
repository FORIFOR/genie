/**
 * Phase 3 の入口: ボタン（Slack block_actions / LINE postback）と、Slack のメンション。
 * **DM の外のボタンは受けない。メンションの返事はチャンネルに書かない**（返す先は後で DM に替える）。
 */
import { describe, expect, it } from 'vitest';
import { normalizeLineWebhook } from '../src/line.js';
import { normalizeSlackAction, normalizeSlackEvent } from '../src/slack.js';

const blockActions = (over: Record<string, unknown> = {}) => ({
  type: 'block_actions',
  trigger_id: 'trig-1',
  user: { id: 'U1', team_id: 'T1' },
  team: { id: 'T1' },
  channel: { id: 'D1' },
  actions: [{ action_id: 'genie_0', value: 'a1.signed' }],
  ...over,
});

describe('normalizeSlackAction', () => {
  it('reads a button pressed in a DM', () => {
    expect(normalizeSlackAction(blockActions())).toEqual({
      kind: 'action',
      action: {
        provider: 'slack',
        eventId: 'action:trig-1',
        workspaceId: 'T1',
        subject: 'U1',
        destination: 'D1',
        value: 'a1.signed',
        replyToken: null,
      },
    });
  });

  it('ignores buttons outside a DM, other payloads and missing values', () => {
    expect(normalizeSlackAction(blockActions({ channel: { id: 'C1' } }))).toEqual({
      kind: 'ignored',
      reason: 'not_direct_message',
    });
    expect(normalizeSlackAction({ type: 'view_submission' })).toEqual({
      kind: 'ignored',
      reason: 'unsupported_event',
    });
    expect(normalizeSlackAction(blockActions({ actions: [{}] }))).toEqual({
      kind: 'ignored',
      reason: 'malformed',
    });
    expect(normalizeSlackAction(null)).toEqual({ kind: 'ignored', reason: 'unsupported_event' });
  });
});

describe('Slack mentions', () => {
  const mention = (event: Record<string, unknown> = {}) => ({
    type: 'event_callback',
    team_id: 'T1',
    event_id: 'Ev1',
    event_time: 1_760_000_000,
    event: {
      type: 'app_mention',
      user: 'U1',
      channel: 'C1',
      ts: '1760000000.000100',
      text: '<@UBOT> 競合を調べて',
      ...event,
    },
  });

  it('takes the words without the mention and remembers where it was asked', () => {
    const inbound = normalizeSlackEvent(mention());
    expect(inbound).toMatchObject({
      kind: 'message',
      message: {
        text: '競合を調べて',
        subject: 'U1',
        threadKey: 'mention:C1:1760000000.000100',
        mention: { channel: 'C1', ts: '1760000000.000100' },
      },
    });
  });

  it('keeps a mention inside a thread in that thread, and ignores bots and empty mentions', () => {
    expect(normalizeSlackEvent(mention({ thread_ts: '1759999999.000001' }))).toMatchObject({
      message: { mention: { ts: '1759999999.000001' } },
    });
    expect(normalizeSlackEvent(mention({ bot_id: 'B1' }))).toEqual({
      kind: 'ignored',
      reason: 'bot_message',
    });
    expect(normalizeSlackEvent(mention({ text: '<@UBOT>' }))).toEqual({
      kind: 'ignored',
      reason: 'empty_text',
    });
  });
});

describe('LINE postbacks', () => {
  const postback = (source: Record<string, unknown> = { type: 'user', userId: 'Uline' }) => ({
    destination: 'Ubot',
    events: [
      {
        type: 'postback',
        webhookEventId: 'ev-1',
        replyToken: 'rt-1',
        source,
        postback: { data: 'a1.signed' },
        mode: 'active',
      },
    ],
  });

  it('reads a button pressed in a 1:1 chat', () => {
    expect(normalizeLineWebhook(postback()).actions).toEqual([
      {
        provider: 'line',
        eventId: 'ev-1',
        workspaceId: 'Ubot',
        subject: 'Uline',
        destination: 'Uline',
        value: 'a1.signed',
        replyToken: 'rt-1',
      },
    ]);
  });

  it('ignores buttons in groups', () => {
    const inbound = normalizeLineWebhook(
      postback({ type: 'group', groupId: 'G1', userId: 'Uline' }),
    );
    expect(inbound.actions).toEqual([]);
    expect(inbound.ignored).toEqual([{ eventId: 'ev-1', reason: 'not_direct_message' }]);
  });
});
