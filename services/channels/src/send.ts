/**
 * チャットへ送る。Slack（chat.postMessage）と LINE（reply / push）。
 *
 * **送るのは外部への送信。**何を送るか（要約だけか本文までか）は呼ぶ側が
 * 連携の posting_policy で決める。ここは決まったものを、決まった先へ届けるだけ。
 *
 * 失敗は投げる。再送してよいかは、ここで**届いていないと言えるか**で決める。
 *   - 断られた（429、繋がらなかった）: 送り直してよい。429 は Retry-After だけ待つ
 *   - 届いたか分からない（時間切れ、5xx、Slack の internal_error）: 送り直さない。
 *     二通目を作るより、一通欠ける方を選ぶ（openclaw の Slack 送信と同じ考え）
 */
import type { ChannelProvider } from '@genie/contracts';
import { approvalCard, cardFor } from './cards.js';
import { answerFlex } from './rich.js';

export interface OutgoingButton {
  readonly label: string;
  /** Genie が署名した値（`signApprovalAction`）。 */
  readonly value: string;
  readonly style?: 'primary' | 'danger';
}

/** タップで送る選択肢。ボタンの字と送る文が違うときは組で渡す。 */
export type QuickReply = string | { readonly label: string; readonly text: string };

export interface OutgoingMessage {
  readonly text: string;
  readonly buttons?: readonly OutgoingButton[];
  /** 開くだけのリンクのボタン（通話を開始など）。LINE はボタン、Slack は文のリンクにする。 */
  readonly link?: { readonly label: string; readonly url: string };
  /** 答えの元の Markdown。LINE は見出し・太字・箇条書き・リンクがあれば Flex Message で描く。 */
  readonly markdown?: string;
  /** 答えの元の成果物（予定の一覧・天気・ニュースの JSON）。LINE はカードで描く（cards.ts）。 */
  readonly card?: string;
  /** 次の一手の選択肢（LINE の Quick Reply）。無ければ文の終わりの「はい / いいえ」から読む。 */
  readonly quickReplies?: readonly QuickReply[];
  /** 承認の中身。LINE は、変わるところとボタンを並べた確認カードで描く。 */
  readonly approval?: {
    readonly summary: string;
    readonly details: readonly { readonly label: string; readonly value: string }[];
    readonly note: string;
  };
  /**
   * 文の前に見せる画像（Genie のブラウザの画面など）。https の URL だけ（LINE が取りに来る）。
   * LINE は画像のメッセージ、Slack は文のリンクにする。
   */
  readonly image?: { readonly url: string; readonly previewUrl?: string };
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
  /** 送られた写真などの本体（LINE の message content）。大きすぎるものは取らない。 */
  content?(id: string): Promise<ReceivedContent>;
  /** グループの中の人の表示名（LINE の group / room member profile）。取れなければ null。 */
  memberName?(groupId: string, userId: string): Promise<string | null>;
}

export interface ReceivedContent {
  readonly mediaType: string;
  readonly data: Uint8Array;
}

/** 取りに行く本体の上限。写真を読むには十分で、動画まるごとは取らない。 */
export const MAX_CONTENT_BYTES = 10 * 1024 * 1024;

export class ChannelSendError extends Error {
  constructor(
    readonly code: string,
    readonly retryable: boolean,
    /** 提供者が「この時間は待って」と言った（429 の Retry-After）。 */
    readonly retryAfterMs: number | null = null,
  ) {
    super(`channel send failed: ${code}`);
    this.name = 'ChannelSendError';
  }
}

const retryableStatus = (status: number) => status === 429 || status >= 500;

/** Retry-After（秒）を ms に。無い・壊れているときは null。 */
function retryAfterOf(response: Response): number | null {
  const seconds = Number(response.headers.get('retry-after'));
  return Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds, 3600) * 1000 : null;
}

/** 時間切れは「送ったが返事が無い」。繋がらなかった（送れていない）のとは分ける。 */
function timedOut(error: unknown): boolean {
  return error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
}

/** Slack が「返せなかったが、受け付けたかもしれない」と言う失敗。 */
const SLACK_UNCERTAIN = new Set(['internal_error', 'fatal_error', 'request_timeout']);

/** Slack の Bot。DM の中ではスレッドに返す（スレッドの ts を thread_ts に）。 */
export class SlackSender implements ChannelSender {
  readonly provider = 'slack' as const;

  constructor(
    private readonly botToken: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  /**
   * `idempotent` は二度呼んでも結果が同じもの（DM を開く、など）。
   * 投稿は idempotent ではないので、届いたか分からない失敗を送り直さない。
   */
  async #call(
    method: string,
    body: Record<string, unknown>,
    idempotent = false,
  ): Promise<Record<string, unknown>> {
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
    } catch (error) {
      if (timedOut(error) && !idempotent) throw new ChannelSendError('slack_send_uncertain', false);
      throw new ChannelSendError('slack_unreachable', true);
    }
    if (!response.ok) {
      if (response.status === 429)
        throw new ChannelSendError('slack_http_429', true, retryAfterOf(response));
      if (response.status >= 500 && !idempotent)
        throw new ChannelSendError('slack_send_uncertain', false);
      throw new ChannelSendError(
        `slack_http_${String(response.status)}`,
        retryableStatus(response.status),
      );
    }
    const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (data['ok'] !== true) {
      const error = typeof data['error'] === 'string' ? data['error'] : 'slack_error';
      if (error === 'ratelimited') throw new ChannelSendError(error, true, retryAfterOf(response));
      if (SLACK_UNCERTAIN.has(error))
        throw new ChannelSendError(idempotent ? error : 'slack_send_uncertain', idempotent);
      throw new ChannelSendError(error, false);
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
    if (message.link) {
      // 開くだけのボタン（値は持たない。押しても Genie には何も届かない）
      blocks.push({
        type: 'actions',
        elements: [
          {
            type: 'button',
            action_id: 'genie_link',
            text: { type: 'plain_text', text: message.link.label.slice(0, 75) },
            url: message.link.url,
          },
        ],
      });
    }
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
    const data = await this.#call('conversations.open', { users: user }, true);
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
      if (replied.ok) return { providerMessageId: await sentIdOf(replied) };
      // 断られた（届いていない）ものだけ送り直す。期限切れ・使用済みの token（400）は push で、
      // 429 は後で。5xx は受け付けられたかもしれないので、push で二通目を作らない
      // （openclaw extensions/line の canFallbackAfterLineReplyFailure と同じ考え）
      if (replied.status === 429)
        throw new ChannelSendError('line_http_429', true, retryAfterOf(replied));
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
    if (pushed.ok) return { providerMessageId: await sentIdOf(pushed) };
    if (pushed.status === 409) return { providerMessageId: null };
    // push は X-Line-Retry-Key があるので、5xx でも送り直して二通にならない
    throw new ChannelSendError(
      `line_http_${String(pushed.status)}`,
      retryableStatus(pushed.status),
      pushed.status === 429 ? retryAfterOf(pushed) : null,
    );
  }

  /** 送られた写真などの本体。LINE は一定の期間だけ持っているので、受け取ったらすぐ取りに行く。 */
  async content(id: string): Promise<ReceivedContent> {
    if (!/^[0-9A-Za-z]+$/.test(id)) throw new ChannelSendError('line_content_bad_id', false);
    let response: Response;
    try {
      response = await this.fetchImpl(`https://api-data.line.me/v2/bot/message/${id}/content`, {
        headers: { authorization: `Bearer ${this.accessToken}` },
        signal: AbortSignal.timeout(20_000),
      });
    } catch {
      throw new ChannelSendError('line_unreachable', true);
    }
    if (!response.ok) {
      throw new ChannelSendError(
        `line_http_${String(response.status)}`,
        retryableStatus(response.status),
      );
    }
    const length = Number(response.headers.get('content-length'));
    if (Number.isFinite(length) && length > MAX_CONTENT_BYTES) {
      await response.body?.cancel();
      throw new ChannelSendError('line_content_too_large', false);
    }
    const data = new Uint8Array(await response.arrayBuffer());
    if (data.byteLength > MAX_CONTENT_BYTES)
      throw new ChannelSendError('line_content_too_large', false);
    return {
      mediaType: (response.headers.get('content-type') ?? 'application/octet-stream')
        .split(';')[0]!
        .trim(),
      data,
    };
  }

  async memberName(groupId: string, userId: string): Promise<string | null> {
    if (!/^[A-Za-z0-9]+$/.test(groupId) || !/^[A-Za-z0-9]+$/.test(userId)) return null;
    // グループの ID は C、複数人トークは R で始まる
    const kind = groupId.startsWith('R') ? 'room' : 'group';
    try {
      const response = await this.fetchImpl(
        `https://api.line.me/v2/bot/${kind}/${groupId}/member/${userId}`,
        {
          headers: { authorization: `Bearer ${this.accessToken}` },
          signal: AbortSignal.timeout(10_000),
        },
      );
      if (!response.ok) return null;
      const body = (await response.json()) as { displayName?: unknown };
      return typeof body.displayName === 'string' ? body.displayName.slice(0, 50) : null;
    } catch {
      return null;
    }
  }

  /** 1:1 のトークに「読み込み中」を出す（最長 60 秒、次の返信で消える）。グループには出せない。 */
  async typing(target: SendTarget): Promise<void> {
    if (!target.destination.startsWith('U')) return;
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

/**
 * 確かめの選択肢（文の終わりの「はい / いいえ」「はい / 修正する / いいえ」）。LINE ではタップで送れるボタン（Quick Reply）にする。
 * 入力欄に打たなくても答えられる（仕様 v1.0 §6.2）。無ければ null。
 */
export function choicesOf(text: string): string[] | null {
  const m = /(?:^|[\s（(])(はい(?:\s*[\/／]\s*[^\s\/／）)]{1,10}){1,3})[）)]?[。\s]*$/.exec(
    text.trim(),
  );
  if (!m) return null;
  const choices = m[1]!
    .split(/[\/／]/)
    .map((c) => c.trim())
    .filter(Boolean);
  return choices.length >= 2 ? choices.slice(0, 4) : null;
}

const withQuickReply = (message: unknown, choices: readonly QuickReply[] | null): unknown =>
  choices
    ? {
        ...(message as object),
        quickReply: {
          items: choices.map((choice) => {
            const { label, text } =
              typeof choice === 'string' ? { label: choice, text: choice } : choice;
            return { type: 'action', action: { type: 'message', label: label.slice(0, 20), text } };
          }),
        },
      }
    : message;

/** 本文（構造のある答えは Flex Message）と、ボタンがあればボタンのテンプレート（本文 160 字・ラベル 20 字・最大 4 つ）。 */
export function lineMessages(message: OutgoingMessage): unknown[] {
  const messages = lineMessagesWithoutChoices(message);
  // 画像は文の前に（LINE は 1 回に 5 つまで。画像 + 文 + ボタンで収まる）
  const image = message.image && /^https:\/\//.test(message.image.url) ? message.image : null;
  if (image)
    messages.unshift({
      type: 'image',
      originalContentUrl: image.url,
      previewImageUrl: image.previewUrl ?? image.url,
    });
  // 押すボタン（承認）があるときは、そちらで答える。選択肢のボタンは足さない
  if (message.buttons?.length || message.link) return messages;
  const last = messages.length - 1;
  const choices = message.quickReplies?.length
    ? message.quickReplies.slice(0, 13)
    : choicesOf(message.text);
  return messages.map((m, i) => (i === last ? withQuickReply(m, choices) : m));
}

function lineMessagesWithoutChoices(message: OutgoingMessage): unknown[] {
  if (message.link) {
    // 本文（160 字まで）と、開くボタン 1 つ。URL を文に出さない
    return [
      {
        type: 'template',
        altText: message.text.slice(0, 400),
        template: {
          type: 'buttons',
          text: message.text.slice(0, 160),
          actions: [{ type: 'uri', label: message.link.label.slice(0, 20), uri: message.link.url }],
        },
      },
    ];
  }
  // 承認は確認カード（変わるところとボタン）。作れなければ、これまでの文とボタンのテンプレート
  if (message.approval && message.buttons?.length) {
    const card = approvalCard(message.approval, message.buttons, message.approval.note);
    if (card) return [card];
  }
  // 予定・天気・ニュースはカード。構造のある答えは暗い吹き出し（Flex Message）。作れなければ文のまま
  const card = message.card ? cardFor(message.card) : null;
  // 店の候補・予約は、問いかけ（「何時ごろ行く？」）の文を先に、カードをあとに。予定・天気はカードだけ（同じ文）
  if (card && /"schema":"genie\.(?:places|booking)\/v1"/.test(message.card ?? ''))
    return [{ type: 'text', text: message.text.slice(0, 4900) }, card];
  if (card) return [card];
  const rich = message.markdown ? answerFlex(message.markdown, message.text) : null;
  const messages: unknown[] = [rich ?? { type: 'text', text: message.text.slice(0, 4900) }];
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

/**
 * LINE が付けた送信の ID（応答の sentMessages の最初、ふつうは本文）。グループで Genie の返事への
 * 引用返信（quotedMessageId）を見分けるのに使う。取れなければ null。
 */
async function sentIdOf(res: Response): Promise<string | null> {
  try {
    const body = (await res.json()) as { sentMessages?: { id?: unknown }[] };
    const id = body.sentMessages?.[0]?.id;
    return typeof id === 'string' ? id : null;
  } catch {
    return null;
  }
}
