#!/usr/bin/env bash
# 3 本の Journey（J-A Task / J-B Meeting / J-C Failure）を**最後まで**通す。
#
# 画面 1 枚の検査（2pt / golden / density）は「崩れていない」しか言えない。
# ここは時間軸: 窓の数・鍵・面の座標・遷移・出所 id が段を跨いで続くか（層 A）。
# 落ちたら result.json の errors にどの段で何が切れたかが残る。
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BIN="${ASTRA_RECORD_BIN:-$ROOT/apps/genie-macos/.build/Genie.app/Contents/MacOS/GenieMac}"
source "$ROOT/scripts/app-selftest-runner.sh"
prepare_app_selftest || exit $?
OUT="$ROOT/docs/ux-benchmark/astra"
fail=0
for j in JA JB JC; do
  output="$(run_app_selftest journey "$j" "$OUT/$j")"; status=$?
  line="$(grep -E '^JOURNEY' <<<"$output" | head -1)"
  echo "  ${line:-$j: 記録できない}"
  if [[ "$status" -ne 0 ]] || ! grep -q 'success=true' <<<"$line"; then
    fail=1
    python3 - "$OUT/$j/result.json" <<'PY' 2>/dev/null || true
import json,sys
for e in json.load(open(sys.argv[1]))['errors']: print('    -', e)
PY
  fi
done
# J-B の「面が姿を変える途中」を観測する（Meeting → Notes → Workspace）。実効fpsは別に記録する。段の前後の
# 静止画では、途中で窓が入れ替わる・上辺が揺れる・frame が抜けるのは写らない。
# 撮るのは自分の窓だけ。frame は使い捨て、数字（result.json）だけ残す。
MOTION_TMP="$(mktemp -d)"
motion="$(run_app_selftest surfacemotion "$MOTION_TMP")"; motion_status=$?
echo "$motion" | grep -E '^  MOTION|^  NOT_MEASURED|^    \^|^SURFACE_CONTINUITY_MOTION|^PERCEIVED'
if [[ "$motion_status" -eq 0 ]] && grep -q 'SURFACE_CONTINUITY_MOTION=PASS' <<<"$motion"; then
  mkdir -p "$OUT/JB-motion" && cp "$MOTION_TMP/result.json" "$OUT/JB-motion/result.json"
else
  fail=1
fi
rm -rf "$MOTION_TMP"
[ $fail -eq 0 ] && echo "JOURNEYS_OK: 3 本の手順と観測した窓・面の連続性を確認（実効fps・未計測項目は上記）"
exit $fail
