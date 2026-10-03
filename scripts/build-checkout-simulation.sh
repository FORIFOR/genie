#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP="$ROOT/.build/computer/GenieCheckoutSimulation.app/Contents"
mkdir -p "$APP/MacOS"
swiftc "$ROOT/tools/computer-use/CheckoutSimulation.swift" -o "$APP/MacOS/GenieCheckoutSimulation"
cat > "$APP/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>org.genie.checkout.simulation</string>
<key>CFBundleName</key><string>Genie 模擬注文</string>
<key>CFBundleExecutable</key><string>GenieCheckoutSimulation</string>
<key>CFBundlePackageType</key><string>APPL</string>
</dict></plist>
PLIST
codesign --force --sign - "${APP%/Contents}"
printf '%s\n' "${APP%/Contents}"
