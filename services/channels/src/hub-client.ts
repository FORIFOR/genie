/**
 * LINE の中継（services/line-hub）へ、Genie の側から張る WebSocket。
 *
 * 公式アカウントは運営者の 1 つだけ。利用者の Mac の Genie は中継へ自分からつなぎ、
 * 自分あての知らせを受け取り、返信・写真の取得も中継に頼む（LINE の鍵は中継にだけある）。
 * 公開 URL もトンネルもいらない（Slack の Socket Mode と同じ考え）。
 *
 * 受け取った知らせは、保存してから（`onEvent` が終わってから）受け取りを返す（ack）。
 * 返す前に落ちたら、中継が次につないだときに送り直す。重複は受信箱の配信 ID で捨てる。
 */
import { slackSocketBackoffMs, type SocketLike } from './slack-socket.js';

export interface LineHubEvent {
  readonly destination: string;
  readonly event: Record<string, unknown>;
}

export interface LineHubDeps {
  /** 例 wss://hub.example.com/connect */
  readonly url: string;
  readonly installId: string;
  readonly secret: string;
  readonly onEvent: (event: LineHubEvent) => Promise<void>;
  readonly connect: (url: string, headers: Record<string, string>) => SocketLike;
  readonly log?: (event: string, detail: Record<string, unknown>) => void;
  readonly setTimer?: (fn: () => void, ms: number) => void;
}

export type LineHubState = 'connecting' | 'open' | 'retrying' | 'stopped';

interface Pending {
  resolve: (value: { status: number; headers?: Record<string, string>; body?: string }) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class LineHubClient {
  #socket: SocketLike | null = null;
  #state: LineHubState = 'stopped';
  #attempt = 0;
  #serial = 0;
  readonly #pending = new Map<string, Pending>();

  constructor(private readonly deps: LineHubDeps) {}

  get state(): LineHubState {
    return this.#state;
  }

  start(): void {
    if (this.#state !== 'stopped') return;
    this.#open();
  }

  stop(): void {
    this.#state = 'stopped';
    this.#socket?.close();
    this.#socket = null;
  }

  #open(): void {
    this.#state = 'connecting';
    const socket = this.deps.connect(this.deps.url, {
      authorization: `Bearer ${this.deps.installId}:${this.deps.secret}`,
    });
    this.#socket = socket;
    socket.onopen = () => {
      this.#state = 'open';
      this.#attempt = 0;
      this.deps.log?.('line_hub.open', {});
    };
    socket.onmessage = (event) => void this.#receive(String(event.data));
    socket.onclose = (event) => {
      if (this.#socket !== socket || this.#state === 'stopped') return;
      const code = (event as { code?: number } | null)?.code ?? 0;
      this.#state = 'retrying';
      for (const [id, pending] of this.#pending) {
        clearTimeout(pending.timer);
        pending.resolve({ status: 504 });
        this.#pending.delete(id);
      }
      const delay = slackSocketBackoffMs(this.#attempt++);
      this.deps.log?.('line_hub.closed', { code, retry_ms: delay });
      (this.deps.setTimer ?? ((fn, ms) => void setTimeout(fn, ms).unref()))(() => {
        if (this.#state === 'retrying') this.#open();
      }, delay);
    };
    socket.onerror = () => {
      /* onclose が続いて呼ばれる */
    };
  }

  async #receive(raw: string): Promise<void> {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return;
    }
    if (message['t'] === 'event' && typeof message['id'] === 'number') {
      try {
        await this.deps.onEvent({
          destination: String(message['destination'] ?? ''),
          event: (message['event'] ?? {}) as Record<string, unknown>,
        });
        this.#socket?.send(JSON.stringify({ t: 'ack', id: message['id'] }));
      } catch (error) {
        // 受け取らなかったことにする（中継に残り、次につないだときに届く）
        this.deps.log?.('line_hub.event_failed', {
          error: error instanceof Error ? error.message : 'unknown',
        });
      }
      return;
    }
    if (message['t'] === 'res' && typeof message['id'] === 'string') {
      const pending = this.#pending.get(message['id']);
      if (!pending) return;
      this.#pending.delete(message['id']);
      clearTimeout(pending.timer);
      pending.resolve(
        message as { status: number; headers?: Record<string, string>; body?: string },
      );
    }
  }

  /** 中継へ頼む。つながっていなければ 503 相当を返す（送れなかった＝送り直してよい）。 */
  request(
    payload: Record<string, unknown>,
  ): Promise<{ status: number; headers?: Record<string, string>; body?: string }> {
    const socket = this.#socket;
    if (!socket || this.#state !== 'open') return Promise.resolve({ status: 503 });
    const id = `r${String(++this.#serial)}`;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        // 答えが来ない＝届いたか分からない。送り直しの判断は呼ぶ側（LineSender）の作法に任せる
        resolve({ status: 504 });
      }, 30_000);
      timer.unref?.();
      this.#pending.set(id, { resolve, timer });
      socket.send(JSON.stringify({ t: 'req', id, ...payload }));
    });
  }

  /**
   * LineSender に渡す fetch。LINE の API（api.line.me / api-data.line.me）への呼び出しを、中継への頼みに直す。
   * それ以外の宛先は扱わない。
   */
  readonly fetch: typeof fetch = async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    const match = /^https:\/\/api(?:-data)?\.line\.me\/v2\/bot\/(.+)$/.exec(url);
    if (!match) throw new TypeError('line hub: unsupported url');
    const headers = new Headers(init?.headers);
    const method = (init?.method ?? 'GET').toUpperCase();
    const res = await this.request({
      op: 'line',
      method,
      path: match[1],
      ...(method === 'POST' && init?.body
        ? { body: JSON.parse(String(init.body)) as unknown }
        : {}),
      ...(headers.get('x-line-retry-key') ? { retryKey: headers.get('x-line-retry-key') } : {}),
    });
    if (res.status === 503) throw new TypeError('line hub: not connected');
    if (res.status === 504) {
      const error = new Error('line hub: timed out');
      error.name = 'TimeoutError';
      throw error;
    }
    // 本文を持てない状態（204 など）に空の本文を付けると Response が投げる
    const empty = [101, 204, 205, 304].includes(res.status) || !res.body;
    return new Response(empty ? null : Buffer.from(res.body!, 'base64'), {
      status: res.status,
      headers: res.headers ?? {},
    });
  };

  async claimCode(codeHash: string, expiresAt: Date): Promise<boolean> {
    return (
      (await this.request({ op: 'claim-code', codeHash, expiresAt: expiresAt.getTime() }))
        .status === 204
    );
  }

  async claimGroup(groupId: string): Promise<boolean> {
    return (await this.request({ op: 'claim-group', groupId })).status === 204;
  }

  async releaseUser(userId: string): Promise<void> {
    await this.request({ op: 'release-user', userId });
  }

  async releaseGroup(groupId: string): Promise<void> {
    await this.request({ op: 'release-group', groupId });
  }
}
