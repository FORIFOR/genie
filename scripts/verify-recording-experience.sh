#!/usr/bin/env bash
# 録音セッションの通し E2E。**プロセスを跨ぐ**ので、同じプロセス内の reset/load では代えられない。
#
#   起動 → 録音開始 → （停止前に DB に recording がある）
#   → プロセスを kill（＝落ちた）
#   → 起動し直す → interrupted として戻る（勝手に ready にしない）
#   → 続きから processing → ready
#   → もう一度起動し直しても ready のまま
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
source "$ROOT/scripts/build-resource-env.sh"
cd "$ROOT/apps/genie-macos"
swift build --jobs "$GENIE_SWIFT_BUILD_JOBS" >/dev/null
BIN="$(swift build --jobs "$GENIE_SWIFT_BUILD_JOBS" --show-bin-path)/GenieMac"
DB="$(mktemp -t astra-experience).sqlite"
trap 'rm -f "$DB" "$DB"-wal "$DB"-shm' EXIT

step() { printf '  %-22s %s\n' "$1" "$2"; }

# ---- 1) 録音を始めて、そのまま生かしておく
"$BIN" --selftest recordleg "$DB" record > /tmp/astra-leg-record.log 2>&1 &
LEG_PID=$!
for _ in $(seq 1 60); do
  grep -q "RECORDLEG_OK record" /tmp/astra-leg-record.log 2>/dev/null && break
  sleep 0.5
done
LINE="$(grep 'RECORDLEG_OK record' /tmp/astra-leg-record.log || true)"
[[ -n "$LINE" ]] || { echo "FAIL: 録音を開始できない"; cat /tmp/astra-leg-record.log; exit 1; }
ID="${LINE#*id=}"
step "録音開始" "id=${ID} (停止前に DB へ recording を確認済み)"

# ---- 2) 落とす（保存の機会を与えない）
kill -9 "$LEG_PID" 2>/dev/null || true
wait "$LEG_PID" 2>/dev/null || true
step "強制終了" "kill -9（正常終了の経路を通さない）"

# ---- 3) 落ちた直後の DB は recording のまま
OUT="$("$BIN" --selftest recordleg "$DB" inspect)"
grep -q "$ID=recording" <<<"$OUT" || { echo "FAIL: 落ちた後に recording が残っていない: $OUT"; exit 1; }
step "DB(kill 直後)" "${ID}=recording"

# ---- 4) 起動し直すと interrupted（**勝手に ready にしない**）
OUT="$("$BIN" --selftest recordleg "$DB" resume)"
grep -q "$ID=interrupted" <<<"$OUT" || { echo "FAIL: interrupted で戻らない: $OUT"; exit 1; }
grep -q "$ID=ready" <<<"$OUT" && { echo "FAIL: 勝手に ready になっている"; exit 1; }
step "再起動" "${ID}=interrupted"

# ---- 5) 続きから読み取って ready へ
OUT="$("$BIN" --selftest recordleg "$DB" finish)"
grep -q "status=ready" <<<"$OUT" || { echo "FAIL: 続きから ready にできない: $OUT"; exit 1; }
step "続きから処理" "$(sed 's/RECORDLEG_OK finish //' <<<"$OUT")"

# ---- 6) もう一度起動しても ready のまま（同じ id）
OUT="$("$BIN" --selftest recordleg "$DB" resume)"
grep -q "$ID=ready" <<<"$OUT" || { echo "FAIL: 再起動で ready が保たれない: $OUT"; exit 1; }
step "再々起動" "${ID}=ready (同じ id)"

echo "RECORDING_EXPERIENCE_OK: 録音 → kill → interrupted → 続きから ready → 再起動で保持 (id=${ID})"
