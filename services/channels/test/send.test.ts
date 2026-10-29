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

  it('does not post again when a post may have landed, but retries a refusal', async () => {
    const cases: [() => Promise<Response>, ChannelSendError][] = [
      // 時間切れ・5xx・internal_error は「届いたか分からない」
      [
        () => Promise.reject(Object.assign(new Error('timed out'), { name: 'TimeoutError' })),
        new ChannelSendError('slack_send_uncertain', false),
      ],
      [
        () => Promise.resolve(new Response('{}', { status: 503 })),
        new ChannelSendError('slack_send_uncertain', false),
      ],
      [
        () => Promise.resolve(ok({ ok: false, error: 'internal_error' })),
        new ChannelSendError('slack_send_uncertain', false),
      ],
      // 繋がらなかった・429 は届いていない。429 は Retry-After を伝える
      [
        () => Promise.reject(new TypeError('fetch failed')),
        new ChannelSendError('slack_unreachable', true),
      ],
      [
        () => Promise.resolve(new Response('{}', { status: 429, headers: { 'retry-after': '7' } })),
        new ChannelSendError('slack_http_429', true, 7000),
      ],
      [
        () => Promise.resolve(ok({ ok: false, error: 'channel_not_found' })),
        new ChannelSendError('channel_not_found', false),
      ],
    ];
    for (const [answer, expected] of cases) {
      const sender = new SlackSender('xoxb-test', vi.fn(answer) as unknown as typeof fetch);
      await expect(
        sender.send({ destination: 'D1', threadKey: '1.0' }, { text: 'x' }),
      ).rejects.toMatchObject(expected);
    }
  });

  it('may retry opening a DM after a server error (opening twice gives the same DM)', async () => {
    const sender = new SlackSender(
      'xoxb-test',
      vi.fn(async () => new Response('{}', { status: 503 })) as unknown as typeof fetch,
    );
    await expect(sender.openDirect('U1')).rejects.toMatchObject(
      new ChannelSendError('slack_http_503', true),
    );
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

  it('does not push a second copy when a reply may have been accepted', async () => {
    for (const failure of [
      () => Promise.resolve(new Response('{}', { status: 500 })),
      () => Promise.reject(new TypeError('socket hang up')),
    ]) {
      const fetchImpl = vi.fn(failure);
      const sender = new LineSender('token', fetchImpl as unknown as typeof fetch);
      await expect(
        sender.send(
          { destination: 'U', threadKey: 'U' },
          { text: 'x' },
          { replyToken: 'rt', retryKey: 'k' },
        ),
      ).rejects.toMatchObject(new ChannelSendError('line_reply_uncertain', false));
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    }
  });

  it('retries a reply that was refused for the rate limit', async () => {
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 429 }));
    const sender = new LineSender('token', fetchImpl as unknown as typeof fetch);
    await expect(
      sender.send(
        { destination: 'U', threadKey: 'U' },
        { text: 'x' },
        { replyToken: 'rt', retryKey: 'k' },
      ),
    ).rejects.toMatchObject(new ChannelSendError('line_http_429', true));
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('shows the loading animation in the 1:1 chat', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) => ok());
    const sender = new LineSender('token', fetchImpl as unknown as typeof fetch);
    await sender.typing({ destination: 'Uline', threadKey: 'Uline' });
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe('https://api.line.me/v2/bot/chat/loading/start');
    expect(JSON.parse(String(init!.body))).toEqual({ chatId: 'Uline', loadingSeconds: 20 });
  });

  it('fetches a sent photo from the content endpoint, and refuses one that is too large', async () => {
    const fetchImpl = vi.fn(
      async (_url: string, _init?: RequestInit) =>
        new Response(new Uint8Array([9, 8, 7]), { headers: { 'content-type': 'image/jpeg' } }),
    );
    const sender = new LineSender('token', fetchImpl as unknown as typeof fetch);
    await expect(sender.content('5550001')).resolves.toEqual({
      mediaType: 'image/jpeg',
      data: new Uint8Array([9, 8, 7]),
    });
    expect(fetchImpl.mock.calls[0]![0]).toBe(
      'https://api-data.line.me/v2/bot/message/5550001/content',
    );
    await expect(sender.content('../x')).rejects.toMatchObject({ code: 'line_content_bad_id' });

    const big = vi.fn(
      async () => new Response('x', { headers: { 'content-length': String(11 * 1024 * 1024) } }),
    );
    await expect(
      new LineSender('token', big as unknown as typeof fetch).content('1'),
    ).rejects.toMatchObject({ code: 'line_content_too_large', retryable: false });
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

  it('points the end notice at the work home when there is a link, and at the Mac otherwise', () => {
    const url = 'https://liff.line.me/1-a/w/' + 'T'.repeat(32);
    expect(completed('調査', 'summary_and_link', null, url)).toEqual({
      text: `終わりました：調査。経過と確かめた結果は仕事のホームで開けます。\n${url}`,
      markdown: `終わりました：調査。経過と確かめた結果は仕事のホームで開けます。\n\n[仕事のホームを開く](${url})`,
    });
    expect(completed('調査', 'summary_and_link', null).text).toBe(
      '終わりました：調査。結果は Genie の作業一覧で開けます。',
    );
    // 本文を送る設定なら本文（リンクより本文が先）
    expect(completed('調査', 'full_text', '本文', url).text).not.toContain(url);
  });
});
