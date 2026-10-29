#!/bin/sh
# Claude Code の hooks → 手元の Genie（docs/AGENT_SESSIONS.ja.md）。
#
#   Claude Code が出来事の JSON を標準入力に渡す → そのまま手元の gateway へ送る
#   （残す項目は gateway が選ぶ。道具の入出力・頼みの全文は gateway で捨てる）
#
# 送り先は手元（127.0.0.1 / localhost）だけ。外へは送らない。
# 鍵はキーチェーン（scripts/claude-code-hooks.mjs install が /usr/bin/security で作る。読むときに聞かれない）。
# **どんなときも 0 で終わる。**Genie が止まっていても、Claude Code の作業を止めない・何も出さない。
#
#   claude-code-hook.sh http://127.0.0.1:43123
base="$1"
# 宛先は http://127.0.0.1:<番号> か http://localhost:<番号> そのものだけ（「:1@外の名前」などを通さない）
port="${base#http://127.0.0.1:}"
[ "$port" = "$base" ] && port="${base#http://localhost:}"
case "$port" in
  '' | *[!0-9]* | "$base") exit 0 ;;
esac
token=$(/usr/bin/security find-generic-password -s com.astra.agent-hook -a "$base" -w 2>/dev/null) || exit 0
[ -n "$token" ] || exit 0
# 鍵はコマンドの引数に載せない（ps で見える）。見出しは fd 3 から渡す
/usr/bin/curl -s -m 3 -o /dev/null -X POST \
  -H 'content-type: application/json' -H @/dev/fd/3 \
  --data-binary @- "$base/v1/agent-events/claude-code" 3<<EOF >/dev/null 2>&1
authorization: Bearer $token
EOF
exit 0
