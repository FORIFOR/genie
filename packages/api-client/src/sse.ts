/**
 * タスクイベントの購読。実装仕様 §7.3、ADR 0003。
 *
 * `EventSource` を使わない。独自ヘッダ（Authorization）を付けられないため。
 * `fetch` + ReadableStream で読み、切断時は `Last-Event-ID` から再開する。
 *
 * 守る性質:
 *   - **欠番を見つけたら黙って進めない。**その番号から取り直す。
 *     sequence の連続性はサーバとの契約なので、クライアントが握り潰すと
 *     取りこぼしに誰も気づけなくなる。
 *   - 重複は捨てる。再接続の境界で同じイベントが二度届き得る。
 */
import { decodeEvent, type EventEnvelope } from '@genie/contracts';
import type { HttpClient } from './http.js';

export interface StreamOptions {
  /** ここまでは受け取り済み。0 なら最初から。 */
  readonly after?: number;
  readonly signal?: AbortSignal;
  /** 再接続の待ち時間。試行回数を受け取る。 */
  readonly backoffMs?: (attempt: number) => number;
  /** 再接続の上限。超えたら諦めて理由を返す。 */
  readonly maxAttempts?: number;
  onEvent(event: EventEnvelope): void;
  /** 未知の type。sequence だけ進めて無視する（実装仕様 §3.8）。 */
  onUnknown?(sequence: number, type: string): void;
  onReconnect?(attempt: number, reason: string): void;
}

const TERMINAL = new Set([
  'task.completed',
  'task.failed',
  'task.cancelled',
  // 会議も終端を持つ。無いと終わった会議の購読が閉じない。
  'meeting.ended',
]);

const defaultBackoff = (attempt: number): number => Math.min(250 * 2 ** attempt, 10_000);

/** SSE のテキストを 1 フレームずつ切り出す。 */
export function parseSseFrames(chunk: string): { id?: number; event?: string; data?: string }[] {
  return chunk
    .replace(/\r\n|\r/g, '\n')
    .split('\n\n')
    .map((block) => {
      const frame: { id?: number; event?: string; data?: string } = {};
      const data: string[] = [];
      for (const line of block.split('\n')) {
        if (line.startsWith(':')) continue;
        const colon = line.indexOf(':');
        const field = colon < 0 ? line : line.slice(0, colon);
        const raw = colon < 0 ? '' : line.slice(colon + 1);
        const value = raw.startsWith(' ') ? raw.slice(1) : raw;
        if (field === 'id' && /^\d+$/.test(value)) frame.id = Number(value);
        else if (field === 'event') frame.event = value;
        else if (field === 'data') data.push(value);
      }
      if (data.length) frame.data = data.join('\n');
      return frame;
    })
    .filter((frame) => frame.data !== undefined);
}

/**
 * タスクのイベント列を、終端イベントまで購読し続ける。
 * 戻り値は最後に受け取った sequence。
 */
export async function streamTaskEvents(
  http: HttpClient,
  taskId: string,
  options: StreamOptions,
): Promise<number> {
  return streamEvents(http, `/v1/tasks/${taskId}/stream`, options);
}

/** 会議のイベント列。終端は `meeting.ended`。 */
export async function streamMeetingEvents(
  http: HttpClient,
  meetingId: string,
  options: StreamOptions,
): Promise<number> {
  return streamEvents(http, `/v1/meetings/${meetingId}/stream`, options);
}

/**
 * イベント列を、終端イベントまで購読し続ける。戻り値は最後に受け取った sequence。
 * 経路が違うだけで、欠番検知も再接続も task と会議で同じでよい。
 */
async function streamEvents(
  http: HttpClient,
  path: string,
  options: StreamOptions,
): Promise<number> {
  const backoff = options.backoffMs ?? defaultBackoff;
  const maxAttempts = options.maxAttempts ?? 8;
  let cursor = options.after ?? 0;
  let attempt = 0;

  while (!options.signal?.aborted) {
    let reason = 'stream ended';
    try {
      const done = await readOnce(http, path, cursor, options, (sequence) => {
        cursor = sequence;
        // 一度でも進めたら再接続の回数をやり直す。
        // 長時間のタスクで序盤の失敗が後半の予算を食わないようにする。
        attempt = 0;
      });
      if (done) return cursor;
    } catch (error) {
      reason = error instanceof Error ? error.message : String(error);
      if (options.signal?.aborted) return cursor;
    }

    attempt += 1;
    if (attempt > maxAttempts) return cursor;
    options.onReconnect?.(attempt, reason);
    await delay(backoff(attempt), options.signal);
  }

  return cursor;
}

async function readOnce(
  http: HttpClient,
  path: string,
  after: number,
  options: StreamOptions,
  advance: (sequence: number) => void,
): Promise<boolean> {
  const headers = await http.headers({ accept: 'text/event-stream' });
  if (after > 0) headers.set('last-event-id', String(after));

  const response = await fetchWith(http, path, headers, options.signal);
  if (!response.ok || !response.body) {
    throw new Error(`stream refused with ${response.status}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let previousCR = false;
  let expected = after + 1;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return false;

      // Normalize line endings incrementally: a CRLF may straddle byte chunks.
      for (const character of decoder.decode(value, { stream: true })) {
        if (character === '\n' && previousCR) {
          previousCR = false;
          continue;
        }
        buffer += character === '\r' ? '\n' : character;
        previousCR = character === '\r';
      }
      // 最後の未完成フレームは次の chunk まで持ち越す
      const boundary = buffer.lastIndexOf('\n\n');
      if (boundary < 0) continue;
      const complete = buffer.slice(0, boundary + 2);
      buffer = buffer.slice(boundary + 2);

      for (const frame of parseSseFrames(complete)) {
        const decoded = decodeEvent(JSON.parse(frame.data!));
        const sequence = decoded.event.sequence;

        // 既に見たものは捨てる（再接続の境界で重複し得る）
        if (sequence < expected) continue;
        if (sequence > expected) {
          // 欠番。ここから取り直す。黙って飛ばさない。
          throw new Error(`sequence gap: expected ${expected}, received ${sequence}`);
        }

        if (decoded.known) options.onEvent(decoded.event);
        else options.onUnknown?.(sequence, decoded.event.type);
        // A failed consumer must receive this event again on reconnect.
        expected = sequence + 1;
        advance(sequence);
        if (decoded.known && TERMINAL.has(decoded.event.type)) return true;
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

async function fetchWith(
  http: HttpClient,
  path: string,
  headers: Headers,
  signal?: AbortSignal,
): Promise<Response> {
  return http.fetcher(http.urlFor(path), {
    headers,
    ...(signal ? { signal } : {}),
  });
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}
