/**
 * 別の PC（Mac）の Claude Code を、この Mac の Genie につなぐ（本人の要望 2026-11-09
 * 「別のPCのclaude codeも通知が来るようにできませんか？」）。
 *
 *   この Mac:  node scripts/claude-code-hooks.mjs remote --name "MacBook Air"
 *              → 10 分・1 回だけ使えるコマンドが出る
 *   別の PC:   curl -fsSL https://<公開の入口>/v1/agent-pair/<合言葉> | sh
 *              → その PC だけの鍵をキーチェーンに置き、~/.claude/settings.json に hooks を足す
 *
 * 別の PC からは、公開の入口（LINE の Webhook と同じトンネル。scripts/line-webhook-relay.mjs）を通って届く。
 * 中継が通すのは hooks の 3 つの道と、このコマンドの 1 つだけ。鍵の無い・知らない鍵の出来事は gateway が断る。
 *
 * 合言葉はメモリにだけ置く（gateway を立ち上げ直したら出し直す）。平文の鍵は、コマンドを取りに来た
 * 1 回の応答にだけ載る（HTTPS）。残すのはハッシュだけ（agent_connections）。
 */
import { randomBytes } from 'node:crypto';

/** 合言葉の寿命 */
export const PAIR_MINUTES = 10;
export const PAIR_CODE = /^[A-Za-z0-9_-]{43}$/;
/** PC の名前（知らせの文に入る）。記号は入れない（シェルの文字列にも入る） */
export const DEVICE_NAME = /^[\p{L}\p{N}][\p{L}\p{N} ._-]{0,39}$/u;

interface Pending {
  readonly tenantId: string;
  readonly userId: string;
  readonly device: string;
  readonly expiresAt: number;
}

/** 発行した合言葉（1 回で消える）。 */
export class PairingCodes {
  readonly #pending = new Map<string, Pending>();
  readonly #now: () => number;

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  issue(input: { tenantId: string; userId: string; device: string }): {
    code: string;
    expiresAt: Date;
  } {
    this.#sweep();
    const code = randomBytes(32).toString('base64url');
    const expiresAt = this.#now() + PAIR_MINUTES * 60_000;
    this.#pending.set(code, { ...input, expiresAt });
    return { code, expiresAt: new Date(expiresAt) };
  }

  /** 使う（期限切れ・使い済み・知らない合言葉なら null）。 */
  take(code: string): Omit<Pending, 'expiresAt'> | null {
    const found = this.#pending.get(code);
    this.#pending.delete(code);
    if (!found || found.expiresAt <= this.#now()) return null;
    return { tenantId: found.tenantId, userId: found.userId, device: found.device };
  }

  #sweep(): void {
    const now = this.#now();
    for (const [code, p] of this.#pending) if (p.expiresAt <= now) this.#pending.delete(code);
  }
}

/** 公開の入口の URL（https のホストだけ。道・クエリ・認証情報は付けない）。 */
export function publicBase(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:' || u.username || u.password) return null;
    if (!/^[a-z0-9.-]+$/.test(u.hostname)) return null;
    return `https://${u.host}`;
  } catch {
    return null;
  }
}

/** 別の PC で流すコマンド（本人に見せる 1 行）。 */
export function pairCommand(base: string, code: string): string {
  return `curl -fsSL ${base}/v1/agent-pair/${code} | sh`;
}

/**
 * 別の PC で動く入れ方のスクリプト。値は形を確かめたものだけを埋める（base: publicBase、
 * token: agent-sessions の TOKEN、device: DEVICE_NAME）。
 */
export function installerScript(input: { base: string; token: string; device: string }): string {
  const { base, token, device } = input;
  if (publicBase(base) !== base) throw new Error('base must be a bare https origin');
  if (!/^[A-Za-z0-9_-]{20,120}$/.test(token)) throw new Error('unexpected token shape');
  if (!DEVICE_NAME.test(device)) throw new Error('unexpected device name');
  return `#!/bin/sh
# Genie: この PC（${device}）の Claude Code を、Genie の Mac につなぐ。
# 入れるもの: ~/.genie/claude-code-hook.sh、~/.genie/claude-code-permission.sh、
#   キーチェーンの鍵（com.astra.agent-hook / ${base}）、~/.claude/settings.json の hooks（前の分は .bak）。
# 外すとき: ~/.genie/claude-code-hooks-uninstall.sh
set -eu
[ "$(uname)" = Darwin ] || { echo 'この入れ方は Mac 用です。' >&2; exit 1; }
base='${base}'
dir="$HOME/.genie"
mkdir -p "$dir" "$HOME/.claude"
chmod 700 "$dir"

# 鍵はキーチェーンへ（コマンドの引数に載せない）
printf 'add-generic-password -U -s com.astra.agent-hook -a %s -T /usr/bin/security -w %s\\n' "$base" '${token}' \\
  | /usr/bin/security -i >/dev/null

cat > "$dir/claude-code-hook.sh" <<'HOOK'
${EVENT_HOOK}HOOK
cat > "$dir/claude-code-permission.sh" <<'HOOK'
${PERMISSION_HOOK}HOOK
cat > "$dir/claude-code-hooks-uninstall.sh" <<'HOOK'
${uninstallScript(base)}HOOK
chmod 700 "$dir/claude-code-hook.sh" "$dir/claude-code-permission.sh" "$dir/claude-code-hooks-uninstall.sh"

GENIE_HOOK_BASE="$base" GENIE_HOOK_MODE=install /usr/bin/osascript -l JavaScript - <<'JXA'
${SETTINGS_JXA}JXA
echo 'Genie につなぎました（${device}）。新しく始めた Claude Code のセッションから、LINE に知らせが届きます。'
`;
}

/** 知らせ（非同期）。Genie に届かなくても、どんなときも 0 で終わる */
const EVENT_HOOK = `#!/bin/sh
# Claude Code の hooks → Genie の Mac（公開の入口）。どんなときも 0 で終わる（Claude Code を止めない）。
base="$1"
case "$base" in https://*) ;; *) exit 0 ;; esac
host="\${base#https://}"
case "$host" in '' | */* | *@* | *[!A-Za-z0-9.:-]*) exit 0 ;; esac
token=$(/usr/bin/security find-generic-password -s com.astra.agent-hook -a "$base" -w 2>/dev/null) || exit 0
[ -n "$token" ] || exit 0
/usr/bin/curl -s -m 5 -o /dev/null -X POST \\
  -H 'content-type: application/json' -H @/dev/fd/3 \\
  --data-binary @- "$base/v1/agent-events/claude-code" 3<<EOF >/dev/null 2>&1
authorization: Bearer $token
EOF
exit 0
`;

/** 許可の問い（同期）。LINE の答えを Claude Code へ返す。届かなければ何も出さずに 0（PC の画面の問いが残る） */
const PERMISSION_HOOK = `#!/bin/sh
# Claude Code の許可の問いを LINE からも答える。何かあれば何も出さずに 0（この PC の画面の問いが残る）。
base="$1"
case "$base" in https://*) ;; *) exit 0 ;; esac
host="\${base#https://}"
case "$host" in '' | */* | *@* | *[!A-Za-z0-9.:-]*) exit 0 ;; esac
token=$(/usr/bin/security find-generic-password -s com.astra.agent-hook -a "$base" -w 2>/dev/null) || exit 0
[ -n "$token" ] || exit 0
work=$(/usr/bin/mktemp -d 2>/dev/null) || exit 0
trap '/bin/rm -rf "$work"' EXIT INT TERM
/bin/cat > "$work/ask.json" || exit 0
umask 077
printf 'authorization: Bearer %s\\n' "$token" > "$work/auth"
post() {
  /usr/bin/curl -s -m "$3" -o "$work/out" -w '%{http_code}' -X POST \\
    -H 'content-type: application/json' -H @"$work/auth" \\
    --data-binary @"$2" "$base$1" 2>/dev/null
}
case "$(post /v1/agent-approvals/claude-code "$work/ask.json" 15)" in
  200) /bin/cat "$work/out"; exit 0 ;;
  201) ;;
  *) exit 0 ;;
esac
id=$(/usr/bin/sed -n 's/.*"id":"\\([0-9a-f-]\\{36\\}\\)".*/\\1/p' "$work/out")
[ -n "$id" ] || exit 0
printf '{"wait_ms":20000}' > "$work/wait.json"
deadline=$(( $(/bin/date +%s) + 560 ))
while [ "$(/bin/date +%s)" -lt "$deadline" ]; do
  code=$(post "/v1/agent-approvals/$id/wait" "$work/wait.json" 35)
  case "$code" in
    200) /bin/cat "$work/out"; exit 0 ;;
    202) ;;
    *) exit 0 ;;
  esac
done
exit 0
`;

/** ~/.claude/settings.json に hooks を足す・外す（ほかの hooks や設定には触らない。書く前に .bak） */
const SETTINGS_JXA = `ObjC.import('Foundation');
const env = $.NSProcessInfo.processInfo.environment;
const get = (k) => ObjC.unwrap(env.objectForKey(k));
const home = get('HOME') || ObjC.unwrap($.NSHomeDirectory());
const file = home + '/.claude/settings.json';
const base = get('GENIE_HOOK_BASE');
const mode = get('GENIE_HOOK_MODE');
const fm = $.NSFileManager.defaultManager;
let settings = {};
if (fm.fileExistsAtPath(file)) {
  const text = ObjC.unwrap($.NSString.stringWithContentsOfFileEncodingError(file, $.NSUTF8StringEncoding, null));
  settings = text && text.trim() ? JSON.parse(text) : {};
  fm.removeItemAtPathError(file + '.bak', null);
  fm.copyItemAtPathToPathError(file, file + '.bak', null);
}
const hookDir = home + '/.genie/';
const ours = (entry) =>
  Array.isArray(entry && entry.hooks) &&
  entry.hooks.some((h) => typeof (h && h.command) === 'string' && h.command.indexOf(hookDir + 'claude-code-') >= 0);
settings.hooks = settings.hooks || {};
for (const event of Object.keys(settings.hooks)) {
  if (!Array.isArray(settings.hooks[event])) continue;
  const kept = settings.hooks[event].filter((e) => !ours(e));
  if (kept.length) settings.hooks[event] = kept;
  else delete settings.hooks[event];
}
if (mode === 'install') {
  const command = JSON.stringify(hookDir + 'claude-code-hook.sh') + ' ' + base;
  for (const event of ${JSON.stringify(['SessionStart', 'UserPromptSubmit', 'PostToolUse', 'PostToolUseFailure', 'PermissionRequest', 'Notification', 'Elicitation', 'Stop', 'StopFailure', 'SessionEnd'])}) {
    settings.hooks[event] = (settings.hooks[event] || []).concat([{ hooks: [{ type: 'command', command, async: true }] }]);
  }
  settings.hooks.PermissionRequest.push({
    hooks: [{ type: 'command', command: JSON.stringify(hookDir + 'claude-code-permission.sh') + ' ' + base, timeout: 600 }],
  });
}
if (Object.keys(settings.hooks).length === 0) delete settings.hooks;
const out = $.NSString.alloc.initWithUTF8String(JSON.stringify(settings, null, 2) + '\\n');
if (!out.writeToFileAtomicallyEncodingError(file, true, $.NSUTF8StringEncoding, null)) throw new Error('settings.json に書けませんでした');
`;

/** 外す（hooks を外し、鍵をキーチェーンから消す。Genie 側の鍵は Mac で取り消す） */
const uninstallScript = (base: string) => `#!/bin/sh
/usr/bin/security delete-generic-password -s com.astra.agent-hook -a '${base}' >/dev/null 2>&1 || true
GENIE_HOOK_MODE=uninstall /usr/bin/osascript -l JavaScript - <<'JXA'
${SETTINGS_JXA}JXA
/bin/rm -f "$HOME/.genie/claude-code-hook.sh" "$HOME/.genie/claude-code-permission.sh" "$HOME/.genie/claude-code-hooks-uninstall.sh"
echo 'Genie の hooks を外しました。Genie の Mac 側の鍵は、Mac で取り消してください。'
`;
