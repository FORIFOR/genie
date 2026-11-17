#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$(mktemp -d /tmp/genie-scroll-policy.XXXXXX)"
trap 'rm -rf "$WORK"' EXIT
swiftc -j 1 -parse-as-library "$ROOT/tools/computer-use/BackgroundScroll.swift" \
  "$ROOT/tools/computer-use/BackgroundScrollTests.swift" -o "$WORK/Verify"
"$WORK/Verify"
