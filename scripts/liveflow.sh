#!/usr/bin/env bash
# 本物の Gemini Live で、人が話すのと同じ流れを通す（--selftest liveflow）。
# アプリと同じローカルのサービス・同じ開発用の本人 ID で、保存先だけ分けて走らせる。Gemini の声は鳴らさない。
set -euo pipefail
APP="${GENIE_APP:-/Applications/Genie.app}"
GATEWAY="${ASTRA_GATEWAY_URL:-http://127.0.0.1:43123}"
KEY="astra.dev.identity.${GATEWAY}.data-root.${HOME}/Library/Application Support/Genie/local-preview/app"
IDENTITY="${ASTRA_DESKTOP_IDENTITY:-$(defaults read com.astra.mac "$KEY" 2>/dev/null || true)}"
[[ -n "$IDENTITY" ]] || { echo "FAIL: アプリの本人 ID が見つからない" >&2; exit 1; }
DATA="$(mktemp -d)"; OUT="$(mktemp)"; trap 'rm -rf "$DATA" "$OUT"' EXIT
open -n -W --env ASTRA_GATEWAY_URL="$GATEWAY" --env ASTRA_DESKTOP_IDENTITY="$IDENTITY" --env ASTRA_DATA_ROOT="$DATA" \
  --stdout "$OUT" --stderr /dev/null "$APP" --args --selftest liveflow "$@"
cat "$OUT"
grep -q "SELFTEST_OK" "$OUT"
