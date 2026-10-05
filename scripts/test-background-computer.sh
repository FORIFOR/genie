#!/usr/bin/env bash
# All mutations are confined to two new native fixture apps and a new temporary directory.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$(cd "$(mktemp -d /tmp/genie-background-native.XXXXXX)" && pwd -P)"
chmod 700 "$WORK"
TARGET_PID=''
SENTINEL_PID=''
cleanup() {
  [[ -z "$TARGET_PID" ]] || kill "$TARGET_PID" 2>/dev/null || true
  [[ -z "$SENTINEL_PID" ]] || kill "$SENTINEL_PID" 2>/dev/null || true
}
trap cleanup EXIT
swiftc "$ROOT/tools/computer-use/BackgroundFixture.swift" -o "$WORK/Fixture"
# SPI を外したビルドでも AX 経路が生きていることを確かめられるようにする。
SPI_FLAG="-D GENIE_PRIVATE_SPI"
if [[ "${GENIE_NO_PRIVATE_SPI:-0}" == "1" ]]; then SPI_FLAG=""; fi
# shellcheck disable=SC2086
swiftc -D GENIE_BACKGROUND_TEST $SPI_FLAG -parse-as-library \
  "$ROOT/tools/computer-use/genie-computer.swift" "$ROOT/tools/computer-use/GeneratedPointerMetrics.swift" \
  "$ROOT/tools/computer-use/PrivateSPIBridge.swift" \
  "$ROOT/tools/computer-use/BackgroundNativeInput.swift" \
  "$ROOT/tools/computer-use/BackgroundTextEdit.swift" \
  "$ROOT/tools/computer-use/BackgroundScroll.swift" \
  "$ROOT/tools/computer-use/BackgroundWebLink.swift" \
  "$ROOT/tools/computer-use/TargetPreview.swift" \
  "$ROOT/tools/computer-use/BackgroundAX.swift" \
  "$ROOT/tools/computer-use/BackgroundAXTests.swift" -o "$WORK/Verify" > "$WORK/build.log" 2>&1
for role in target sentinel; do
  app="$WORK/GenieBackground-$role.app"
  mkdir -p "$app/Contents/MacOS"
  cp "$WORK/Fixture" "$app/Contents/MacOS/Fixture"
  cat > "$app/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>org.genie.background.$role</string><key>CFBundleName</key><string>Genie Background $role</string><key>CFBundleExecutable</key><string>Fixture</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>
PLIST
  GENIE_FIXTURE_ROLE="$role" GENIE_FIXTURE_RESULT="$WORK/$role.json" "$app/Contents/MacOS/Fixture" > "$WORK/$role.log" 2>&1 &
  fixture_pid=$!
  if [[ "$role" == target ]]; then TARGET_PID="$fixture_pid"; else SENTINEL_PID="$fixture_pid"; fi
  sleep 1
done
printf 'Evidence: %s\n' "$WORK"
"$WORK/Verify" "$TARGET_PID" "$SENTINEL_PID" "$WORK"
