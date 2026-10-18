#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="${GENIE_COMPUTER_BUILD_DIR:-$ROOT/.build/computer}"
if [[ "$OUT" != /* ]]; then
  echo "GENIE_COMPUTER_BUILD_DIR must be an absolute path" >&2
  exit 1
fi
APP_BUNDLE="${GENIE_COMPUTER_APP_BUNDLE:-0}"
if [[ "$APP_BUNDLE" != "0" && "$APP_BUNDLE" != "1" ]]; then
  echo "GENIE_COMPUTER_APP_BUNDLE must be 0 or 1" >&2
  exit 1
fi
if [[ "$APP_BUNDLE" == "1" && -z "${GENIE_COMPUTER_SIGN_IDENTITY:-}" ]]; then
  echo "The app bundle requires an explicit certificate signing identity and team" >&2
  exit 1
fi
mkdir -p "$OUT"
swiftc -parse-as-library -O "$ROOT/tools/computer-use/genie-computer.swift" "$ROOT/tools/computer-use/GeneratedPointerMetrics.swift" -o "$OUT/genie-computer"
"$OUT/genie-computer" --self-test
# 背景経路。非公開 SPI は PrivateSPIBridge.swift だけに閉じ込めてある。
# GENIE_NO_PRIVATE_SPI=1 で外したビルドを作れる（公開 API のみを求める審査条件向け）。
# 外した場合、AX で表せる操作は動き、座標クリックとキーは経路なしとして拒否される。
SPI_FLAG="-D GENIE_PRIVATE_SPI"
if [[ "${GENIE_NO_PRIVATE_SPI:-0}" == "1" ]]; then SPI_FLAG=""; fi
REGISTRATION_INPUTS=("$ROOT/tools/computer-use/RegistrationVault.swift" "$ROOT/tools/computer-use/RegistrationAssist.swift")
if [[ -n "${GENIE_COMPUTER_SIGN_IDENTITY:-}" ]]; then
  if [[ ! "${GENIE_COMPUTER_TEAM_ID:-}" =~ ^[A-Z0-9]{10}$ ]]; then
    echo "GENIE_COMPUTER_TEAM_ID must be the explicit 10-character signing team" >&2
    exit 1
  fi
  if [[ "$GENIE_COMPUTER_SIGN_IDENTITY" == "-" ]]; then
    echo "Registration requires a certificate identity, not ad-hoc signing" >&2
    exit 1
  fi
  printf 'enum RegistrationBuildSigning { static let expectedTeam = "%s" }\n' "$GENIE_COMPUTER_TEAM_ID" > "$OUT/RegistrationBuildSigning.swift"
  REGISTRATION_INPUTS+=(-D GENIE_REGISTRATION_SIGNED "$OUT/RegistrationBuildSigning.swift")
fi
# shellcheck disable=SC2086
swiftc -D GENIE_BACKGROUND $SPI_FLAG -parse-as-library -O \
  "$ROOT/tools/computer-use/genie-computer.swift" "$ROOT/tools/computer-use/GeneratedPointerMetrics.swift" \
  "$ROOT/tools/computer-use/PrivateSPIBridge.swift" \
  "$ROOT/tools/computer-use/BackgroundNativeInput.swift" \
  "$ROOT/tools/computer-use/BackgroundTextEdit.swift" \
  "$ROOT/tools/computer-use/BackgroundScroll.swift" \
  "$ROOT/tools/computer-use/BackgroundWebLink.swift" \
  "$ROOT/tools/computer-use/TargetPreview.swift" \
  "$ROOT/tools/computer-use/BackgroundAX.swift" \
  "${REGISTRATION_INPUTS[@]}" \
  -o "$OUT/genie-computer-background"
if [[ -n "${GENIE_COMPUTER_SIGN_IDENTITY:-}" ]]; then
  codesign --force --sign "$GENIE_COMPUTER_SIGN_IDENTITY" --identifier com.astra.computer.registration \
    --timestamp=none "$OUT/genie-computer-background"
  codesign --verify --strict --requirement "=identifier \"com.astra.computer.registration\" and anchor apple generic and certificate leaf[subject.OU] = \"$GENIE_COMPUTER_TEAM_ID\"" \
    "$OUT/genie-computer-background"
fi
if [[ "$APP_BUNDLE" == "1" ]]; then
  # Keep the same code identity while giving native consent dialogs a real bundle
  # URL/name. The host still invokes this embedded executable through stdin/stdout.
  APP="$OUT/Genie Computer.app"
  mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
  cp "$OUT/genie-computer-background" "$APP/Contents/MacOS/genie-computer-background"
  cp "$ROOT/apps/genie-macos/Resources/AppIcon.icns" "$APP/Contents/Resources/AppIcon.icns"
  cat > "$APP/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleIdentifier</key><string>com.astra.computer.registration</string>
  <key>CFBundleExecutable</key><string>genie-computer-background</string>
  <key>CFBundleName</key><string>Genie Computer</string>
  <key>CFBundleDisplayName</key><string>Genie Computer</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>CFBundleShortVersionString</key><string>0.1.0</string>
  <key>LSMinimumSystemVersion</key><string>14.4</string>
  <key>LSUIElement</key><true/>
  <key>NSHighResolutionCapable</key><true/>
</dict></plist>
PLIST
  # This helper requests no microphone, camera, calendar, or automation scopes.
  # Its existing Screen Recording/Accessibility checks remain unchanged.
  printf 'APPL????' > "$APP/Contents/PkgInfo"
  plutil -lint "$APP/Contents/Info.plist"
  codesign --force --sign "$GENIE_COMPUTER_SIGN_IDENTITY" --identifier com.astra.computer.registration \
    --timestamp=none "$APP"
  for signed_path in "$APP" "$APP/Contents/MacOS/genie-computer-background"; do
    codesign --verify --strict --requirement "=identifier \"com.astra.computer.registration\" and anchor apple generic and certificate leaf[subject.OU] = \"$GENIE_COMPUTER_TEAM_ID\"" \
      "$signed_path"
  done
  printf '%s\n' "$APP/Contents/MacOS/genie-computer-background"
fi
