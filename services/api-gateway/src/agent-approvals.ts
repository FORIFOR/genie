/**
 * Claude Code の承認を LINE から（本人の方針 2026-10-30）。
 * 「承認の要求を LINE へ転送する Bot」ではなく、何の作業の・何の操作か・リスク・承認の範囲・実行の結果を
 * ひとつにした承認にする。
 *
 *   Claude Code が許可を求める（PermissionRequest。hooks は同期で待つ: scripts/claude-code-permission.sh）
 *     → POST /v1/agent-approvals/claude-code
 *         本人が前もって許した同種の操作（継続許可のルール）に当たれば、その場で許可して返す（記録は残す）
 *         当たらなければ本人の LINE の 1:1 にカード（プロジェクト・作業・操作・リスク・期限）
 *   本人の答え: 今回だけ承認 / 拒否 / 指示を添える / このセッションで同種を許可 / このプロジェクトで同種を常に許可
 *   hooks は POST /v1/agent-approvals/:id/wait で答えを取りに来て、Claude Code へ返す
 *   経過は 受け付けた（decided_at）→ Claude Code に渡した（delivered_at）→ 実行を確かめた（result）と分けて残す。
 *   LINE で答えたものは、実行を確かめたら（同じ入力の PostToolUse）本人に知らせる。
 *
 * 実機で確かめたこと（2026-10-30、Claude Code 2.1.312〜314）:
 *   - hooks が待っている間も Mac の画面には同じ問いが出る。先に答えたほうが通る
 *   - hooks が何も返さずに終われば、Mac の問いがそのまま残る（LINE が使えないときの逃げ道）
 *   - Mac で先に答えても hooks は止められない。だから後の出来事（同じ入力の PostToolUse など）で取り下げる
 *
 * 守ること:
 *   - **Genie は自分の判断では承認しない。**答えるのは本人のボタン・文と、本人が作った継続許可のルールだけ
 *   - 継続許可は agent-approval-policy.ts で「継続許可にしてよい」とした種類だけ。問いが来るたびに評価し直す
 *   - カードに載せるのは秘密を伏せた写し（redactSecrets）。写しはこのプロセスのメモリだけ。DB には残さない
 *   - ボタンは 1 回だけ。本人・待っている・期限内のときだけ通す（同時に押しても 1 回だけ）
 */
import { createHash } from 'node:crypto';
import { basename, relative } from 'node:path';
import { sql } from 'kysely';
import { uuidv7 } from '@genie/contracts';
import { withTenant, type DbHandle } from '@genie/db';
import {
  classify,
  ruleFor,
  shownPath,
  type ApprovalRule,
  type OperationClass,
  type Risk,
} from './agent-approval-policy.js';
import type { AgentConnection } from './agent-sessions.js';

/** hooks の待ちの上限（Claude Code の hooks の既定 600 秒）より短く。 */
export const APPROVAL_MINUTES = 9;
/** 「指示を添える」を押してから、指示の文を待つ時間。 */
const INSTRUCTION_MS = 5 * 60_000;
/** 答えたあと、実行の結果（PostToolUse）を待つ時間。 */
const RESULT_MS = 15 * 60_000;

export type ApprovalChoice = 'allow' | 'deny' | 'instruct' | 'allow_session' | 'allow_project';
export type ApprovalState =
  'pending' | 'allowed' | 'denied' | 'auto_allowed' | 'answered_on_mac' | 'expired' | 'ended';

/** Claude Code へ返す答え。none は「何も返さない」（Mac の問いに任せる）。 */
export type HookDecision =
  | { readonly behavior: 'allow' }
  | { readonly behavior: 'deny'; readonly message: string }
  | { readonly behavior: 'none' };

/** プロジェクト（git の根）。分からなければ cwd をそのまま根にする。 */
export interface ProjectInfo {
  readonly root: string;
  readonly name: string;
  readonly branch: string | null;
}

/** カードに載せる写し（秘密を伏せたもの）。取れなかったものは null（推して埋めない）。 */
export interface ApprovalView {
  readonly id: string;
  /** カードどうしを見分ける短い番号（id の末尾）。 */
  readonly number: string;
  readonly agent: string;
  readonly project: string | null;
  readonly branch: string | null;
  /** 実行する場所（プロジェクトからの道。ホームは ~）。 */
  readonly workdir: string | null;
  /** 作業（Claude Code の最初の頼みの頭。秘密は伏せる）。無ければ null（未確認）。 */
  readonly task: string | null;
  /** Genie の仕事に結び付いていれば、その名前（null =「タスク未紐付け」）。 */
  readonly genieTask: string | null;
  readonly tool: string;
  /** 何をしようとしているか（1 行）。 */
  readonly summary: string;
  readonly details: readonly { readonly label: string; readonly value: string }[];
  /** 操作の種類とリスク。 */
  readonly operation: string;
  readonly risk: Risk;
  /** 継続許可を出せるか（出せなければ理由）。 */
  readonly ruleable: boolean;
  readonly notRuleableReason: string | null;
  readonly expiresAt: Date;
}

// ---- 秘密を伏せる ----

const SECRET_PREFIX =
  /\b(?:sk-(?:ant-)?|sk_live_|sk_test_|pk_live_|rk_live_|ghp_|gho_|ghs_|ghu_|github_pat_|glpat-|xox[abprs]-|AKIA|ASIA|AIza|gac_|ya29\.|hf_|npm_)[A-Za-z0-9._-]{8,}/g;
const SECRET_ASSIGN =
  /\b([A-Za-z0-9_.-]*(?:secret|token|passw(?:or)?d|passwd|api[_-]?key|apikey|access[_-]?key|private[_-]?key|credential|auth)[A-Za-z0-9_.-]*)(\s*[:=]\s*|\s+)(["']?)([^\s"'&;|]{4,})\3/gi;
const BEARER = /\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]{8,}/gi;
const URL_USER = /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi;
const PEM =
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g;
const LONG_TOKEN = /[A-Za-z0-9+/_=-]{40,}/g;
const JWT = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g;

/**
 * 鍵・パスワード・トークンらしいものを「•••」に置き換える。外のサービス（LINE）を通す前に必ず通す。
 * 迷ったら伏せる（長いランダムな文字列は、ハッシュやコミットでも伏せる）。
 */
export function redactSecrets(text: string): string {
  return text
    .replace(PEM, '•••（秘密鍵）')
    .replace(URL_USER, '$1•••@')
    .replace(BEARER, '$1 •••')
    .replace(JWT, '•••')
    .replace(SECRET_PREFIX, '•••')
    .replace(
      SECRET_ASSIGN,
      (_m, key: string, sep: string, quote: string) => `${key}${sep}${quote}•••${quote}`,
    )
    .replace(LONG_TOKEN, '•••');
}

const clip = (text: string, max: number) =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text;

/** 秘密を伏せて、長さをそろえる（行の頭から）。 */
const shown = (value: unknown, max = 600): string =>
  clip(redactSecrets(typeof value === 'string' ? value : (JSON.stringify(value) ?? '')), max);

/** 道具ごとの写し。分からない道具は入力の頭を伏せて載せる。 */
export function describePermission(
  toolName: string,
  input: unknown,
  /** ファイルのパスの見せ方（プロジェクトからの道。既定はそのまま）。 */
  path: (p: string) => string = (p) => p,
): { summary: string; details: { label: string; value: string }[] } {
  const i = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const str = (k: string) => (typeof i[k] === 'string' ? (i[k] as string) : null);
  switch (toolName) {
    case 'Bash': {
      const description = str('description');
      return {
        summary: description ? `コマンドを実行: ${shown(description, 80)}` : 'コマンドを実行',
        details: [{ label: 'コマンド', value: shown(str('command') ?? '') }],
      };
    }
    case 'Edit':
    case 'MultiEdit':
      return {
        summary: `ファイルを書き換え: ${shown(fileName(str('file_path')), 80)}`,
        details: [
          { label: 'ファイル', value: shown(path(str('file_path') ?? ''), 300) },
          ...(str('old_string') !== null
            ? [{ label: '消す', value: shown(str('old_string'), 400) }]
            : []),
          ...(str('new_string') !== null
            ? [{ label: '入れる', value: shown(str('new_string'), 400) }]
            : []),
          ...(Array.isArray(i['edits'])
            ? [{ label: '変更', value: `${String((i['edits'] as unknown[]).length)} か所` }]
            : []),
        ],
      };
    case 'Write':
      return {
        summary: `ファイルを作成・上書き: ${shown(fileName(str('file_path')), 80)}`,
        details: [
          { label: 'ファイル', value: shown(path(str('file_path') ?? ''), 300) },
          { label: '中身', value: shown(str('content') ?? '', 500) },
        ],
      };
    case 'WebFetch':
      return {
        summary: 'ウェブのページを読む',
        details: [{ label: 'アドレス', value: shown(str('url') ?? '', 300) }],
      };
    default:
      return {
        summary: `${clip(toolName, 60)} を使う`,
        details: [{ label: '入力', value: shown(input, 500) }],
      };
  }
}

const fileName = (path: string | null) => (path ? (path.split(/[\\/]/).pop() ?? path) : '');

/** 入力の形の揺れ（キーの順）で別物にならないように並べてからハッシュにする。 */
export function inputHash(input: unknown): string {
  const stable = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(stable)
      : v && typeof v === 'object'
        ? Object.fromEntries(
            Object.keys(v as object)
              .sort()
              .map((k) => [k, stable((v as Record<string, unknown>)[k])]),
          )
        : v;
  return createHash('sha256')
    .update(JSON.stringify(stable(input ?? null)))
    .digest('hex');
}

// ---- 待ちの取り次ぎ（このプロセスのメモリだけ） ----

interface Live {
  readonly view: ApprovalView;
  readonly tenantId: string;
  readonly userId: string;
  readonly connectionId: string;
  readonly sessionId: string;
  readonly inputHash: string;
  readonly toolName: string;
  readonly op: OperationClass;
  readonly projectRoot: string;
  decision: HookDecision | null;
  waiters: (() => void)[];
  timer: NodeJS.Timeout;
}

/** 答えたあと、実行の結果を待っているもの。 */
interface Pending {
  readonly tenantId: string;
  readonly userId: string;
  readonly connectionId: string;
  readonly sessionId: string;
  readonly inputHash: string;
  readonly summary: string;
  /** 本人に結果を知らせるか（LINE で答えたもの）。自動の許可は静かにする（記録だけ）。 */
  readonly report: boolean;
  readonly until: number;
}

export interface AgentApprovalDeps {
  readonly db: DbHandle;
  /**
   * 本人の LINE の 1:1 にカードを送る（ボタンの署名はチャットの側で）。届けられなければ false。
   * 無ければ（チャットをつないでいない）承認は作らない（Mac の問いだけ）。
   */
  readonly ask?: (tenantId: string, userId: string, view: ApprovalView) => Promise<boolean>;
  /** 本人への知らせ（実行を確かめた・失敗した）。 */
  readonly tell?: (tenantId: string, userId: string, text: string) => Promise<void>;
  /** いまカードを送れる状態か（チャットが動いているか）。無ければ ask があれば送れるとみなす。 */
  readonly available?: () => boolean;
  /** cwd のプロジェクト（git の根・名前・ブランチ）。無ければ cwd を根にする。 */
  readonly projectOf?: (cwd: string) => Promise<ProjectInfo | null>;
  /**
   * 本人を待ち始めた・答えがあった・答えがないまま終わった。Genie が起動した仕事は、ここで時計を止め、
   * 答えがなければ作業を安全に止める（agent-jobs.ts）。本人が直接始めたセッションには何もしない。
   */
  readonly humanWait?: {
    started(tenantId: string, userId: string, sessionId: string): void;
    answered(tenantId: string, userId: string, sessionId: string): void;
    unanswered(
      tenantId: string,
      userId: string,
      sessionId: string,
      asked: { operation: string; summary: string; reason: 'expired' | 'undelivered' },
    ): Promise<void>;
  };
  /** このセッションが Genie の仕事なら、その名前（カードの「タスク」の行）。 */
  readonly jobLabel?: (
    tenantId: string,
    userId: string,
    externalSessionId: string,
  ) => Promise<string | null>;
  readonly now?: () => Date;
  /** 何が起きたか（中身は書かない。道具の名前・種類と結果だけ）。 */
  readonly log?: (event: string, detail: Record<string, unknown>) => void;
}

export type DecideResult =
  | 'decided'
  | 'decided_with_rule'
  | 'awaiting_instruction'
  | 'not_ruleable'
  | 'gone'
  | 'expired'
  | 'answered_on_mac';

export type RequestResult =
  | { readonly kind: 'asked'; readonly id: string; readonly expiresAt: Date }
  | { readonly kind: 'auto'; readonly id: string; readonly decision: HookDecision }
  | { readonly kind: 'none' };

/** 本人に見せる継続許可のルール。 */
export interface RuleView {
  readonly id: string;
  readonly scope: 'session' | 'project';
  readonly project: string;
  readonly tool: string;
  readonly label: string;
  readonly match: string | null;
  readonly useCount: number;
  readonly lastUsedAt: Date | null;
  readonly createdAt: Date;
}

export class AgentApprovals {
  readonly #live = new Map<string, Live>();
  /** 「指示を添える」を押した人 → その承認（次の文を指示として受ける）。キーは tenant:user。 */
  readonly #awaiting = new Map<string, { id: string; until: number }>();
  /** 答えたあと、実行の結果を待っているもの（承認の id → 中身）。 */
  readonly #results = new Map<string, Pending>();

  constructor(private readonly deps: AgentApprovalDeps) {}

  #now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  get enabled(): boolean {
    return Boolean(this.deps.ask) && (this.deps.available?.() ?? true);
  }

  /** そのセッションの承認を LINE で待っているか（「ターミナルで確かめて」の知らせを重ねない）。 */
  hasPending(tenantId: string, sessionId: string): boolean {
    for (const live of this.#live.values())
      if (live.tenantId === tenantId && live.sessionId === sessionId && !live.decision) return true;
    return false;
  }

  async #project(cwd: string | undefined): Promise<ProjectInfo | null> {
    if (!cwd) return null;
    const found = await this.deps.projectOf?.(cwd).catch(() => null);
    return found ?? { root: cwd, name: basename(cwd) || cwd, branch: null };
  }

  async #rules(tenantId: string, connectionId: string): Promise<ApprovalRule[]> {
    const rows = await withTenant(this.deps.db, tenantId, (tx) =>
      tx
        .selectFrom('agent_approval_rules')
        .select([
          'id',
          'scope',
          'project_root',
          'session_id',
          'tool_name',
          'operation',
          'match_value',
        ])
        .where('connection_id', '=', connectionId)
        .where('revoked_at', 'is', null)
        .execute(),
    );
    return rows.map((r) => ({
      id: r.id,
      scope: r.scope as ApprovalRule['scope'],
      projectRoot: r.project_root,
      sessionId: r.session_id,
      toolName: r.tool_name,
      operation: r.operation,
      match: r.match_value,
    }));
  }

  /**
   * Claude Code が許可を求めた。
   *   本人の継続許可に当たる → auto（その場で許可。記録は残す）
   *   当たらない → カードを送れたら asked（hooks はその答えを待つ）
   *   送らない・送れない → none（hooks は何も返さずに終わり、Mac の問いが残る）
   */
  async request(
    connection: AgentConnection,
    event: {
      sessionId: string;
      toolName: string;
      toolInput: unknown;
      cwd?: string;
      promptId?: string;
    },
  ): Promise<RequestResult> {
    const session = await withTenant(this.deps.db, connection.tenantId, (tx) =>
      tx
        .selectFrom('agent_sessions')
        .select(['user_policy', 'title'])
        .where('connection_id', '=', connection.id)
        .where('external_session_id', '=', event.sessionId)
        .executeTakeFirst(),
    );
    const project = await this.#project(event.cwd);
    const root = project?.root ?? event.cwd ?? '/';
    const op = classify(event.toolName, event.toolInput, event.cwd ?? root, root);
    const hash = inputHash(event.toolInput);
    const id = uuidv7();
    const now = this.#now();
    const row = {
      id,
      tenant_id: connection.tenantId,
      user_id: connection.userId,
      connection_id: connection.id,
      external_session_id: event.sessionId,
      tool_name: event.toolName.slice(0, 80),
      input_hash: hash,
      operation: op.operation.slice(0, 40),
      risk: op.risk,
      prompt_id: event.promptId?.slice(0, 128) ?? null,
    };

    // 本人が前もって許した同種の操作なら、その場で許可する（毎回評価し直す。本人が止めたセッションでも、
    // 本人が作ったルールには従う）
    const rule = ruleFor(await this.#rules(connection.tenantId, connection.id), op, {
      toolName: event.toolName,
      sessionId: event.sessionId,
      projectRoot: root,
    });
    if (rule) {
      await withTenant(this.deps.db, connection.tenantId, async (tx) => {
        await tx
          .insertInto('agent_approvals')
          .values({
            ...row,
            state: 'auto_allowed',
            rule_id: rule.id,
            expires_at: now,
            decided_at: sql<Date>`now()`,
            delivered_at: sql<Date>`now()`,
          })
          .execute();
        await tx
          .updateTable('agent_approval_rules')
          .set({ use_count: sql<number>`use_count + 1`, last_used_at: sql<Date>`now()` })
          .where('id', '=', rule.id)
          .execute();
      });
      this.#track(id, {
        tenantId: connection.tenantId,
        userId: connection.userId,
        connectionId: connection.id,
        sessionId: event.sessionId,
        inputHash: hash,
        summary: op.label,
        report: false,
      });
      this.deps.log?.('agent_approval.auto_allowed', {
        id,
        rule: rule.id,
        operation: op.operation,
      });
      return { kind: 'auto', id, decision: { behavior: 'allow' } };
    }

    if (!this.deps.ask) return { kind: 'none' };
    // 本人が止めたセッション（見守りを止めた・保留中）は LINE へ出さない
    if (session?.user_policy === 'paused_by_user') {
      this.deps.log?.('agent_approval.skipped', { reason: 'paused_by_user', tool: event.toolName });
      return { kind: 'none' };
    }

    const expiresAt = new Date(now.getTime() + APPROVAL_MINUTES * 60_000);
    // 同じセッションで前に待っていたものは、もう答えが要らない（Claude Code は 1 つずつ聞く）
    await this.#withdraw(connection, event.sessionId, 'answered_on_mac');
    await withTenant(this.deps.db, connection.tenantId, (tx) =>
      tx
        .insertInto('agent_approvals')
        .values({ ...row, expires_at: expiresAt })
        .execute(),
    );
    const inProject = (p: string) => {
      const rel = relative(root, p);
      return rel && !rel.startsWith('..') ? rel : shownPath(p);
    };
    const workdir = event.cwd ? relative(root, event.cwd) || '.' : null;
    const view: ApprovalView = {
      id,
      number: id.replace(/-/g, '').slice(-4).toUpperCase(),
      agent: 'Claude Code',
      project: project?.name ?? null,
      branch: project?.branch ?? null,
      workdir:
        workdir && !workdir.startsWith('..') ? workdir : event.cwd ? shownPath(event.cwd) : null,
      task: session?.title ? redactSecrets(session.title) : null,
      genieTask:
        (await this.deps
          .jobLabel?.(connection.tenantId, connection.userId, event.sessionId)
          .catch(() => null)) ?? null,
      tool: event.toolName,
      ...describePermission(event.toolName, event.toolInput, inProject),
      operation: op.label,
      risk: op.risk,
      ruleable: op.ruleable,
      notRuleableReason: op.reason,
      expiresAt,
    };
    const timer = setTimeout(
      () => void this.#end(connection.tenantId, id, 'expired'),
      expiresAt.getTime() - now.getTime(),
    );
    timer.unref?.();
    this.#live.set(id, {
      view,
      tenantId: connection.tenantId,
      userId: connection.userId,
      connectionId: connection.id,
      sessionId: event.sessionId,
      inputHash: hash,
      toolName: event.toolName,
      op,
      projectRoot: root,
      decision: null,
      waiters: [],
      timer,
    });
    this.deps.humanWait?.started(connection.tenantId, connection.userId, event.sessionId);
    const delivered = await this.deps
      .ask(connection.tenantId, connection.userId, view)
      .catch(() => false);
    this.deps.log?.('agent_approval.asked', { id, operation: op.operation, delivered });
    if (!delivered) {
      await this.#end(connection.tenantId, id, 'ended');
      await this.deps.humanWait
        ?.unanswered(connection.tenantId, connection.userId, event.sessionId, {
          operation: op.label,
          summary: view.summary,
          reason: 'undelivered',
        })
        .catch(() => undefined);
      return { kind: 'none' };
    }
    return { kind: 'asked', id, expiresAt };
  }

  /**
   * hooks が答えを取りに来る。答えがあればそれ、無ければ waitMs まで待つ。
   * 'pending' はまだ。none はもう待たなくてよい（取り下げ・期限切れ・知らない id）。
   * 答えを渡したら「Claude Code に渡した」を記録する。
   */
  async wait(
    connection: AgentConnection,
    id: string,
    waitMs: number,
  ): Promise<HookDecision | 'pending'> {
    const live = this.#live.get(id);
    if (!live || live.connectionId !== connection.id) return { behavior: 'none' };
    if (!live.decision)
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, waitMs);
        live.waiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    const decision = live.decision ?? 'pending';
    if (decision !== 'pending' && decision.behavior !== 'none')
      await withTenant(this.deps.db, live.tenantId, (tx) =>
        tx
          .updateTable('agent_approvals')
          .set({ delivered_at: sql<Date>`now()` })
          .where('id', '=', id)
          .where('delivered_at', 'is', null)
          .execute(),
      ).catch(() => undefined);
    return decision;
  }

  /**
   * 本人がボタンを押した（チャットの側で、印・押した人・期限を確かめたあと）。
   * id は求められた入力 1 つごとに作る（入力が変われば別の id。古いボタンは通らない）。
   * allow_session / allow_project は、今回を許可したうえで同種の操作の継続許可を作る。
   */
  async decide(
    tenantId: string,
    userId: string,
    id: string,
    choice: ApprovalChoice,
  ): Promise<DecideResult> {
    const live = this.#live.get(id);
    if (!live || live.tenantId !== tenantId || live.userId !== userId || live.decision) {
      const row = await this.#row(tenantId, id);
      if (row?.state === 'answered_on_mac') return 'answered_on_mac';
      if (row?.state === 'expired') return 'expired';
      return 'gone';
    }
    if (live.view.expiresAt.getTime() <= this.#now().getTime()) {
      await this.#end(tenantId, id, 'expired');
      return 'expired';
    }
    if (choice === 'instruct') {
      this.#awaiting.set(`${tenantId}:${userId}`, {
        id,
        until: Math.min(this.#now().getTime() + INSTRUCTION_MS, live.view.expiresAt.getTime()),
      });
      return 'awaiting_instruction';
    }
    // 継続許可にしてはいけない種類は、ボタンを押されても作らない（今回の許可もしない。聞き直す）
    if ((choice === 'allow_session' || choice === 'allow_project') && !live.op.ruleable)
      return 'not_ruleable';
    const allow = choice !== 'deny';
    const ok = await this.#settle(
      tenantId,
      id,
      allow ? 'allowed' : 'denied',
      false,
      allow
        ? { behavior: 'allow' }
        : {
            behavior: 'deny',
            message:
              'LINE で本人が拒否しました。この操作は実行せず、別の方法を考えるか、本人に確かめてください。',
          },
      async (tx) => {
        if (choice !== 'allow_session' && choice !== 'allow_project') return null;
        const ruleId = uuidv7();
        await tx
          .insertInto('agent_approval_rules')
          .values({
            id: ruleId,
            tenant_id: tenantId,
            user_id: userId,
            connection_id: live.connectionId,
            scope: choice === 'allow_session' ? 'session' : 'project',
            project_root: live.projectRoot,
            session_id: choice === 'allow_session' ? live.sessionId : null,
            tool_name: live.toolName,
            operation: live.op.operation,
            match_value: live.op.match,
            label: live.op.label.slice(0, 200),
            from_approval_id: id,
          })
          .execute();
        return ruleId;
      },
    );
    if (!ok) return 'gone';
    this.#track(id, {
      tenantId,
      userId,
      connectionId: live.connectionId,
      sessionId: live.sessionId,
      inputHash: live.inputHash,
      summary: live.view.summary,
      report: allow,
    });
    return choice === 'allow_session' || choice === 'allow_project'
      ? 'decided_with_rule'
      : 'decided';
  }

  /**
   * 「指示を添える」のあとの本人の文。待っていればそれを拒否の理由として Claude Code へ渡す。
   * 待っていなければ null（ふつうの会話として続ける）。
   */
  async instruct(
    tenantId: string,
    userId: string,
    text: string,
  ): Promise<'decided' | 'gone' | null> {
    const key = `${tenantId}:${userId}`;
    const waiting = this.#awaiting.get(key);
    if (!waiting) return null;
    this.#awaiting.delete(key);
    if (waiting.until <= this.#now().getTime()) return null;
    const instruction = text.trim().slice(0, 2000);
    if (!instruction) return null;
    const ok = await this.#settle(tenantId, waiting.id, 'denied', true, {
      behavior: 'deny',
      message: `LINE で本人がこの操作を止め、次の指示を出しました。指示に従って続けてください。\n指示: ${instruction}`,
    });
    return ok ? 'decided' : 'gone';
  }

  /**
   * Claude Code の後の出来事（非同期の hooks）。
   *   同じ入力の PostToolUse / PostToolUseFailure … 答えた操作なら実行の結果を残し（LINE で答えたものは知らせる）、
   *                                              待っている操作なら Mac で答えて実行された（取り下げる）
   *   UserPromptSubmit・Stop・SessionEnd … 待っている問いはもう終わっている（取り下げる）
   *   SessionEnd … そのセッションの継続許可も終える
   */
  async observe(
    connection: AgentConnection,
    event: { event: string; sessionId: string; toolName?: string; toolInput?: unknown },
  ): Promise<void> {
    if (event.event === 'PostToolUse' || event.event === 'PostToolUseFailure') {
      const hash = inputHash(event.toolInput);
      for (const [id, live] of this.#live)
        if (
          live.connectionId === connection.id &&
          live.sessionId === event.sessionId &&
          live.inputHash === hash &&
          !live.decision
        )
          await this.#end(live.tenantId, id, 'answered_on_mac');
      for (const [id, p] of this.#results)
        if (
          p.connectionId === connection.id &&
          p.sessionId === event.sessionId &&
          p.inputHash === hash
        )
          await this.#result(id, p, event.event === 'PostToolUse' ? 'executed' : 'failed');
      return;
    }
    if (event.event === 'SessionEnd') {
      await this.#withdraw(connection, event.sessionId, 'ended');
      await withTenant(this.deps.db, connection.tenantId, (tx) =>
        tx
          .updateTable('agent_approval_rules')
          .set({ revoked_at: sql<Date>`now()` })
          .where('connection_id', '=', connection.id)
          .where('scope', '=', 'session')
          .where('session_id', '=', event.sessionId)
          .where('revoked_at', 'is', null)
          .execute(),
      ).catch(() => undefined);
    } else if (event.event === 'UserPromptSubmit' || event.event === 'Stop')
      await this.#withdraw(connection, event.sessionId, 'answered_on_mac');
  }

  /**
   * チャットの「承認ルール」。一覧・番号で取り消す・全部取り消す。当たらなければ null（ふつうの会話）。
   *   承認ルール / 承認ルールを見せて
   *   承認ルール 2 を取り消して
   *   承認ルールを全部取り消して
   */
  async command(tenantId: string, userId: string, text: string): Promise<string | null> {
    const t = text.trim().replace(/[　\s]+/g, ' ');
    if (!/^承認ルール/.test(t)) return null;
    const rules = await this.rules(tenantId, userId);
    if (/(?:全部|すべて|ぜんぶ)\s*(?:を\s*)?(?:取り消|消し|消す|解除|やめ)/.test(t)) {
      const n = await this.revoke(tenantId, userId, 'all');
      return n > 0
        ? `承認ルールを ${String(n)} 件取り消しました。次からは毎回確認します。`
        : '取り消す承認ルールはありません。';
    }
    const numbered = /(\d+)\s*(?:番)?\s*(?:を\s*)?(?:取り消|消し|消す|解除|やめ)/.exec(t);
    if (numbered) {
      const rule = rules[Number(numbered[1]) - 1];
      if (!rule)
        return `${numbered[1]!} 番の承認ルールはありません。「承認ルール」で一覧を出せます。`;
      await this.revoke(tenantId, userId, rule.id);
      return `取り消しました：${ruleLine(rule)}\n次からは毎回確認します。`;
    }
    if (rules.length === 0)
      return '承認ルールはありません。Claude Code の承認カードで「同種を許可」を選ぶと、ここに並びます。';
    return [
      '承認ルール（確認なしで進める操作）',
      ...rules.map((r, i) => `${String(i + 1)}. ${ruleLine(r)}`),
      '',
      '取り消すには「承認ルール 1 を取り消して」「承認ルールを全部取り消して」と送ってください。',
    ].join('\n');
  }

  /** 本人の継続許可（取り消していないもの）。 */
  async rules(tenantId: string, userId: string): Promise<RuleView[]> {
    const rows = await withTenant(this.deps.db, tenantId, (tx) =>
      tx
        .selectFrom('agent_approval_rules')
        .selectAll()
        .where('user_id', '=', userId)
        .where('revoked_at', 'is', null)
        .orderBy('created_at')
        .execute(),
    );
    return rows.map((r) => ({
      id: r.id,
      scope: r.scope as RuleView['scope'],
      project: basename(r.project_root) || r.project_root,
      tool: r.tool_name,
      label: r.label,
      match: r.match_value,
      useCount: r.use_count,
      lastUsedAt: r.last_used_at ? new Date(r.last_used_at) : null,
      createdAt: new Date(r.created_at),
    }));
  }

  /** 継続許可を取り消す（id か、'all'）。取り消した数を返す。 */
  async revoke(tenantId: string, userId: string, id: string | 'all'): Promise<number> {
    const done = await withTenant(this.deps.db, tenantId, (tx) => {
      let q = tx
        .updateTable('agent_approval_rules')
        .set({ revoked_at: sql<Date>`now()` })
        .where('user_id', '=', userId)
        .where('revoked_at', 'is', null);
      if (id !== 'all') q = q.where('id', '=', id);
      return q.executeTakeFirst();
    });
    this.deps.log?.('agent_approval.rule_revoked', { count: Number(done.numUpdatedRows) });
    return Number(done.numUpdatedRows);
  }

  /** 最近の承認の記録（自動の許可を含む。中身は持たないので、種類・道具・どう答えたか・結果だけ）。 */
  async history(tenantId: string, userId: string, limit = 20) {
    return withTenant(this.deps.db, tenantId, (tx) =>
      tx
        .selectFrom('agent_approvals')
        .select([
          'id',
          'tool_name',
          'operation',
          'risk',
          'state',
          'with_instruction',
          'rule_id',
          'created_at',
          'decided_at',
          'delivered_at',
          'result',
          'result_at',
        ])
        .where('user_id', '=', userId)
        .orderBy('created_at', 'desc')
        .limit(limit)
        .execute(),
    );
  }

  #track(id: string, p: Omit<Pending, 'until'>) {
    this.#results.set(id, { ...p, until: this.#now().getTime() + RESULT_MS });
    // 古いものは捨てる（結果が来ないこともある: Claude Code が止められた・別の道具に替えた）
    const now = this.#now().getTime();
    for (const [k, v] of this.#results) if (v.until < now) this.#results.delete(k);
  }

  async #result(id: string, p: Pending, result: 'executed' | 'failed') {
    this.#results.delete(id);
    await withTenant(this.deps.db, p.tenantId, (tx) =>
      tx
        .updateTable('agent_approvals')
        .set({ result, result_at: sql<Date>`now()` })
        .where('id', '=', id)
        .where('result', 'is', null)
        .execute(),
    ).catch(() => undefined);
    if (p.report)
      await this.deps
        .tell?.(
          p.tenantId,
          p.userId,
          result === 'executed'
            ? `✓ Claude Code が実行しました：${p.summary}`
            : `Claude Code が実行しましたが、失敗しました：${p.summary}`,
        )
        .catch(() => undefined);
  }

  async #withdraw(
    connection: AgentConnection,
    sessionId: string,
    state: 'answered_on_mac' | 'ended',
  ) {
    for (const [id, live] of this.#live)
      if (live.connectionId === connection.id && live.sessionId === sessionId && !live.decision)
        await this.#end(live.tenantId, id, state);
  }

  async #row(tenantId: string, id: string) {
    return withTenant(this.deps.db, tenantId, (tx) =>
      tx.selectFrom('agent_approvals').select(['state']).where('id', '=', id).executeTakeFirst(),
    ).catch(() => undefined);
  }

  /** 1 回だけ答えを決める（DB の待ちの行を取れた 1 回だけが通る。ルールも同じ取引で作る）。 */
  async #settle(
    tenantId: string,
    id: string,
    state: 'allowed' | 'denied',
    withInstruction: boolean,
    decision: HookDecision,
    alsoRule?: (tx: Parameters<Parameters<typeof withTenant>[2]>[0]) => Promise<string | null>,
  ): Promise<boolean> {
    const live = this.#live.get(id);
    if (!live || live.decision) return false;
    const won = await withTenant(this.deps.db, tenantId, async (tx) => {
      const done = await tx
        .updateTable('agent_approvals')
        .set({ state, with_instruction: withInstruction, decided_at: sql<Date>`now()` })
        .where('id', '=', id)
        .where('state', '=', 'pending')
        .where('expires_at', '>', sql<Date>`now()`)
        .executeTakeFirst();
      if (Number(done.numUpdatedRows) === 0) return false;
      const ruleId = alsoRule ? await alsoRule(tx) : null;
      if (ruleId)
        await tx
          .updateTable('agent_approvals')
          .set({ rule_id: ruleId })
          .where('id', '=', id)
          .execute();
      return true;
    });
    if (!won || live.decision) return false;
    live.decision = decision;
    this.#release(id, live);
    this.deps.humanWait?.answered(tenantId, live.userId, live.sessionId);
    return true;
  }

  /** 答えずに終える（取り下げ・期限切れ・届けられなかった）。hooks には「何も返さない」。 */
  async #end(tenantId: string, id: string, state: 'answered_on_mac' | 'expired' | 'ended') {
    const live = this.#live.get(id);
    const first = live && !live.decision ? live : null;
    if (first) {
      first.decision = { behavior: 'none' };
      this.#release(id, first);
    }
    for (const [key, w] of this.#awaiting) if (w.id === id) this.#awaiting.delete(key);
    await withTenant(this.deps.db, tenantId, (tx) =>
      tx
        .updateTable('agent_approvals')
        .set({ state, decided_at: sql<Date>`now()` })
        .where('id', '=', id)
        .where('state', '=', 'pending')
        .execute(),
    ).catch(() => undefined);
    if (!first) return;
    if (state === 'expired')
      await this.deps.humanWait
        ?.unanswered(tenantId, first.userId, first.sessionId, {
          operation: first.view.operation,
          summary: first.view.summary,
          reason: 'expired',
        })
        .catch(() => undefined);
    else this.deps.humanWait?.answered(tenantId, first.userId, first.sessionId);
  }

  #release(id: string, live: Live) {
    clearTimeout(live.timer);
    for (const wake of live.waiters.splice(0)) wake();
    // hooks が答えを受け取れるよう少し残してから捨てる（写しもここで消える）
    setTimeout(() => this.#live.delete(id), 60_000).unref?.();
  }
}

/** ルール 1 行（どこで・何を・何回使ったか）。 */
function ruleLine(r: RuleView): string {
  const where =
    r.scope === 'project' ? `プロジェクト ${r.project}` : `このセッション（${r.project}）`;
  const what =
    r.match && r.label === '同じコマンド' ? `${r.label}「${r.match.slice(0, 60)}」` : r.label;
  return `${where}：${what}（${r.tool}・自動で許可 ${String(r.useCount)} 回）`;
}

/** hooks の標準出力にそのまま出す JSON（Claude Code の PermissionRequest の答え）。 */
export function hookOutput(decision: Exclude<HookDecision, { behavior: 'none' }>): string {
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PermissionRequest',
      decision:
        decision.behavior === 'allow'
          ? { behavior: 'allow' }
          : { behavior: 'deny', message: decision.message },
    },
  });
}
