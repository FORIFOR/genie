/**
 * 監査イベント。正本 §21、実装仕様 §13.2。受け入れテスト AC-15。
 *
 * append-only なだけでは「後から書き換えられていない」ことを示せないので、
 * テナントごとにハッシュ連鎖を張る。
 *
 *   hash(n) = sha256(canonicalJson({ ...row(n), prev_hash: hash(n-1) }))
 *
 * 連鎖リンクは**保存済みの hash** を辿る。そのため 1 行だけ書き換えられた場合、
 * 壊れるのはその行の `hash_mismatch` だけになり、どの行が改変されたか一意に分かる。
 * 改竄者が hash も付け替えたなら、後続の `prev_hash` が合わなくなって `broken_link` が出る。
 *
 * DB 側では `audit_events_append_only` トリガが UPDATE / DELETE / TRUNCATE を拒否する。
 *
 * 限界: 連鎖**全体**を整合的に作り直されると、この仕組みだけでは検出できない。
 * 定期的に最新 hash を外部（別システム / WORM ストレージ）へ固定する運用が要る。
 * Phase 0 の範囲外（実装仕様 §18 OQ-10）。
 */
import { canonicalSha256, uuidv7, type Sha256Hex } from '@genie/contracts';
import { sql, type ScopedDb } from './db.js';

/** 監査必須イベント。実装仕様 §13.2。 */
export const AUDIT_ACTIONS = [
  'session.created',
  'session.rotated',
  'session.reuse_detected',
  'session.revoked',
  'plugin.install',
  'plugin.update',
  'plugin.rollback',
  'plugin.uninstall',
  'plugin.permission.grant',
  'plugin.permission.revoke',
  'approval.requested',
  'approval.decided',
  'approval.expired',
  'transaction.authorization.created',
  'transaction.authorization.reserved',
  'transaction.authorization.revoked',
  'task.created',
  'task.cancelled',
  'artifact.created',
  'artifact.downloaded',
  // Phase 2: 共有は外部への公開なので必ず監査に残す（正本 §2.3）
  'artifact.shared',
  'artifact.share_revoked',
  'artifact.share_accessed',
  'host.capability_denied',
] as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[number];

export interface AuditEventInput {
  readonly actorType: 'user' | 'agent' | 'system' | 'service';
  readonly actorId?: string | null;
  readonly action: AuditAction;
  readonly taskId?: string | null;
  readonly toolId?: string | null;
  /** 外部に副作用が出たか。事故調査で最初に絞り込む軸なので必ず正しく立てる。 */
  readonly externalEffect?: boolean;
  readonly payload?: Record<string, unknown>;
}

/** ハッシュ計算の対象。ここに含めない列は改竄を検出できない。 */
export interface AuditHashInput {
  readonly tenant_id: string;
  readonly seq: number;
  readonly actor_type: string;
  readonly actor_id: string | null;
  readonly action: string;
  readonly task_id: string | null;
  readonly tool_id: string | null;
  readonly external_effect: boolean;
  readonly payload: Record<string, unknown>;
  readonly created_at: string;
  readonly prev_hash: string | null;
}

/**
 * ハッシュ対象の列だけを明示的に取り出してから正規化する。
 * 呼び出し側が `hash` 付きの行をそのまま渡しても混入しないようにするため、
 * スプレッドではなく列挙で組み立てる（構造的型付けでは余分なプロパティを型で防げない）。
 */
export function computeAuditHash(row: AuditHashInput): Promise<Sha256Hex> {
  return canonicalSha256({
    tenant_id: row.tenant_id,
    seq: row.seq,
    actor_type: row.actor_type,
    actor_id: row.actor_id,
    action: row.action,
    task_id: row.task_id,
    tool_id: row.tool_id,
    external_effect: row.external_effect,
    payload: row.payload,
    created_at: row.created_at,
    prev_hash: row.prev_hash,
  }) as Promise<Sha256Hex>;
}

export type AuditChainProblem =
  | { kind: 'sequence_gap'; seq: number; expected: number }
  | { kind: 'broken_link'; seq: number }
  | { kind: 'hash_mismatch'; seq: number };

/**
 * 連鎖を検証する。空配列は「連鎖なし」で正常。
 * 先頭は seq=1 かつ prev_hash=null であることを要求する（DB の CHECK と同じ規則）。
 */
export async function verifyAuditChain(
  rows: readonly (AuditHashInput & { hash: string })[],
): Promise<AuditChainProblem[]> {
  const problems: AuditChainProblem[] = [];
  let expectedSeq = 1;
  let previousHash: string | null = null;

  for (const row of rows) {
    if (row.seq !== expectedSeq) {
      problems.push({ kind: 'sequence_gap', seq: row.seq, expected: expectedSeq });
      expectedSeq = row.seq;
    }
    if (row.prev_hash !== previousHash) {
      problems.push({ kind: 'broken_link', seq: row.seq });
    }
    if ((await computeAuditHash(row)) !== row.hash) {
      problems.push({ kind: 'hash_mismatch', seq: row.seq });
    }
    previousHash = row.hash;
    expectedSeq += 1;
  }
  return problems;
}

/**
 * 監査イベントを追記する。**テナントスコープのトランザクション内で呼ぶこと。**
 *
 * `audit_sequences` の行を `UPDATE ... RETURNING` で更新することで、
 * 同一テナントの追記がトランザクション単位で直列化される。ハッシュ連鎖は
 * 直列化されていないと成立しないので、この行ロックが連鎖の要になっている。
 */
export async function appendAuditEvent(
  tx: ScopedDb,
  tenantId: string,
  input: AuditEventInput,
): Promise<{ id: string; seq: number; hash: string }> {
  await sql`
    insert into audit_sequences (tenant_id) values (${tenantId})
    on conflict (tenant_id) do nothing
  `.execute(tx);

  const allocated = await sql<{ seq: string }>`
    update audit_sequences set next_seq = next_seq + 1
     where tenant_id = ${tenantId}
     returning (next_seq - 1)::text as seq
  `.execute(tx);

  const seqText = allocated.rows[0]?.seq;
  if (seqText === undefined) {
    throw new Error(`audit sequence row missing for tenant ${tenantId}`);
  }
  const seq = Number(seqText);

  const previous = await sql<{ hash: string }>`
    select hash from audit_events
     where tenant_id = ${tenantId} and seq = ${seq - 1}
  `.execute(tx);
  const prevHash = previous.rows[0]?.hash ?? null;

  if (seq === 1 && prevHash !== null) throw new Error('audit chain root must not have a prev_hash');
  if (seq > 1 && prevHash === null) throw new Error(`audit chain broken before seq ${seq}`);

  const createdAt = new Date().toISOString();
  const row: AuditHashInput = {
    tenant_id: tenantId,
    seq,
    actor_type: input.actorType,
    actor_id: input.actorId ?? null,
    action: input.action,
    task_id: input.taskId ?? null,
    tool_id: input.toolId ?? null,
    external_effect: input.externalEffect ?? false,
    payload: input.payload ?? {},
    created_at: createdAt,
    prev_hash: prevHash,
  };
  const hash = await computeAuditHash(row);
  const id = uuidv7();

  await tx
    .insertInto('audit_events')
    .values({
      id,
      tenant_id: row.tenant_id,
      seq: String(row.seq),
      actor_type: row.actor_type,
      actor_id: row.actor_id,
      action: row.action,
      task_id: row.task_id,
      tool_id: row.tool_id,
      external_effect: row.external_effect,
      payload: JSON.stringify(row.payload),
      prev_hash: row.prev_hash,
      hash,
      created_at: row.created_at,
    })
    .execute();

  return { id, seq, hash };
}

/** テナントの連鎖を seq 昇順で読み出す。検証と監査エクスポート用。 */
export async function readAuditChain(
  tx: ScopedDb,
  tenantId: string,
): Promise<(AuditHashInput & { hash: string })[]> {
  // 注意: bigint を text へ落とすとき、**元の列と同じ別名を付けない**こと。
  // PostgreSQL の ORDER BY は出力列の別名を優先するため、`seq::text as seq` と書くと
  // `order by seq` が text の辞書順（1, 10, 11, 12, 2, ...）になる。
  const rows = await sql<{
    tenant_id: string;
    seq_text: string;
    actor_type: string;
    actor_id: string | null;
    action: string;
    task_id: string | null;
    tool_id: string | null;
    external_effect: boolean;
    payload: Record<string, unknown>;
    created_at: Date;
    prev_hash: string | null;
    hash: string;
  }>`
    select tenant_id, seq::text as seq_text, actor_type, actor_id, action, task_id, tool_id,
           external_effect, payload, created_at, prev_hash, hash
      from audit_events
     where tenant_id = ${tenantId}
     order by audit_events.seq asc
  `.execute(tx);

  return rows.rows.map((r) => ({
    tenant_id: r.tenant_id,
    seq: Number(r.seq_text),
    actor_type: r.actor_type,
    actor_id: r.actor_id,
    action: r.action,
    task_id: r.task_id,
    tool_id: r.tool_id,
    external_effect: r.external_effect,
    payload: r.payload,
    // timestamptz は Date で返るので、ハッシュ対象の表現へ戻す
    created_at: r.created_at.toISOString(),
    prev_hash: r.prev_hash,
    hash: r.hash,
  }));
}
