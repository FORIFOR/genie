#!/usr/bin/env bash
# 画面の語が面ごとに変わっていないかを、**文字列リテラル**で確かめる。
#
# 同じものが Dock では「決まったこと」、Library では「決定事項」、Workspace の
# 群では「宿題」と呼ばれていた（Journey J-B で実測）。語が変わると、利用者は
# 「別のものか」と一度止まる。正本は Dock の Notes の語:
#   決まったこと / やること / 質問 / 懸念 / メモ、出所（provenance）。
# 変える先の語はここに書く。`command:` と `case "…":` は AI への指示名なので対象外。
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/apps/genie-macos/Sources/GenieMac"
fail=0
check() {   # $1 = 使わない語, $2 = 使う語
  hits="$(grep -rn "\"[^\"]*$1[^\"]*\"" "$SRC" \
    | grep -v 'SelfTest.swift\|command:\|case "\|^[^:]*:[0-9]*:[[:space:]]*//' \
    | python3 -c '
import re, sys
word = sys.argv[1]
for line in sys.stdin:
    # Release notes name a release artifact, not the meeting Memo surface (DS-06).
    # Remove only this compound before checking; a separate ノート on the same line still fails.
    checked = line.replace("リリースノート", "") if word == "ノート" else line
    if re.search(r"\"[^\"]*" + re.escape(word) + r"[^\"]*\"", checked):
        print(line, end="")
' "$1" || true)"
  if [ -n "$hits" ]; then
    echo "FAIL: 「$1」ではなく「$2」と言う:"; echo "$hits" | sed 's/^/  /'; fail=1
  fi
}
check "決定事項" "決まったこと"
check "アクション項目" "やること"
check "宿題" "質問"
check "ノート" "メモ"
check "出典" "出所"
check "根拠" "出所"
if [ $fail -eq 0 ]; then echo "TERMS_OK: 画面の語は 1 語ずつ"; fi
exit $fail
