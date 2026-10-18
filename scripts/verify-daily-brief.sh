#!/usr/bin/env bash
# Uses only synthetic Home fixtures and an isolated local store; no account reads.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
if [[ "$(uname -s)" != Darwin ]]; then
  echo "SELFTEST_SKIP dailybrief: macOS is required"
  exit 2
fi
DAILY_BRIEF_DATA="$(mktemp -d /tmp/genie-daily-brief-data.XXXXXX)"
trap 'rm -rf "$DAILY_BRIEF_DATA"' EXIT
ASTRA_DATA_ROOT="$DAILY_BRIEF_DATA" "$ROOT/apps/genie-macos/.build/debug/GenieMac" \
  -astra.uiScale comfortable --selftest dailybrief "${1:-/tmp/genie-daily-brief-verify}"
