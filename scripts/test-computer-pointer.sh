#!/usr/bin/env bash
# Renders synthetic pointer fixtures. --native briefly displays a passive overlay only.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$(mktemp -d /tmp/genie-pointer-test.XXXXXX)"
swiftc -D GENIE_BACKGROUND_TEST -parse-as-library \
  "$ROOT/tools/computer-use/genie-computer.swift" \
  "$ROOT/tools/computer-use/GeneratedPointerMetrics.swift" \
  "$ROOT/tools/computer-use/PointerVisualTests.swift" -o "$WORK/Verify" > "$WORK/build.log" 2>&1 \
  || { cat "$WORK/build.log" >&2; exit 1; }
"$WORK/Verify" "${1:-$WORK/evidence}" "${2:-}"
