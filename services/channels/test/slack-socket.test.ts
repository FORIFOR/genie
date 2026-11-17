/**
 * Slack の Socket Mode。Slack にも WebSocket にも繋がない（代役）。
 *
 * 見ること:
 *   - 受け口が返ってから ack する。受け口が失敗したら ack しない（Slack が送り直す）
 *   - 切れたら間をあけて繋ぎ直す。トークンが無効なら繋ぎ直さずに止める
 *   - 同じアプリへの接続が 2 本以上なら記録する
 */
import { describe, expect, it, vi } from 'vitest';
import { SlackSocketMode, slackSocketBackoffMs, type SocketLike } from '../src/slack-socket.js';

class FakeSocket implements SocketLike {
  sent: string[] = [];
  closed = false;
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: unknown) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.closed = true;
    this.onclose?.({});
  }
  frame(body: unknown) {
    this.onmessage?.({ data: JSON.stringify(body) });
  }
}

const opened = () =>
  vi.fn(
    async (_url: string, _init?: RequestInit) =>
      new Response(JSON.stringify({ ok: true, url: 'wss://wss-primary.slack.com/link' })),
  );

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('SlackSocketMode', () => {
  it('opens with the app token and acks an event only after it has been accepted', async () => {
    const sockets: FakeSocket[] = [];
    const fetchImpl = opened();
    let release!: () => void;
    const onEvent = vi.fn(() => new Promise<void>((r) => (release = r)));
    const mode = new SlackSocketMode({
      appToken: 'xapp-1',
      onEvent,
      onInteractive: vi.fn(async () => {}),
      fetchImpl: fetchImpl as unknown as typeof fetch,
      connect: () => {
        const s = new FakeSocket();
        sockets.push(s);
        return s;
      },
    });
    mode.start();
    await flush();
    expect(fetchImpl.mock.calls[0]![0]).toBe('https://slack.com/api/apps.connections.open');
    expect(fetchImpl.mock.calls[0]![1]!.headers).toMatchObject({ authorization: 'Bearer xapp-1' });

    const socket = sockets[0]!;
    socket.frame({ type: 'hello', num_connections: 1 });
    expect(mode.status()).toMatchObject({ state: 'open', connections: 1 });

    const payload = { type: 'event_callback', event_id: 'Ev1' };
    socket.frame({ type: 'events_api', envelope_id: 'env-1', payload });
    await flush();
    expect(onEvent).toHaveBeenCalledWith(payload);
    expect(socket.sent).toEqual([]);
    release();
    await flush();
    expect(socket.sent).toEqual([JSON.stringify({ envelope_id: 'env-1' })]);
    mode.stop();
  });

  it('does not ack when the event could not be saved', async () => {
    const socket = new FakeSocket();
    const mode = new SlackSocketMode({
      appToken: 'xapp-1',
      onEvent: async () => {
        throw new Error('db down');
      },
      onInteractive: async () => {},
      fetchImpl: opened() as unknown as typeof fetch,
      connect: () => socket,
    });
    mode.start();
    await flush();
    socket.frame({ type: 'events_api', envelope_id: 'env-1', payload: {} });
    await flush();
    expect(socket.sent).toEqual([]);
    mode.stop();
  });

  it('acks button presses after handing them over', async () => {
    const socket = new FakeSocket();
    const onInteractive = vi.fn(async () => {});
    const mode = new SlackSocketMode({
      appToken: 'xapp-1',
      onEvent: async () => {},
      onInteractive,
      fetchImpl: opened() as unknown as typeof fetch,
      connect: () => socket,
    });
    mode.start();
    await flush();
    socket.frame({ type: 'interactive', envelope_id: 'env-2', payload: { type: 'block_actions' } });
    await flush();
    expect(onInteractive).toHaveBeenCalledWith({ type: 'block_actions' });
    expect(socket.sent).toEqual([JSON.stringify({ envelope_id: 'env-2' })]);
    mode.stop();
  });

  it('reconnects after a close with backoff, and notes a shared app', async () => {
    const sockets: FakeSocket[] = [];
    const timers: { fn: () => void; ms: number }[] = [];
    const log = vi.fn();
    const mode = new SlackSocketMode({
      appToken: 'xapp-1',
      onEvent: async () => {},
      onInteractive: async () => {},
      fetchImpl: opened() as unknown as typeof fetch,
      connect: () => {
        const s = new FakeSocket();
        sockets.push(s);
        return s;
      },
      random: () => 0.5,
      setTimer: (fn, ms) => timers.push({ fn, ms }),
      clearTimer: () => {},
      log,
    });
    mode.start();
    await flush();
    sockets[0]!.frame({ type: 'hello', num_connections: 2 });
    expect(log).toHaveBeenCalledWith('slack.socket_shared', { connections: 2 });

    sockets[0]!.frame({ type: 'disconnect', reason: 'refresh_requested' });
    expect(mode.status()).toMatchObject({ state: 'retrying', retryInMs: 2000 });
    timers.shift()!.fn();
    await flush();
    expect(sockets).toHaveLength(2);
    // hello の前に続けて切れると、待ち時間が伸びる
    sockets[1]!.close();
    expect(mode.status().retryInMs).toBe(3600);
    timers.shift()!.fn();
    await flush();
    sockets[2]!.close();
    expect(mode.status().retryInMs).toBe(6480);
    // hello が届けば最初の間隔に戻る
    timers.shift()!.fn();
    await flush();
    sockets[3]!.frame({ type: 'hello', num_connections: 1 });
    sockets[3]!.close();
    expect(mode.status().retryInMs).toBe(2000);
    mode.stop();
    expect(mode.status().state).toBe('stopped');
  });

  it('stops instead of retrying when the token is rejected', async () => {
    const timers: unknown[] = [];
    const mode = new SlackSocketMode({
      appToken: 'xapp-bad',
      onEvent: async () => {},
      onInteractive: async () => {},
      fetchImpl: (async () =>
        new Response(
          JSON.stringify({ ok: false, error: 'invalid_auth' }),
        )) as unknown as typeof fetch,
      connect: () => new FakeSocket(),
      setTimer: (fn) => timers.push(fn),
    });
    mode.start();
    await flush();
    expect(mode.status()).toMatchObject({ state: 'failed', lastError: 'invalid_auth' });
    expect(timers).toHaveLength(0);
  });

  it('retries when Slack cannot be reached', async () => {
    const timers: unknown[] = [];
    const mode = new SlackSocketMode({
      appToken: 'xapp-1',
      onEvent: async () => {},
      onInteractive: async () => {},
      fetchImpl: (async () => {
        throw new TypeError('fetch failed');
      }) as unknown as typeof fetch,
      connect: () => new FakeSocket(),
      setTimer: (fn) => timers.push(fn),
      random: () => 0.5,
    });
    mode.start();
    await flush();
    expect(mode.status()).toMatchObject({ state: 'retrying', lastError: 'slack_unreachable' });
    expect(timers).toHaveLength(1);
    mode.stop();
  });
});

describe('slackSocketBackoffMs', () => {
  it('grows by 1.8x up to 30 seconds, with ±25% jitter', () => {
    expect(slackSocketBackoffMs(0, () => 0.5)).toBe(2000);
    expect(slackSocketBackoffMs(1, () => 0.5)).toBe(3600);
    expect(slackSocketBackoffMs(10, () => 0.5)).toBe(30000);
    expect(slackSocketBackoffMs(0, () => 0)).toBe(1500);
    expect(slackSocketBackoffMs(0, () => 1)).toBe(2500);
  });
});
