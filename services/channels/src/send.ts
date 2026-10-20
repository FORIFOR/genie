/**
 * チャットへ送る。Slack（chat.postMessage）と LINE（reply / push）。
 *
 * **送るのは外部への送信。**何を送るか（要約だけか本文までか）は呼ぶ側が
 * 連携の posting_policy で決める。ここは決まったものを、決まった先へ届けるだけ。
 *
 * 失敗は投げる。再送するかは outbox が決める（429・5xx・通信の失敗だけ再送してよい）。
 */
import type { ChannelProvider } from '@genie/contracts';

export interface OutgoingButton {
  readonly label: string;
  /** Genie が署名した値（`signApprovalAction`）。 */
  readonly value: string;
  readonly style?: 'primary' | 'danger';
}

export interface OutgoingMessage {
  readonly text: string;
  readonly buttons?: readonly OutgoingButton[];
}

export interface SendTarget {
  readonly destination: string;
  readonly threadKey: string;
}

export interface SendOptions {
  /** LINE の reply token。あれば無料の reply で返す（期限切れなら push に落とす）。 */
  readonly replyToken?: string | null;
  /** 同じ送信の再送を、提供者の側でも 1 通にする鍵（LINE の X-Line-Retry-Key、UUID）。 */
  readonly retryKey: string;
}

export interface ChannelSender {
  readonly provider: ChannelProvider;
  send(
    target: SendTarget,
    message: OutgoingMessage,
    options: SendOptions,
  ): Promise<{ providerMessageId: string | null }>;
  /** 考えている間の表示（LINE の読み込み中）。出せなくても仕事は続ける。 */
  typing?(target: SendTarget): Promise<void>;
}

export class ChannelSendError extends Error {
  constructor(
    readonly code: string,
    readonly retryable: boolean,
  ) {
    super(`channel send failed: ${code}`);
    this.name = 'ChannelSendError';
  }
}

const retryableStatus = (status: number) => status === 429 || status >= 500;

/** Slack の Bot。DM の中ではスレッドに返す（スレッドの ts を thread_ts に）。 */
export class SlackSender implements ChannelSender {
  readonly provider = 'slack' as const;

  constructor(
    private readonly botToken: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async #call(method: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    let response: Response;
    try {
      response = await this.fetchImpl(`https://slack.com/api/${method}`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.botToken}`,
          'content-type': 'application/json; charset=utf-8',
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      throw new ChannelSendError('slack_unreachable', true);
    }
    if (!response.ok)
      throw new ChannelSendError(
        `slack_http_${String(response.status)}`,
        retryableStatus(response.status),
      );
    const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (data['ok'] !== true) {
      const error = typeof data['error'] === 'string' ? data['error'] : 'slack_error';
      throw new ChannelSendError(error, error === 'ratelimited' || error === 'internal_error');
    }
    return data;
  }

  async send(
    target: SendTarget,
    message: OutgoingMessage,
  ): Promise<{ providerMessageId: string | null }> {
    const text = message.text.slice(0, 2900);
    const blocks: unknown[] = [
      { type: 'section', text: { type: 'plain_text', text, emoji: false } },
    ];
    if (message.buttons?.length) {
      blocks.push({
        type: 'actions',
        elements: message.buttons.map((b, i) => ({
          type: 'button',
          action_id: `genie_${String(i)}`,
          text: { type: 'plain_text', text: b.label.slice(0, 75) },
          value: b.value,
          ...(b.style ? { style: b.style } : {}),
        })),
      });
    }
    const data = await this.#call('chat.postMessage', {
      channel: target.destination,
      text,
      blocks,
      // DM の中の発言から始まったものは、その発言のスレッドに返す
      ...(/^\d+\.\d+$/.test(target.threadKey) ? { thread_ts: target.threadKey } : {}),
      unfurl_links: false,
      unfurl_media: false,
    });
    return { providerMessageId: typeof data['ts'] === 'string' ? data['ts'] : null };
  }

  /** 本人との DM を開く（メンションの結果を返す先）。 */
  async openDirect(user: string): Promise<string> {
    const data = await this.#call('conversations.open', { users: user });
    const channel = data['channel'];
    const id =
      typeof channel === 'object' && channel !== null
        ? (channel as Record<string, unknown>)['id']
        : null;
    if (typeof id !== 'string') throw new ChannelSendError('slack_open_failed', false);
    return id;
  }

  /** メンションされた場所に、短く答える（結果は書かない）。 */
  async postInThread(channel: string, threadTs: string, text: string): Promise<void> {
    await this.#call('chat.postMessage', {
      channel,
      thread_ts: threadTs,
      text,
      unfurl_links: false,
    });
  }
}

/** LINE 公式アカウント。reply token があれば reply、無ければ push。 */
export class LineSender implements ChannelSender {
  readonly provider = 'line' as const;

  constructor(
    private readonly accessToken: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async #post(
    path: string,
    body: unknown,
    headers: Record<string, string> = {},
  ): Promise<Response> {
    try {
      return await this.fetchImpl(`https://api.line.me/v2/bot/${path}`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.accessToken}`,
          'content-type': 'application/json',
          ...headers,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      throw new ChannelSendError('line_unreachable', true);
    }
  }

  async send(
    target: SendTarget,
    message: OutgoingMessage,
    options: SendOptions,
  ): Promise<{ providerMessageId: string | null }> {
    const messages = lineMessages(message);
    if (options.replyToken) {
      let replied: Response;
      try {
        replied = await this.#post('message/reply', { replyToken: options.replyToken, messages });
      } catch {
        // 届いたか分からない。reply は再送を 1 通にできないので、送り直さない
        throw new ChannelSendError('line_reply_uncertain', false);
      }
      if (replied.ok) return { providerMessageId: null };
      // 断られた（届いていない）ものだけ送り直す。期限切れ・使用済みの token（400）は push で、
      // 429 は後で。5xx は受け付けられたかもしれないので、push で二通目を作らない
      // （openclaw extensions/line の canFallbackAfterLineReplyFailure と同じ考え）
      if (replied.status === 429) throw new ChannelSendError('line_http_429', true);
      if (replied.status !== 400) {
        throw new ChannelSendError(
          replied.status >= 500 ? 'line_reply_uncertain' : `line_http_${String(replied.status)}`,
          false,
        );
      }
    }
    const pushed = await this.#post(
      'message/push',
      { to: target.destination, messages },
      // 同じ送信の再試行は、LINE の側でも 1 通になる（409 は「もう送った」）
      { 'X-Line-Retry-Key': options.retryKey },
    );
    if (pushed.ok || pushed.status === 409) return { providerMessageId: null };
    throw new ChannelSendError(
      `line_http_${String(pushed.status)}`,
      retryableStatus(pushed.status),
    );
  }

  /** 1:1 のトークに「読み込み中」を出す（最長 60 秒、次の返信で消える）。 */
  async typing(target: SendTarget): Promise<void> {
    const response = await this.#post('chat/loading/start', {
      chatId: target.destination,
      loadingSeconds: LINE_LOADING_SECONDS,
    });
    if (!response.ok) {
      throw new ChannelSendError(
        `line_http_${String(response.status)}`,
        retryableStatus(response.status),
      );
    }
  }
}

/** 読み込み中を出す秒数（5 秒刻み、5〜60）。返信が先に届けばそこで消える。 */
export const LINE_LOADING_SECONDS = 20;

/** 本文と、ボタンがあればボタンのテンプレート（本文 160 字・ラベル 20 字・最大 4 つ）。 */
export function lineMessages(message: OutgoingMessage): unknown[] {
  const messages: unknown[] = [{ type: 'text', text: message.text.slice(0, 4900) }];
  if (message.buttons?.length) {
    messages.push({
      type: 'template',
      altText: 'Genie の確認',
      template: {
        type: 'buttons',
        text: '選んでください',
        actions: message.buttons.slice(0, 4).map((b) => ({
          type: 'postback',
          label: b.label.slice(0, 20),
          data: b.value,
          displayText: b.label.slice(0, 20),
        })),
      },
    });
  }
  return messages;
}
