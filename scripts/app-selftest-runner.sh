#!/usr/bin/env bash
# Shared signed-app selftest launch. No permission requests or raw-executable fallback.
# Callers supply ROOT and BIN; omission/failure remains visible to the aggregate gate.
prepare_app_selftest() {
  case "$BIN" in
    */Contents/MacOS/Genie|*/Contents/MacOS/GenieMac) APP="${BIN%/Contents/MacOS/*}" ;;
    *) APP="$BIN" ;;
  esac
  if [[ ! -x "$BIN" || "$APP" == "$BIN" || ! -f "$APP/Contents/Info.plist" ]]; then
    echo "AUTOMATION_MISSING: native selftest requires a signed current app; set ASTRA_RECORD_BIN" >&2
    return 2
  fi
  codesign --verify --deep --strict "$APP" || return 1
}

run_app_selftest() {
  local logs status=0 key
  local -a app_open
  logs="$(mktemp -d)" || return 1
  mkdir -p "$logs/data" || return 1
  # LS does not inherit the shell's fixture configuration. Without an explicit
  # data root, use disposable test data, never the user's recording library.
  app_open=(open -n -W --env "ASTRA_DATA_ROOT=${ASTRA_DATA_ROOT:-$logs/data}")
  for key in ASTRA_SELFTEST_AGENT_EMAIL ASTRA_SELFTEST_AGENT_TOKEN_PATH ASTRA_GATEWAY_URL; do
    if [[ -n "${!key:-}" ]]; then app_open+=(--env "$key=${!key}"); fi
  done
  env -u ASTRA_DEV_AUTO_UPLOAD "${app_open[@]}" \
    --env "ASTRA_SELFTEST_EXIT_RECEIPT=$logs/exit.json" \
    --stdout "$logs/stdout.txt" --stderr "$logs/stderr.txt" "$APP" \
    --args -astra.transcription.cloudGoogleSTT NO --selftest "$@" || status=$?
  cat "$logs/stdout.txt" 2>/dev/null || true
  cat "$logs/stderr.txt" >&2 2>/dev/null || true
  # `open -W` returning zero is not proof that the app completed normally.
  if [[ "$status" -eq 0 ]]; then
    python3 - "$logs/exit.json" <<'RECEIPT' || status=1
import json, pathlib, sys
try:
    receipt = json.loads(pathlib.Path(sys.argv[1]).read_text())
    ok = (type(receipt) is dict and type(receipt.get('schema')) is int
          and receipt['schema'] == 1 and receipt.get('normalExit') is True
          and type(receipt.get('exitCode')) is int and receipt['exitCode'] == 0)
except (OSError, ValueError, TypeError):
    ok = False
sys.exit(0 if ok else 1)
RECEIPT
  fi
  if [[ "$status" -ne 0 ]]; then
    echo "FAIL: app selftest $1 did not complete normally (logs: $logs)" >&2
    return 1
  fi
  rm -rf "$logs"
}
