#!/usr/bin/env bash
# Swift/core → 実 gateway → DB の往復。gateway が居なければ skip（既存問題と切り分け）。
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
source "$ROOT/scripts/build-resource-env.sh"
BASE="${ASTRA_GATEWAY_URL:-http://127.0.0.1:3000}"
if ! curl -s -o /dev/null --max-time 3 "$BASE/v1/auth/providers"; then
  echo "SKIP: gateway not reachable at $BASE (start with: pnpm dev:gateway)"
  exit 0
fi
# 1) core の Rust 結合テスト
( cd "$ROOT/core/genie-core" && ASTRA_GATEWAY_URL="$BASE" cargo test --quiet dev_sign_in_then_me 2>&1 | grep -E "test result" | head -1 )
# 2) Swift → core → gateway
cd "$ROOT/apps/genie-macos"; swift build --jobs "$GENIE_SWIFT_BUILD_JOBS" >/dev/null
OUT="$("$(swift build --jobs "$GENIE_SWIFT_BUILD_JOBS" --show-bin-path)/GenieMac" --selftest api "$BASE")"
echo "$OUT"
[[ "$OUT" == SELFTEST_OK* ]] || { echo "FAIL: Swift→core→gateway" >&2; exit 1; }
