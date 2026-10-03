#!/usr/bin/env bash
# The real local-model semantic fixture may load several GiB. Never run it implicitly.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
case "${ASTRA_VERIFY_LOCAL_MODEL:-0}" in
  0)
    echo "NOT_RUN: local_translation_model (explicit ASTRA_VERIFY_LOCAL_MODEL=1 required; may load several GiB)"
    exit 2 ;;
  1) ;;
  *) echo "FAIL: ASTRA_VERIFY_LOCAL_MODEL must be 0 or 1" >&2; exit 1 ;;
esac
BIN="${ASTRA_RECORD_BIN:-$ROOT/apps/genie-macos/.build/Genie.app/Contents/MacOS/GenieMac}"
if [[ ! -x "$BIN" ]]; then
  echo "NOT_RUN: local_translation_model (current app missing; set ASTRA_RECORD_BIN)"
  exit 2
fi
status=0
output="$("$BIN" --selftest translate 2>&1)" || status=$?
printf '%s\n' "$output"
if [[ "$status" -ne 0 ]] || grep -q '^SELFTEST_FAIL' <<<"$output"; then
  echo "FAIL: local_translation_model (process exit $status)" >&2
  exit 1
fi
if grep -q '^SELFTEST_SKIP translate:' <<<"$output"; then
  echo "NOT_RUN: local_translation_model (selftest skipped)"
  exit 2
fi
if ! grep -q '^SELFTEST_OK translate:' <<<"$output"; then
  echo "FAIL: local_translation_model (missing semantic fixture result)" >&2
  exit 1
fi
