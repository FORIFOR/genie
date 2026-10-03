#!/usr/bin/env bash
# Keep the complete runner result: an all-skipped or empty suite cannot pass.
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
LOG="$(mktemp)" || exit 1
trap 'rm -f "$LOG"' EXIT
status=0
pnpm --filter @genie/desktop test > "$LOG" 2>&1 || status=$?
cat "$LOG"
[[ "$status" -eq 0 ]] || exit "$status"
if grep -Eq '^[[:space:]]*Tests[[:space:]]+[1-9][0-9]* passed([[:space:]|]|$)' "$LOG"; then
  exit 0
fi
if grep -Eq '^[[:space:]]*Tests[[:space:]]+[1-9][0-9]* skipped([[:space:](]|$)' "$LOG"; then
  echo 'NOT_RUN: desktop_tests (all reported cases were skipped)'
  exit 2
fi
echo 'FAIL: desktop tests produced no executed-test success summary'
exit 1
