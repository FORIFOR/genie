/**
 * 受信箱。**同じ配信を二度受けない。**
 *
 * Slack は 3 秒以内に 200 を返さないと、同じ `event_id` で最大 3 回送り直す。
 * LINE も失敗すると再配信する。鍵は提供者の配信 ID で、テナントが決まる前に引ける必要がある
 * （連携を照合する前に、重複かどうかは分かっていたい）。
 *
 * 本番の実装は `channel_inbox` テーブル（主キー `(provider, event_id)`）に置く。
 * ここには仕事の本文を書かない。中身はテナントが決まってから会話（turns）に入る。
 */
import type { ChannelProvider } from '@genie/contracts';

export interface ChannelInbox {
  /**
   * 初めての配信なら true を返し、受けたことを記録する。
   * 二度目以降は false。**記録と判定は 1 つの操作**（取り合いで両方 true にならない）。
   */
  claim(provider: ChannelProvider, eventId: string): Promise<boolean>;
}

/**
 * メモリ上の受信箱。テストと単一プロセスの試用のため。
 *
 * 期限を過ぎた鍵は捨てる。提供者の再送は数分で終わるので、
 * それより長く覚えておけば足りる。
 */
export class MemoryChannelInbox implements ChannelInbox {
  readonly #seen = new Map<string, number>();
  readonly #ttlMs: number;
  readonly #now: () => number;

  constructor(options: { ttlMs?: number; now?: () => number } = {}) {
    this.#ttlMs = options.ttlMs ?? 24 * 60 * 60 * 1000;
    this.#now = options.now ?? Date.now;
  }

  async claim(provider: ChannelProvider, eventId: string): Promise<boolean> {
    const now = this.#now();
    for (const [key, at] of this.#seen) {
      if (now - at > this.#ttlMs) this.#seen.delete(key);
    }
    const key = `${provider}:${eventId}`;
    if (this.#seen.has(key)) return false;
    this.#seen.set(key, now);
    return true;
  }
}
