#!/usr/bin/env bash
# 背景ネイティブ入力の回帰試験。毎回まっさらな fixture から始める。
# 変更は使い捨ての fixture アプリと新しい一時ディレクトリの中だけに閉じる。
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$(mktemp -d /tmp/genie-native-input.XXXXXX)"
# helper は「渡された道が正規であること」を求める（symlink 越しに書かせないため）。
# macOS の /tmp は /private/tmp への symlink なので、実体へ直してから渡す。
WORK="$(cd "$WORK" && pwd -P)"
chmod 700 "$WORK"
FIXTURE_PID=''
cleanup() { [[ -z "$FIXTURE_PID" ]] || kill "$FIXTURE_PID" 2>/dev/null || true; }
trap cleanup EXIT
swiftc "$ROOT/tools/computer-use/NativeInputFixture.swift" -o "$WORK/Fixture"
swiftc -D GENIE_BACKGROUND_TEST -D GENIE_PRIVATE_SPI -parse-as-library \
  "$ROOT/tools/computer-use/genie-computer.swift" "$ROOT/tools/computer-use/GeneratedPointerMetrics.swift" \
  "$ROOT/tools/computer-use/PrivateSPIBridge.swift" \
  "$ROOT/tools/computer-use/BackgroundNativeInput.swift" \
  "$ROOT/tools/computer-use/BackgroundTextEdit.swift" \
  "$ROOT/tools/computer-use/BackgroundScroll.swift" \
  "$ROOT/tools/computer-use/BackgroundWebLink.swift" \
  "$ROOT/tools/computer-use/TargetPreview.swift" \
  "$ROOT/tools/computer-use/BackgroundAX.swift" \
  "$ROOT/tools/computer-use/BackgroundNativeTests.swift" -o "$WORK/Verify" > "$WORK/build.log" 2>&1
app="$WORK/GenieNativeInput.app"
mkdir -p "$app/Contents/MacOS"
cp "$WORK/Fixture" "$app/Contents/MacOS/Fixture"
cat > "$app/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>org.genie.nativeinput.fixture</string><key>CFBundleName</key><string>Genie Native Input</string><key>CFBundleExecutable</key><string>Fixture</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>
PLIST
NATIVE_RESULT="$WORK/readback.json" "$app/Contents/MacOS/Fixture" > "$WORK/fixture.log" 2>&1 &
FIXTURE_PID=$!
sleep 2
printf 'Evidence: %s\n' "$WORK"
"$WORK/Verify" "$FIXTURE_PID" "$WORK" "$WORK/readback.json" org.genie.nativeinput.fixture
