/**
 * Claude Code の許可の問いを、操作の種類とリスクに分ける（承認の方針、本人の方針 2026-10-30）。
 *
 *   「今回だけ承認」と「今後も許可（このセッション / このプロジェクト）」を分ける。
 *   継続許可は**コマンド名だけで決めない**。操作の種類・対象のパス（プロジェクトの中か）・リスクで決め、
 *   実行の直前（問いが来るたび）に評価し直す。
 *
 * 継続許可にしないもの（毎回、本人に聞く）:
 *   秘密（.env・鍵・認証情報）/ 外への送信（push・publish・データを送る curl など）/ 本番・デプロイ /
 *   壊す操作（rm -r・reset --hard・強制 push など）/ 権限（sudo・chmod -R）/ 決済 / プロジェクトの外のパス
 *
 * ここは字面で見る（シェルを実行して確かめるわけではない）。迷ったら「継続許可にしない」側へ倒す。
 */
import { isAbsolute, normalize, resolve } from 'node:path';

export type Risk = 'low' | 'medium' | 'high';

export interface OperationClass {
  /** 操作の種類（継続許可の単位）。 */
  readonly operation: string;
  /** 本人に見せる種類の名前。 */
  readonly label: string;
  readonly risk: Risk;
  /** 継続許可（セッション・プロジェクト）の対象にしてよいか。 */
  readonly ruleable: boolean;
  /** 継続許可にしない理由（ruleable が false のとき）。 */
  readonly reason: string | null;
  /**
   * 種類の中で、さらに一致を求める値（知らないコマンドはコマンドの文そのもの、ウェブはホスト名、
   * MCP の道具は道具の名前）。null なら種類だけで一致。
   */
  readonly match: string | null;
  /** 触るパス（絶対パス）。分からなければ空。 */
  readonly targets: readonly string[];
}

const SECRET_PATH =
  /(?:^|\/)(?:\.env(?:\.[\w.-]+)?|\.npmrc|\.netrc|\.pgpass|id_[a-z0-9]+|[\w.-]*\.(?:key|pem|p12|pfx|keystore)|credentials(?:\.json)?|secrets?(?:\.[\w]+)?|\.ssh|\.aws|\.gnupg|\.config\/gcloud|Keychains?)(?:\/|$)/i;
const CLAUDE_SETTINGS = /(?:^|\/)\.claude\/(?:settings(?:\.local)?\.json|hooks\/)/;

/** 外へ出る・本番・壊す・権限・決済など。継続許可にしない。 */
const NEVER: readonly { re: RegExp; reason: string; operation: string; label: string }[] = [
  {
    re: /\bsudo\b|\bsu\s+-?\w*/,
    reason: '管理者の権限を使う',
    operation: 'privileged',
    label: '管理者の権限で実行',
  },
  {
    re: /\bgit\s+push\b/,
    reason: '外（リモート）へ送る',
    operation: 'git_push',
    label: 'リモートへ送る（git push）',
  },
  {
    re: /\b(?:npm|pnpm|yarn)\s+publish\b|\bcargo\s+publish\b|\btwine\s+upload\b|\bgh\s+(?:pr|release|repo)\s+(?:create|merge|delete)\b/,
    reason: '外へ公開する',
    operation: 'publish',
    label: '公開・PR の操作',
  },
  {
    re: /\b(?:deploy|terraform\s+apply|kubectl\s+(?:apply|delete|rollout)|helm\s+(?:install|upgrade)|fly\s+deploy|vercel\b|netlify\s+deploy|gcloud\s+\w+\s+deploy|aws\s+\S+\s+(?:deploy|update|put|delete))/i,
    reason: '本番・デプロイに触る',
    operation: 'deploy',
    label: 'デプロイ',
  },
  {
    re: /\brm\s+(?:-\w*[rRf]\w*\s+)|\bgit\s+(?:reset\s+--hard|clean\s+-\w*f|checkout\s+--\s|branch\s+-D|push\s+--force)|\bdd\s+|\bmkfs|\bshred\b|>\s*\/dev\/(?!null)/,
    reason: '消す・戻せない',
    operation: 'destructive',
    label: '消す・戻せない操作',
  },
  {
    re: /\bchmod\s+-R|\bchown\s+-R/,
    reason: '権限をまとめて変える',
    operation: 'permissions',
    label: '権限の変更',
  },
  {
    re: /\bcurl\b[^|;&]*(?:\s-X\s*(?:POST|PUT|PATCH|DELETE)|\s--data|\s-d\s|\s-F\s|\s--upload|\s-T\s)|\bwget\b[^|;&]*--post|\b(?:scp|rsync|sftp|ssh)\b|\bnc\b|\bmail\b|\bsendmail\b/,
    reason: '外へ送る',
    operation: 'send_out',
    label: '外へ送る',
  },
  {
    re: /\b(?:stripe|payments?|billing)\b/i,
    reason: '決済に触るかもしれない',
    operation: 'payment',
    label: '決済',
  },
  {
    re: /\bsecurity\s+(?:find|add|delete)-\w*password|\bprintenv\b|\benv\b\s*$|\bcat\b[^|;&]*\.env\b/,
    reason: '秘密を読む・書く',
    operation: 'secrets',
    label: '秘密に触る',
  },
];

const READ_ONLY =
  /^(?:ls|cat|head|tail|less|wc|grep|rg|ag|find|fd|tree|pwd|which|file|stat|du|df|echo|date|diff|jq|sort|uniq|cut|awk|sed\s+-n|git\s+(?:status|diff|log|show|branch|rev-parse|ls-files|blame|remote\s+-v))\b/;
const TESTS =
  /^(?:(?:pnpm|npm|yarn|bun)\s+(?:(?:run\s+)?(?:test|lint|typecheck|check|build|format:check)|exec\s+(?:tsc|vitest|eslint|prettier\s+--check))|npx\s+(?:tsc|vitest|eslint|prettier\s+--check|jest)|vitest|jest|pytest|tsc|eslint|cargo\s+(?:test|check|build|clippy)|go\s+(?:test|build|vet)|swift\s+(?:build|test)|make\s+(?:test|check|lint)|node\s+--test)\b/;
const CREATE = /^(?:touch|mkdir(?:\s+-p)?)\s/;
const INSTALL =
  /^(?:(?:pnpm|npm|yarn|bun)\s+(?:install|i|add|ci)|pip3?\s+install|uv\s+(?:add|sync|pip\s+install)|brew\s+install|cargo\s+add)\b/;

const home = (path: string) => path.replace(/^\/Users\/[^/]+/, '~');

/** パスを絶対にそろえる（~ は展開しない。相対は cwd から）。 */
function absolute(path: string, cwd: string): string {
  // ~ や $HOME で始まるものは家のフォルダ（プロジェクトの外として扱う。展開はしない）
  if (/^(?:~|\$HOME\b|\$\{HOME\})/.test(path))
    return normalize(`/~home/${path.replace(/^[^/]*\/?/, '')}`);
  return normalize(isAbsolute(path) ? path : resolve(cwd, path));
}

export function inside(path: string, root: string): boolean {
  const r = root.replace(/\/+$/, '');
  return path === r || path.startsWith(`${r}/`);
}

/** コマンドを `&&` `;` `|` `||` で切った部分。 */
const parts = (command: string) =>
  command
    .split(/&&|\|\||;|\|/)
    .map((p) => p.trim())
    .filter(Boolean);

/** touch / mkdir の引数（オプションを除く）。 */
const argsOf = (part: string) =>
  part
    .split(/\s+/)
    .slice(1)
    .filter((a) => a && !a.startsWith('-'))
    .map((a) => a.replace(/^["']|["']$/g, ''));

/**
 * 求められた操作を分ける。`root` はプロジェクトの根（git の根。分からなければ cwd）。
 */
export function classify(
  toolName: string,
  input: unknown,
  cwd: string,
  root: string,
): OperationClass {
  const i = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const str = (k: string) => (typeof i[k] === 'string' ? (i[k] as string) : '');
  const never = (reason: string, operation: string, label: string, targets: string[] = []) => ({
    operation,
    label,
    risk: 'high' as const,
    ruleable: false,
    reason,
    match: null,
    targets,
  });

  if (
    toolName === 'Edit' ||
    toolName === 'MultiEdit' ||
    toolName === 'Write' ||
    toolName === 'NotebookEdit'
  ) {
    const path = absolute(str('file_path') || str('notebook_path'), cwd);
    if (SECRET_PATH.test(path))
      return never('秘密のファイル', 'secrets', '秘密のファイルを書く', [path]);
    if (CLAUDE_SETTINGS.test(path))
      return never('Claude Code の設定・hooks', 'agent_settings', 'Claude Code の設定を書く', [
        path,
      ]);
    if (!inside(path, root))
      return never('プロジェクトの外のファイル', 'outside_project', 'プロジェクトの外を書く', [
        path,
      ]);
    const write = toolName === 'Write';
    return {
      operation: write ? 'write_file' : 'edit_file',
      label: write
        ? 'プロジェクト内のファイルを作成・上書き'
        : 'プロジェクト内のファイルを書き換え',
      risk: write ? 'medium' : 'low',
      ruleable: true,
      reason: null,
      match: null,
      targets: [path],
    };
  }

  if (toolName === 'Bash') {
    const command = str('command').trim();
    for (const n of NEVER) if (n.re.test(command)) return never(n.reason, n.operation, n.label);
    const pieces = parts(command);
    // リダイレクトでプロジェクトの外へ書く
    const redirects = [...command.matchAll(/(?<![0-9&])>{1,2}\s*([^\s;&|]+)/g)].map((m) =>
      absolute(m[1]!.replace(/^["']|["']$/g, ''), cwd),
    );
    for (const target of redirects) {
      if (target === '/dev/null') continue;
      if (SECRET_PATH.test(target))
        return never('秘密のファイル', 'secrets', '秘密のファイルを書く', [target]);
      if (!inside(target, root))
        return never('プロジェクトの外へ書く', 'outside_project', 'プロジェクトの外を書く', [
          target,
        ]);
    }
    if (!inside(normalize(cwd), root))
      return never('プロジェクトの外で実行する', 'outside_project', 'プロジェクトの外で実行');
    const all = (re: RegExp) => pieces.length > 0 && pieces.every((p) => re.test(p));
    if (all(READ_ONLY) && redirects.every((t) => t === '/dev/null'))
      return {
        operation: 'read',
        label: '読むだけのコマンド',
        risk: 'low',
        ruleable: true,
        reason: null,
        match: null,
        targets: [],
      };
    if (all(TESTS))
      return {
        operation: 'run_checks',
        label: 'テスト・ビルド・型の確認',
        risk: 'low',
        ruleable: true,
        reason: null,
        match: null,
        targets: [],
      };
    if (pieces.length === 1 && CREATE.test(pieces[0]!)) {
      const targets = argsOf(pieces[0]!).map((a) => absolute(a, cwd));
      if (targets.length === 0) return unknown(command);
      const bad = targets.find((t) => SECRET_PATH.test(t) || !inside(t, root));
      if (bad)
        return never('プロジェクトの外・秘密のパス', 'outside_project', 'プロジェクトの外に作成', [
          bad,
        ]);
      return {
        operation: 'create_file',
        label: pieces[0]!.startsWith('mkdir')
          ? 'プロジェクト内にフォルダを作成'
          : 'プロジェクト内にファイルを作成（既にあれば時刻だけ更新）',
        risk: 'low',
        ruleable: true,
        reason: null,
        match: null,
        targets,
      };
    }
    if (pieces.length === 1 && INSTALL.test(pieces[0]!))
      return {
        operation: 'install_packages',
        label: 'パッケージを入れる（外から取ってくる）',
        risk: 'medium',
        ruleable: true,
        reason: null,
        match: null,
        targets: [],
      };
    return unknown(command);
  }

  if (toolName === 'WebFetch') {
    let host = '';
    try {
      host = new URL(str('url')).host;
    } catch {
      /* 形の違うアドレス */
    }
    if (!host) return never('アドレスが読めない', 'web_read', 'ウェブを読む');
    return {
      operation: 'web_read',
      label: `ウェブを読む（${host}）`,
      risk: 'medium',
      ruleable: true,
      reason: null,
      match: host,
      targets: [],
    };
  }

  // MCP など。道具の名前ごとにだけ許す（中身は見られない）
  return {
    operation: 'tool',
    label: `${toolName.slice(0, 60)} を使う`,
    risk: 'medium',
    ruleable: true,
    reason: null,
    match: toolName,
    targets: [],
  };
}

/** 知らないコマンド。継続許可は「同じコマンドの文」だけ（似たコマンドへ広げない）。 */
function unknown(command: string): OperationClass {
  return {
    operation: 'command',
    label: '同じコマンド',
    risk: 'medium',
    ruleable: command.length > 0 && command.length <= 300 && !/\n/.test(command),
    reason: command.length > 300 || /\n/.test(command) ? '長い・複数行のコマンド' : null,
    match: command.replace(/\s+/g, ' '),
    targets: [],
  };
}

/** 継続許可のルール（DB の agent_approval_rules の 1 行）。 */
export interface ApprovalRule {
  readonly id: string;
  readonly scope: 'session' | 'project';
  readonly projectRoot: string;
  readonly sessionId: string | null;
  readonly toolName: string;
  readonly operation: string;
  readonly match: string | null;
}

/**
 * ルールに当たるか。実行の直前に毎回見る:
 *   継続許可の対象であること / 同じ道具・種類・一致の値 / 同じプロジェクト（セッションのルールは同じセッション）/
 *   触るパスがすべてそのプロジェクトの中
 */
export function ruleFor(
  rules: readonly ApprovalRule[],
  op: OperationClass,
  request: { toolName: string; sessionId: string; projectRoot: string },
): ApprovalRule | null {
  if (!op.ruleable) return null;
  return (
    rules.find(
      (r) =>
        r.toolName === request.toolName &&
        r.operation === op.operation &&
        r.match === op.match &&
        r.projectRoot === request.projectRoot &&
        (r.scope === 'project' || r.sessionId === request.sessionId) &&
        op.targets.every((t) => inside(t, r.projectRoot)),
    ) ?? null
  );
}

/** カードに出すパス（ホームは ~ に）。 */
export const shownPath = home;
