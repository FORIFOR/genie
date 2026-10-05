#!/usr/bin/env bash
# Keep real Japanese STT opt-in and in a separate test process: ordinary unit
# tests intentionally mutate the model/library environment while testing lookup.
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
source "$ROOT/scripts/build-resource-env.sh" || exit 1
cd "$ROOT/apps/desktop/src-tauri" || exit 1
case "${ASTRA_VERIFY_SHERPA_STT:-0}" in
  0|1) ;;
  *) echo "FAIL: ASTRA_VERIFY_SHERPA_STT must be 0 or 1"; exit 1 ;;
esac
fail=0
not_run=0
LOG_DIR="$(mktemp -d)" || exit 1
trap 'rm -rf "$LOG_DIR"' EXIT
run_suite() {
  local label="$1" expected="$2" status=0 result=0 log="$LOG_DIR/suite.log"
  shift 2
  "$@" > "$log" 2>&1 || status=$?
  # Keep actual recognition/latency observations, including an OVER budget;
  # passing assertions do not establish recognition quality or a latency target.
  if [[ "$expected" == 3 || "$status" -ne 0 ]]; then cat "$log"
  else grep 'test result:' "$log" || true; fi
  python3 - "$log" "$expected" <<'PY' || result=$?
import pathlib, re, sys
text = pathlib.Path(sys.argv[1]).read_text()
rows = re.findall(r'^test result: (ok|FAILED)\. (\d+) passed; (\d+) failed; (\d+) ignored;', text, re.M)
passed = sum(int(row[1]) for row in rows)
failed = any(row[0] != 'ok' or int(row[2]) for row in rows)
ignored = sum(int(row[3]) for row in rows)
expected = sys.argv[2]
if not rows or failed or passed == 0 or (expected != 'any' and passed != int(expected)):
    sys.exit(1)
sys.exit(2 if ignored else 0)
PY
  if [[ "$status" -ne 0 || "$result" -eq 1 ]]; then
    echo "FAIL: $label (exit $status; expected $expected nonzero passing tests)"
    fail=1
  elif [[ "$result" -ne 0 ]]; then
    echo "NOT_RUN: $label has ignored tests"
    not_run=1
  fi
}

if [[ "${ASTRA_VERIFY_SHERPA_STT:-0}" == 1 ]]; then
  # Separate exactly the three named tests, then require all three to run below.
  # Other/new ignored tests remain visible and keep the gate partial.
  run_suite tauri_unit any cargo test --quiet -- \
    --skip stt::recognizer::real::transcribes_a_real_recording \
    --skip stt::recognizer::real::measures_the_first_partial \
    --skip stt::recognizer::real::shows_what_a_shorter_window_costs
  run_suite tauri_real_stt 3 cargo test --lib stt::recognizer::real -- \
    --ignored --nocapture --test-threads=1
else
  run_suite tauri_unit any cargo test --quiet
  echo "NOT_RUN: tauri_real_stt (ASTRA_VERIFY_SHERPA_STT=1 plus Sherpa library, Japanese model and public test WAVs required)"
  not_run=1
fi
[[ "$fail" -eq 0 ]] || exit 1
[[ "$not_run" -eq 0 ]] || exit 2
echo "TAURI_TESTS_OK: unit and isolated real STT assertions completed (quality/latency observations are separate)"
