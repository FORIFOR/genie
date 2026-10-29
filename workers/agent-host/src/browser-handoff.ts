/**
 * ブラウザの引き継ぎ（端末の側。gateway は services/api-gateway/src/browser-handoff.ts）。
 *
 *   読むページがログインの壁（パスワードの欄）だった → gateway に引き継ぎを頼む（本人に LINE でリンク）
 *   → 画面の流れを gateway へ送り、本人の操作（押す・スクロール・文字・キー）を取りに行って、そのまま当てる
 *   → パスワードの欄が消えた（ログインが済んだ）か「Genie に戻す」で、続きを読む
 *
 * 守ること:
 *   - 引き継ぎの間、Genie は自分では入力しない（当てるのは本人の操作だけ）
 *   - 画面・入力の中身はどこにも残さない（ログにも書かない。送るのは gateway のメモリまで）
 *   - step の上限（5 分）より前に終える（既定 3 分。続きを読んで答える時間を残す）
 *   - gateway から端末へは繋がない。端末から取りに行く（長く待つ問い合わせ）
 */
import type { Frame, SessionKey } from './browser-session.js';

export type HandoffInput =
  | { readonly type: 'tap'; readonly x: number; readonly y: number }
  | {
      readonly type: 'scroll';
      readonly x: number;
      readonly y: number;
      readonly dx: number;
      readonly dy: number;
    }
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'key'; readonly name: SessionKey }
  | { readonly type: 'done' }
  | { readonly type: 'cancel' };

export type HandoffEnd = 'resumed' | 'timed_out' | 'cancelled' | 'failed';

/** 引き継ぎで使うブラウザの操作（BrowserSession のうち、ここで使うものだけ）。 */
export interface HandoffSession {
  startScreencast(listener: (frame: Frame) => void): Promise<void>;
  stopScreencast(): Promise<void>;
  setMobile(on: boolean): Promise<void>;
  passwordFocused(): Promise<boolean>;
  hasPasswordField(): Promise<boolean>;
  tap(x: number, y: number): Promise<void>;
  scroll(x: number, y: number, dx: number, dy: number): Promise<void>;
  insertText(text: string): Promise<void>;
  key(name: SessionKey): Promise<void>;
  settle(signal: AbortSignal, extraMs?: number): Promise<void>;
}

/** gateway との話（端末はサインイン済み。その step を取っている端末だけが頼める）。 */
export interface HandoffApi {
  start(requestId: string, site: string): Promise<{ id: string } | { problem: string }>;
  frame(
    id: string,
    frame: { jpeg: string; width: number; height: number; password: boolean },
  ): Promise<void>;
  take(id: string, waitMs: number): Promise<{ inputs: HandoffInput[]; ended: HandoffEnd | null }>;
  end(id: string, state: HandoffEnd): Promise<void>;
}

export function httpHandoffApi(config: {
  readonly baseUrl: string;
  readonly hostId: string;
  readonly fetch: typeof fetch;
}): HandoffApi {
  const post = async (path: string, body: Record<string, unknown>, timeoutMs = 15_000) =>
    config.fetch(`${config.baseUrl}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ host_id: config.hostId, ...body }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  return {
    async start(requestId, site) {
      const res = await post('/v1/browser-handoffs', { request_id: requestId, site });
      if (res.status === 201) return { id: ((await res.json()) as { id: string }).id };
      const error = res.status === 409 ? ((await res.json()) as { error?: string }).error : null;
      return {
        problem:
          error === 'no_public_place'
            ? 'LINE から画面を開く場所（トンネル・LIFF）が設定されていないため、ログインをお願いできませんでした。'
            : error === 'not_delivered'
              ? 'LINE にログインのお願いを届けられませんでした。'
              : 'ログインをお願いする準備ができませんでした。',
      };
    },
    async frame(id, frame) {
      await post(`/v1/browser-handoffs/${id}/frame`, frame);
    },
    async take(id, waitMs) {
      const res = await post(
        `/v1/browser-handoffs/${id}/inputs`,
        { wait_ms: waitMs },
        waitMs + 10_000,
      );
      if (!res.ok) return { inputs: [], ended: 'failed' };
      return (await res.json()) as { inputs: HandoffInput[]; ended: HandoffEnd | null };
    },
    async end(id, state) {
      await post(`/v1/browser-handoffs/${id}/end`, { state });
    },
  };
}

/** 本人にログインしてもらう。終わり方を返す（resumed なら、続きを読んでよい）。 */
export async function handOff(
  session: HandoffSession,
  api: HandoffApi,
  input: {
    readonly requestId: string;
    readonly site: string;
    readonly signal: AbortSignal;
    readonly limitMs?: number;
    readonly now?: () => number;
  },
): Promise<{ end: HandoffEnd } | { problem: string }> {
  const started = await api.start(input.requestId, input.site);
  if ('problem' in started) return started;
  const id = started.id;
  const now = input.now ?? Date.now;
  const deadline = now() + (input.limitMs ?? 180_000);
  let end: HandoffEnd = 'timed_out';

  // 画面はいちばん新しい 1 枚だけを送る（送っている間に来たものは、次に新しいものだけ）
  let pending: Frame | null = null;
  let sending = false;
  const flush = async (): Promise<void> => {
    if (sending || !pending) return;
    sending = true;
    const frame = pending;
    pending = null;
    const password = await session.passwordFocused().catch(() => false);
    await api
      .frame(id, {
        jpeg: frame.jpeg.toString('base64'),
        width: frame.width,
        height: frame.height,
        password,
      })
      .catch(() => undefined);
    sending = false;
    void flush();
  };

  try {
    await session.setMobile(true);
    await session.startScreencast((frame) => {
      pending = frame;
      void flush();
    });
    loop: while (now() < deadline) {
      input.signal.throwIfAborted();
      const taken = await api.take(id, Math.max(0, Math.min(20_000, deadline - now())));
      if (taken.ended) {
        end = taken.ended === 'cancelled' ? 'cancelled' : 'timed_out';
        break;
      }
      for (const action of taken.inputs) {
        if (action.type === 'cancel') {
          end = 'cancelled';
          break loop;
        }
        if (action.type === 'done') {
          end = 'resumed';
          break loop;
        }
        await apply(session, action).catch(() => undefined);
      }
      // 本人が操作したあと、ログインが済んだか（パスワードの欄が消えたか）を画面で確かめる
      if (taken.inputs.length > 0) {
        await session.settle(input.signal, 600).catch(() => undefined);
        if (!(await session.hasPasswordField().catch(() => true))) {
          end = 'resumed';
          break;
        }
      }
    }
  } catch (error) {
    end = input.signal.aborted ? 'cancelled' : 'failed';
    if (!input.signal.aborted) void error;
  } finally {
    await session.stopScreencast().catch(() => undefined);
    await session.setMobile(false).catch(() => undefined);
    await api.end(id, end).catch(() => undefined);
  }
  return { end };
}

async function apply(session: HandoffSession, action: HandoffInput): Promise<void> {
  switch (action.type) {
    case 'tap':
      return session.tap(action.x, action.y);
    case 'scroll':
      return session.scroll(action.x, action.y, action.dx, action.dy);
    case 'text':
      return session.insertText(action.text);
    case 'key':
      return session.key(action.name);
    default:
      return;
  }
}
