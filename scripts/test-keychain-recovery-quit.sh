#!/usr/bin/env bash
# No main-app build, windows, OS credentials, model, permission request or external signal.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/genie-keychain-quit.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
swiftc -swift-version 5 -target "$(uname -m)-apple-macosx14.0" -parse-as-library \
  "$ROOT/apps/genie-macos/Sources/GenieMac/Settings/KeychainStore.swift" \
  "$ROOT/apps/genie-macos/Sources/GenieMac/App/TerminationDispatch.swift" \
  "$ROOT/scripts/tests/KeychainRecoveryQuitHarness.swift" -o "$WORK/quit-harness"
python3 - "$WORK/quit-harness" <<'PY'
import subprocess, sys
result = subprocess.run([sys.argv[1]], capture_output=True, timeout=3)
events = result.stderr.decode(errors='replace').splitlines()
assert result.returncode == 0, (result.returncode, events)
expected = ['synthetic-read-waiting', 'should-terminate', 'will-terminate']
assert all(event in events for event in expected), events
assert [events.index(event) for event in expected] == sorted(events.index(event) for event in expected), events
assert 'synthetic-read-finished' not in events, events
print('PASS quit while a synthetic existing-item confirmation waits: owned process exited without waiting for the read')
PY
