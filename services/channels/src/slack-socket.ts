/**
 * Slack の Socket Mode。**公開 URL が要らない**受け方。
 *
 * Events API（HTTP）は Slack から gateway へ届くので、公開 HTTPS が要る。手元の Mac で動く
 * gateway には届かない。Socket Mode は gateway から Slack へ WebSocket を張り、そこで受ける。
 * 要るのは App-Level Token（xapp、スコープ `connections:write`）だけ。
 *
 *   apps.connections.open（xapp）→ wss の URL → 接続 → hello
 *   events_api / interactive → 受け口（保存）→ ack（envelope_id）
 *   disconnect / 切断 → 間をあけて繋ぎ直す（2 秒から 30 秒、×1.8、ゆらぎ ±25%）
 *
 * 守ること（openclaw extensions/slack の reconnect-policy と同じ）:
 *   - **ack は受け口が返ってから。**保存できなかったものは ack しない（Slack が送り直す）
 *   - トークンが無効・スコープ不足は、繋ぎ直しても直らない。止めて状態に出す
 *   - 同じアプリに 2 本以上つながっていると、イベントが他方にも配られる。hello で気づいたら記録する
 */

/** 繋ぎ直しても直らない失敗（トークンや設定を直すまで止める）。 */
const FATAL_ERRORS = new Set([
  'invalid_auth',
  'not_authed',
  'token_revoked',
  'token_expired',
  'account_inactive',
  'missing_scope',
  'not_allowed_token_type',
  'invalid_token_type',
]);

export const SLACK_SOCKET_BACKOFF = {
  initialMs: 2_000,
  maxMs: 30_000,
  factor: 1.8,
  jitter: 0.25,
} as const;

export type SlackSocketState = 'stopped' | 'connecting' | 'open' | 'retrying' | 'failed';

export interface SlackSocketStatus {
  readonly state: SlackSocketState;
  /** 最後の失敗（トークンの文字列は含めない）。 */
  readonly lastError: string | null;
  /** retrying のとき、次に繋ぎにいくまでの ms。 */
  readonly retryInMs: number | null;
  /** hello で Slack が言った、このアプリへの接続の数。2 以上ならイベントがばらける。 */
  readonly connections: number | null;
  readonly connectedAt: string | null;
}

/** WebSocket の要るところだけ（テストで差し替える）。 */
export interface SocketLike {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: unknown) => void) | null;
  onerror: ((event: unknown) => void) | null;
}

export interface SlackSocketDeps {
  readonly appToken: string;
  /** events_api の payload（Events API の envelope と同じ形）。返ってから ack する。 */
  readonly onEvent: (payload: unknown) => Promise<void>;
  /** interactive の payload（block_actions など）。返ってから ack する。 */
  readonly onInteractive: (payload: unknown) => Promise<void>;
  readonly fetchImpl?: typeof fetch;
  readonly connect?: (url: string) => SocketLike;
  readonly log?: (event: string, detail: Record<string, unknown>) => void;
  readonly random?: () => number;
  readonly setTimer?: (fn: () => void, ms: number) => unknown;
  readonly clearTimer?: (handle: unknown) => void;
  readonly now?: () => number;
}

/** n 回目（0 から）の待ち時間。ゆらぎは ±jitter。 */
export function slackSocketBackoffMs(attempt: number, random: () => number = Math.random): number {
  const { initialMs, maxMs, factor, jitter } = SLACK_SOCKET_BACKOFF;
  const base = Math.min(maxMs, initialMs * factor ** attempt);
  return Math.round(base * (1 + jitter * (random() * 2 - 1)));
}

export class SlackSocketMode {
  readonly #deps: SlackSocketDeps;
  #socket: SocketLike | null = null;
  #timer: unknown = null;
  #attempt = 0;
  #running = false;
  #status: SlackSocketStatus = {
    state: 'stopped',
    lastError: null,
    retryInMs: null,
    connections: null,
    connectedAt: null,
  };

  constructor(deps: SlackSocketDeps) {
    this.#deps = deps;
  }

  status(): SlackSocketStatus {
    return this.#status;
  }

  start(): void {
    if (this.#running) return;
    this.#running = true;
    this.#attempt = 0;
    void this.#open();
  }

  stop(): void {
    this.#running = false;
    if (this.#timer !== null) (this.#deps.clearTimer ?? clearTimeout)(this.#timer as never);
    this.#timer = null;
    const socket = this.#socket;
    this.#socket = null;
    socket?.close(1000, 'stopping');
    this.#set({ state: 'stopped', retryInMs: null });
  }

  #set(patch: Partial<SlackSocketStatus>): void {
    this.#status = { ...this.#status, ...patch };
  }

  #log(event: string, detail: Record<string, unknown> = {}): void {
    this.#deps.log?.(event, detail);
  }

  async #open(): Promise<void> {
    if (!this.#running) return;
    this.#set({ state: 'connecting', retryInMs: null });
    let url: string;
    try {
      url = await this.#connectionUrl();
    } catch (error) {
      const code = error instanceof SlackSocketError ? error.code : 'slack_unreachable';
      if (FATAL_ERRORS.has(code)) {
        this.#running = false;
        this.#set({ state: 'failed', lastError: code, retryInMs: null });
        this.#log('slack.socket_failed', { error: code });
        return;
      }
      this.#retry(code);
      return;
    }
    if (!this.#running) return;
    let socket: SocketLike;
    try {
      socket = (this.#deps.connect ?? defaultConnect)(url);
    } catch {
      this.#retry('socket_open_failed');
      return;
    }
    this.#socket = socket;
    socket.onmessage = (event) => {
      void this.#onMessage(socket, event.data);
    };
    socket.onclose = () => {
      if (this.#socket !== socket) return;
      this.#socket = null;
      this.#retry('socket_closed');
    };
    socket.onerror = () => {
      // close が続いて来る。ここでは記録だけ
      this.#log('slack.socket_error');
    };
  }

  async #connectionUrl(): Promise<string> {
    let response: Response;
    try {
      response = await (this.#deps.fetchImpl ?? fetch)(
        'https://slack.com/api/apps.connections.open',
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ${this.#deps.appToken}`,
            'content-type': 'application/x-www-form-urlencoded',
          },
          signal: AbortSignal.timeout(10_000),
        },
      );
    } catch {
      throw new SlackSocketError('slack_unreachable');
    }
    if (!response.ok) throw new SlackSocketError(`slack_http_${String(response.status)}`);
    const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (data['ok'] !== true) {
      throw new SlackSocketError(typeof data['error'] === 'string' ? data['error'] : 'slack_error');
    }
    const url = data['url'];
    if (typeof url !== 'string' || !url.startsWith('wss://'))
      throw new SlackSocketError('slack_bad_url');
    return url;
  }

  #retry(reason: string): void {
    if (!this.#running) return;
    const wait = slackSocketBackoffMs(this.#attempt, this.#deps.random);
    this.#attempt += 1;
    this.#set({ state: 'retrying', lastError: reason, retryInMs: wait });
    this.#log('slack.socket_retry', { reason, wait_ms: wait, attempt: this.#attempt });
    this.#timer = (this.#deps.setTimer ?? setTimeout)(() => {
      this.#timer = null;
      void this.#open();
    }, wait);
    const timer = this.#timer as { unref?: () => void } | null;
    timer?.unref?.();
  }

  async #onMessage(socket: SocketLike, data: unknown): Promise<void> {
    let frame: Record<string, unknown>;
    try {
      frame = JSON.parse(typeof data === 'string' ? data : String(data)) as Record<string, unknown>;
    } catch {
      this.#log('slack.socket_bad_frame');
      return;
    }
    switch (frame['type']) {
      case 'hello': {
        this.#attempt = 0;
        const info = frame['num_connections'];
        const connections = typeof info === 'number' ? info : null;
        this.#set({
          state: 'open',
          lastError: null,
          retryInMs: null,
          connections,
          connectedAt: new Date((this.#deps.now ?? Date.now)()).toISOString(),
        });
        if (connections !== null && connections > 1) {
          // 別の Mac や古いプロセスが同じアプリに繋いでいる。イベントがそちらにも配られる
          this.#log('slack.socket_shared', { connections });
        }
        return;
      }
      case 'disconnect':
        // Slack からの切断予告（refresh_requested など）。すぐ繋ぎ直す
        this.#attempt = 0;
        socket.close(1000, 'disconnect requested');
        return;
      case 'events_api':
      case 'interactive':
      case 'slash_commands': {
        const envelopeId = frame['envelope_id'];
        if (typeof envelopeId !== 'string') return;
        try {
          if (frame['type'] === 'events_api') await this.#deps.onEvent(frame['payload']);
          else if (frame['type'] === 'interactive')
            await this.#deps.onInteractive(frame['payload']);
        } catch (error) {
          // 保存できなかった。ack しなければ Slack が送り直す
          this.#log('slack.socket_handler_failed', {
            error: error instanceof Error ? error.name : 'unknown',
          });
          return;
        }
        socket.send(JSON.stringify({ envelope_id: envelopeId }));
        return;
      }
      default:
        return;
    }
  }
}

class SlackSocketError extends Error {
  constructor(readonly code: string) {
    super(`slack socket: ${code}`);
    this.name = 'SlackSocketError';
  }
}

function defaultConnect(url: string): SocketLike {
  const Impl = (globalThis as { WebSocket?: new (url: string) => SocketLike }).WebSocket;
  if (!Impl) throw new Error('WebSocket is not available in this runtime');
  return new Impl(url);
}
