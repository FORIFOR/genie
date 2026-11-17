#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$(mktemp -d /tmp/genie-web-policy.XXXXXX)"
trap 'rm -rf "$WORK"' EXIT
swiftc -j 1 -parse-as-library "$ROOT/tools/computer-use/BackgroundWebLink.swift" \
  "$ROOT/tools/computer-use/BackgroundWebLinkTests.swift" -o "$WORK/Verify"
"$WORK/Verify"
