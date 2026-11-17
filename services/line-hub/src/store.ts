/**
 * 中継の控え（SQLite、1 ファイル）。
 *
 *   installs        各利用者の Genie（Mac）。鍵はハッシュだけ
 *   routes          LINE の利用者・グループ → どの Genie へ届けるか
 *   codes           連携コードのハッシュ → どの Genie が出したか（10 分）
 *   queue           届ける前の知らせ（Genie が寝ている間はここで待つ。24 時間で捨てる）
 *   delivered       Genie へ届けた ID（返信の token・写真の ID・宛先）。その Genie に許す LINE の操作を絞るため
 *
 * **本文は届けるまでしか持たない。**届けて受け取りの返事（ack）が来たら消す。
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const QUEUE_TTL_MS = 24 * 3600 * 1000;
/** 届けた ID を、その Genie の操作に許す長さ（LINE の reply token は 1 分、写真は数日持つ）。 */
const DELIVERED_TTL_MS = 6 * 3600 * 1000;

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

export type RouteKind = 'user' | 'group';
export type DeliveredKind = 'reply_token' | 'message' | 'target';

export interface QueuedEvent {
  readonly id: number;
  readonly installId: string;
  readonly payload: string;
}

export class HubStore {
  readonly #db: DatabaseSync;
  readonly #now: () => number;

  constructor(path: string, now: () => number = Date.now) {
    this.#db = new DatabaseSync(path);
    this.#now = now;
    this.#db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS installs (
        id TEXT PRIMARY KEY, secret_hash TEXT NOT NULL, created_at INTEGER NOT NULL, last_seen_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS routes (
        kind TEXT NOT NULL, line_id TEXT NOT NULL, install_id TEXT NOT NULL, updated_at INTEGER NOT NULL,
        PRIMARY KEY (kind, line_id)
      );
      CREATE TABLE IF NOT EXISTS codes (
        code_hash TEXT PRIMARY KEY, install_id TEXT NOT NULL, expires_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS queue (
        id INTEGER PRIMARY KEY AUTOINCREMENT, install_id TEXT NOT NULL, payload TEXT NOT NULL, created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS queue_by_install ON queue (install_id, id);
      CREATE TABLE IF NOT EXISTS delivered (
        install_id TEXT NOT NULL, kind TEXT NOT NULL, value TEXT NOT NULL, expires_at INTEGER NOT NULL,
        PRIMARY KEY (install_id, kind, value)
      );
    `);
  }

  close(): void {
    this.#db.close();
  }

  /** Genie を 1 つ登録する。鍵は返すだけで、残すのはハッシュ。 */
  register(): { installId: string; secret: string } {
    const installId = `gi_${randomBytes(9).toString('base64url')}`;
    const secret = randomBytes(32).toString('base64url');
    this.#db
      .prepare('INSERT INTO installs (id, secret_hash, created_at) VALUES (?, ?, ?)')
      .run(installId, sha256(secret), this.#now());
    return { installId, secret };
  }

  authenticate(installId: string, secret: string): boolean {
    const row = this.#db.prepare('SELECT secret_hash FROM installs WHERE id = ?').get(installId) as
      { secret_hash: string } | undefined;
    if (!row) return false;
    const want = Buffer.from(row.secret_hash, 'hex');
    const got = Buffer.from(sha256(secret), 'hex');
    const ok = want.length === got.length && timingSafeEqual(want, got);
    if (ok)
      this.#db
        .prepare('UPDATE installs SET last_seen_at = ? WHERE id = ?')
        .run(this.#now(), installId);
    return ok;
  }

  route(kind: RouteKind, lineId: string): string | null {
    const row = this.#db
      .prepare('SELECT install_id FROM routes WHERE kind = ? AND line_id = ?')
      .get(kind, lineId) as { install_id: string } | undefined;
    return row?.install_id ?? null;
  }

  setRoute(kind: RouteKind, lineId: string, installId: string): void {
    this.#db
      .prepare(
        `INSERT INTO routes (kind, line_id, install_id, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (kind, line_id) DO UPDATE SET install_id = excluded.install_id, updated_at = excluded.updated_at`,
      )
      .run(kind, lineId, installId, this.#now());
  }

  /** その Genie の道だけを外す（ほかの Genie の道は外せない）。 */
  releaseRoute(kind: RouteKind, lineId: string, installId: string): void {
    this.#db
      .prepare('DELETE FROM routes WHERE kind = ? AND line_id = ? AND install_id = ?')
      .run(kind, lineId, installId);
  }

  claimCode(codeHash: string, installId: string, expiresAt: number): void {
    this.#db
      .prepare(
        `INSERT INTO codes (code_hash, install_id, expires_at) VALUES (?, ?, ?)
         ON CONFLICT (code_hash) DO UPDATE SET install_id = excluded.install_id, expires_at = excluded.expires_at`,
      )
      .run(codeHash, installId, Math.min(expiresAt, this.#now() + 15 * 60 * 1000));
  }

  /** 連携コードの持ち主（1 回だけ。使ったら消す）。 */
  takeCode(codeHash: string): string | null {
    const row = this.#db
      .prepare('SELECT install_id, expires_at FROM codes WHERE code_hash = ?')
      .get(codeHash) as { install_id: string; expires_at: number } | undefined;
    this.#db.prepare('DELETE FROM codes WHERE code_hash = ?').run(codeHash);
    return row && row.expires_at > this.#now() ? row.install_id : null;
  }

  enqueue(installId: string, payload: string): number {
    const result = this.#db
      .prepare('INSERT INTO queue (install_id, payload, created_at) VALUES (?, ?, ?)')
      .run(installId, payload, this.#now());
    return Number(result.lastInsertRowid);
  }

  pending(installId: string, limit = 100): QueuedEvent[] {
    return (
      this.#db
        .prepare(
          'SELECT id, install_id, payload FROM queue WHERE install_id = ? ORDER BY id LIMIT ?',
        )
        .all(installId, limit) as { id: number; install_id: string; payload: string }[]
    ).map((r) => ({ id: r.id, installId: r.install_id, payload: r.payload }));
  }

  ack(installId: string, id: number): void {
    this.#db.prepare('DELETE FROM queue WHERE id = ? AND install_id = ?').run(id, installId);
  }

  markDelivered(installId: string, kind: DeliveredKind, value: string): void {
    this.#db
      .prepare(
        `INSERT INTO delivered (install_id, kind, value, expires_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (install_id, kind, value) DO UPDATE SET expires_at = excluded.expires_at`,
      )
      .run(installId, kind, value, this.#now() + DELIVERED_TTL_MS);
  }

  wasDelivered(installId: string, kind: DeliveredKind, value: string): boolean {
    const row = this.#db
      .prepare('SELECT expires_at FROM delivered WHERE install_id = ? AND kind = ? AND value = ?')
      .get(installId, kind, value) as { expires_at: number } | undefined;
    return row !== undefined && row.expires_at > this.#now();
  }

  /** 古いものを捨てる（届かなかった知らせ・期限の切れたコードと ID）。 */
  prune(): void {
    const now = this.#now();
    this.#db.prepare('DELETE FROM queue WHERE created_at < ?').run(now - QUEUE_TTL_MS);
    this.#db.prepare('DELETE FROM codes WHERE expires_at < ?').run(now);
    this.#db.prepare('DELETE FROM delivered WHERE expires_at < ?').run(now);
  }
}
