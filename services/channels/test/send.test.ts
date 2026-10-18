/**
 * 送る口。実際の Slack / LINE は叩かない。
 */
import { describe, expect, it, vi } from 'vitest';
import { ChannelSendError, LineSender, SlackSender } from '../src/send.js';
import { waitingApproval, completed } from '../src/render.js';

const ok = (body: unknown = {}) => new Response(JSON.stringify(body), { status: 200 });

describe('SlackSender', () => {
  it('replies in the thread of a DM message, with buttons as blocks', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) =>
      ok({ ok: true, ts: '2.0' }),
    );
    const sender = new SlackSender('xoxb-test', fetchImpl as unknown as typeof fetch);
    const sent = await sender.send(
      { destination: 'D1', threadKey: '1.0' },
      {
        text: '確認してください',
        buttons: [{ label: '電話をかける', value: 'a1.v', style: 'primary' }],
      },
    );
    expect(sent).toEqual({ providerMessageId: '2.0' });
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe('https://slack.com/api/chat.postMessage');
    const body = JSON.parse(String(init!.body));
    expect(body).toMatchObject({ channel: 'D1', thread_ts: '1.0' });
    expect(body.blocks[1].elements[0]).toMatchObject({ value: 'a1.v', style: 'primary' });
  });

  it('does not thread a DM opened for a mention, and says when a failure may be retried', async () => {
    const fetchImpl = vi.fn(async () => ok({ ok: false, error: 'ratelimited' }));
    const sender = new SlackSender('xoxb-test', fetchImpl as unknown as typeof fetch);
    await expect(
      sender.send({ destination: 'D1', threadKey: 'mention:C1:1.0' }, { text: 'x' }),
    ).rejects.toMatchObject(new ChannelSendError('ratelimited', true));
    const body = JSON.parse(
      String((fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].body),
    );
    expect(body.thread_ts).toBeUndefined();
  });
});

describe('LineSender', () => {
  it('replies with the reply token, and falls back to push with a retry key when it has expired', async () => {
    const fetchImpl = vi
      .fn(async (_url: string, _init?: RequestInit) => ok())
      .mockResolvedValueOnce(new Response('{"message":"Invalid reply token"}', { status: 400 }));
    const sender = new LineSender('token', fetchImpl as unknown as typeof fetch);
    await sender.send(
      { destination: 'Uline', threadKey: 'Uline' },
      { text: '受け付けました' },
      { replyToken: 'rt', retryKey: 'k-1' },
    );
    expect(fetchImpl.mock.calls.map((c) => c[0])).toEqual([
      'https://api.line.me/v2/bot/message/reply',
      'https://api.line.me/v2/bot/message/push',
    ]);
    expect(fetchImpl.mock.calls[1]![1]!.headers).toMatchObject({ 'X-Line-Retry-Key': 'k-1' });
  });

  it('treats a repeated retry key as already sent', async () => {
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 409 }));
    const sender = new LineSender('token', fetchImpl as unknown as typeof fetch);
    await expect(
      sender.send({ destination: 'U', threadKey: 'U' }, { text: 'x' }, { retryKey: 'k' }),
    ).resolves.toEqual({
      providerMessageId: null,
    });
  });
});

describe('messages', () => {
  it('offers buttons only when given, and otherwise points to the approval card', () => {
    const view = {
      summary: '田中さんに営業の電話をかけます',
      details: [{ label: '相手', value: '田中' }],
      primaryActionLabel: '電話をかける',
    };
    expect(waitingApproval(view, null)).toEqual({
      text: expect.stringContaining('Genie の承認カードで確認してください'),
    });
    const withButtons = waitingApproval(view, { approve: 'a', reject: 'r' });
    expect(withButtons.text).toContain('・相手：田中');
    expect(withButtons.buttons?.map((b) => b.label)).toEqual(['電話をかける', 'やめる']);
  });

  it('sends the result body only when the link allows it', () => {
    expect(completed('調査', 'summary_and_link', '本文').text).not.toContain('本文');
    expect(completed('調査', 'full_text', '本文').text).toContain('本文');
  });
});
