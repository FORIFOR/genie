#!/usr/bin/env bash
# Small AppKit-only regression; no main-app build, windows, model, or external signal.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/genie-termination.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
swiftc -swift-version 5 -parse-as-library \
  "$ROOT/apps/genie-macos/Sources/GenieMac/App/TerminationDispatch.swift" \
  "$ROOT/scripts/tests/TerminationDispatchHarness.swift" \
  -o "$WORK/termination-harness"
python3 - "$WORK/termination-harness" <<'PY'
import subprocess
import sys

binary = sys.argv[1]
for mode in ("legacy", "scheduled", "direct", "signal"):
    timed_out = False
    try:
        result = subprocess.run([binary, mode], capture_output=True, timeout=3)
        code, output = result.returncode, result.stderr.decode(errors="replace")
    except subprocess.TimeoutExpired as error:
        # subprocess.run has killed and waited for this exact owned child.
        timed_out = True
        code, output = None, (error.stderr or b"").decode(errors="replace")
    events = output.splitlines()
    if mode == "legacy":
        assert timed_out and "should-terminate" in events, output
        assert "cleanup-started" not in events and "will-terminate" not in events, output
    else:
        assert not timed_out and code == 0, f"{mode}: exit={code}; timeout={timed_out}\n{output}"
        expected = ["should-terminate", "cleanup-started", "cleanup-finished", "reply", "will-terminate"]
        assert all(event in events for event in expected), output
        assert [events.index(event) for event in expected] == sorted(events.index(event) for event in expected), output
        if mode != "direct":
            assert events.index("dispatch-returned") < events.index("should-terminate"), output
            assert "cleanup-mainactor" in events, output
        if mode == "signal":
            assert "signal-received" in events, output
    print(f"PASS {mode}: {' -> '.join(event for event in events if event in ('signal-received', 'dispatch-entered', 'dispatch-returned', 'should-terminate', 'cleanup-started', 'cleanup-mainactor', 'cleanup-finished', 'reply', 'will-terminate'))}")
PY
