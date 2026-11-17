#!/bin/sh
# Claude Code の許可の問い（PermissionRequest）を LINE からも答えられるようにする（docs/AGENT_SESSIONS.ja.md）。
#
#   Claude Code が問いの JSON を標準入力に渡す → 手元の gateway が本人の LINE にカードを出す
#   → 本人が「承認」「拒否」「指示を添える」「同種を許可」→ その答えを標準出力に出す（Claude Code がそのまま続ける）
#   本人が前もって許した同種の操作（継続許可）なら、カードを出さずにその場で答えが返る
#
# Mac の画面にも同じ問いが出ていて、先に答えたほうが通る。
# LINE をつないでいない・Genie が止まっている・期限が来た・Mac で答えた … **何も出さずに 0 で終わる**
# （Mac の問いがそのまま残る。Genie の都合で Claude Code を止めたり、勝手に承認したりしない）。
# 送り先は手元（127.0.0.1 / localhost）だけ。鍵はキーチェーン（claude-code-hook.sh と同じ）。
#
#   claude-code-permission.sh http://127.0.0.1:43123
base="$1"
port="${base#http://127.0.0.1:}"
[ "$port" = "$base" ] && port="${base#http://localhost:}"
case "$port" in
  '' | *[!0-9]* | "$base") exit 0 ;;
esac
token=$(/usr/bin/security find-generic-password -s com.astra.agent-hook -a "$base" -w 2>/dev/null) || exit 0
[ -n "$token" ] || exit 0

work=$(/usr/bin/mktemp -d 2>/dev/null) || exit 0
trap '/bin/rm -rf "$work"' EXIT INT TERM
/bin/cat > "$work/ask.json" || exit 0
# 鍵はコマンドの引数に載せない（ps で見える）。見出しはファイルから渡す（このフォルダは本人だけ読める）
umask 077
printf 'authorization: Bearer %s\n' "$token" > "$work/auth"

post() { # post <path> <body file> <最大秒> → 応答の本文は $work/out、状態の番号を出す
  /usr/bin/curl -s -m "$3" -o "$work/out" -w '%{http_code}' -X POST \
    -H 'content-type: application/json' -H @"$work/auth" \
    --data-binary @"$2" "$base$1" 2>/dev/null
}

case "$(post /v1/agent-approvals/claude-code "$work/ask.json" 10)" in
  # 本人が前もって許した同種の操作（継続許可）。その場の答えを返す
  200) /bin/cat "$work/out"; exit 0 ;;
  201) ;;
  *) exit 0 ;;
esac
id=$(/usr/bin/sed -n 's/.*"id":"\([0-9a-f-]\{36\}\)".*/\1/p' "$work/out")
[ -n "$id" ] || exit 0

printf '{"wait_ms":20000}' > "$work/wait.json"
# Claude Code の hooks の上限（600 秒）より前に必ず終える
deadline=$(( $(/bin/date +%s) + 560 ))
while [ "$(/bin/date +%s)" -lt "$deadline" ]; do
  code=$(post "/v1/agent-approvals/$id/wait" "$work/wait.json" 30)
  case "$code" in
    200) /bin/cat "$work/out"; exit 0 ;;
    202) ;;
    *) exit 0 ;;
  esac
done
exit 0
