#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$(mktemp -d /tmp/genie-registration-assist.XXXXXX)"
trap 'rm -rf "$WORK"' EXIT
# Compile the production adapter and both capture routes. Tests invoke only pure
# native policy/ordering and an isolated filesystem barrier, never UI/Keychain.
swiftc -j 1 -D GENIE_BACKGROUND_TEST -D GENIE_PRIVATE_SPI -parse-as-library \
  "$ROOT/tools/computer-use/genie-computer.swift" "$ROOT/tools/computer-use/GeneratedPointerMetrics.swift" \
  "$ROOT/tools/computer-use/PrivateSPIBridge.swift" "$ROOT/tools/computer-use/BackgroundNativeInput.swift" \
  "$ROOT/tools/computer-use/BackgroundTextEdit.swift" "$ROOT/tools/computer-use/BackgroundScroll.swift" \
  "$ROOT/tools/computer-use/BackgroundWebLink.swift" "$ROOT/tools/computer-use/TargetPreview.swift" \
  "$ROOT/tools/computer-use/RegistrationVault.swift" "$ROOT/tools/computer-use/RegistrationAssist.swift" \
  "$ROOT/tools/computer-use/BackgroundAX.swift" "$ROOT/tools/computer-use/RegistrationAssistTests.swift" \
  -o "$WORK/Verify"
"$WORK/Verify"
