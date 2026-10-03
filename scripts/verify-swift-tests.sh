#!/usr/bin/env bash
# Run process-wide shutdown in its own XCTest process, then independently run
# the external semantic fixture. An omitted fixture remains a reported omission.
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
source "$ROOT/scripts/build-resource-env.sh" || exit 1
cd "$ROOT/apps/genie-macos" || exit 1
case "${ASTRA_VERIFY_CODEX_TRANSLATION:-0}" in
  0|1) ;;
  *) echo "FAIL: ASTRA_VERIFY_CODEX_TRANSLATION must be 0 or 1"; exit 1 ;;
esac
fail=0
not_run=0
SHUTDOWN='CodexTranslationProcessTests/testApplicationShutdownEntrypointCleansOwnedChildAndContext'
EXTERNAL='CodexTranslationTests/testRealCodexTranslationOnlyWithExplicitOptIn'
run_suite() {
  local label="$1" expected="$2" output status=0 summary count
  shift 2
  output="$("$@" 2>&1)" || status=$?
  summary="$(printf '%s\n' "$output" | grep -E 'Executed [0-9]+ tests?' | tail -1)"
  printf '%s: %s\n' "$label" "$summary"
  count="$(printf '%s\n' "$summary" | sed -nE 's/.*Executed ([0-9]+) tests?.*/\1/p')"
  if grep -qE 'with [1-9][0-9]* tests? skipped' <<<"$summary"; then
    echo "NOT_RUN: $label $summary"
    printf '%s\n' "$output" | grep -E 'Test Case .* skipped' || true
    not_run=1
  fi
  if [[ "$status" -ne 0 || -z "$count" || "$count" -eq 0 ]] ||
     { [[ "$expected" != any ]] && [[ "$count" != "$expected" ]]; } ||
     ! grep -qE 'and 0 failures|with 0 failures' <<<"$summary"; then
    printf '%s\n' "$output"
    echo "FAIL: $label (exit $status; expected $expected nonzero tests)"
    fail=1
  fi
}

# --skip only separates these two named tests; both are accounted for below.
run_suite macOS_swift_unit any env ASTRA_VERIFY_CODEX_SHUTDOWN=0 ASTRA_VERIFY_CODEX_TRANSLATION=0 \
  swift test --jobs "$GENIE_SWIFT_BUILD_JOBS" --skip "$SHUTDOWN|$EXTERNAL"
# This fixture starts and cleans up only its own synthetic child, without a model.
run_suite macOS_swift_shutdown 1 env ASTRA_VERIFY_CODEX_SHUTDOWN=1 ASTRA_VERIFY_CODEX_TRANSLATION=0 \
  swift test --skip-build --filter "$SHUTDOWN"
if [[ "${ASTRA_VERIFY_CODEX_TRANSLATION:-0}" == 1 ]]; then
  run_suite macOS_swift_external_translation 1 env ASTRA_VERIFY_CODEX_SHUTDOWN=0 ASTRA_VERIFY_CODEX_TRANSLATION=1 \
    swift test --skip-build --filter "$EXTERNAL"
else
  echo "NOT_RUN: macOS_swift_external_translation (ASTRA_VERIFY_CODEX_TRANSLATION=1 required)"
  not_run=1
fi
[[ "$fail" -eq 0 ]] || exit 1
[[ "$not_run" -eq 0 ]] || exit 2
echo "SWIFT_TESTS_OK: unit, isolated shutdown and external semantic fixture completed"
