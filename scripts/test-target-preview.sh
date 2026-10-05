#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$(mktemp -d /tmp/genie-target-preview.XXXXXX)"
swiftc -D GENIE_BACKGROUND_TEST -parse-as-library \
  "$ROOT/tools/computer-use/genie-computer.swift" \
  "$ROOT/tools/computer-use/GeneratedPointerMetrics.swift" \
  "$ROOT/tools/computer-use/TargetPreview.swift" \
  "$ROOT/tools/computer-use/TargetPreviewTests.swift" -o "$WORK/Verify" > "$WORK/build.log" 2>&1 \
  || { cat "$WORK/build.log" >&2; exit 1; }
"$WORK/Verify" "$1" "$2"
