#!/usr/bin/env bash
# Foundation-only policy regression; no app, permission, model, capture or input.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
swiftc -j 1 -parse-as-library \
  "$ROOT/tools/computer-use/BackgroundTextEdit.swift" \
  "$ROOT/tools/computer-use/BackgroundTextEditTests.swift" -o "$WORK/verify"
"$WORK/verify"
