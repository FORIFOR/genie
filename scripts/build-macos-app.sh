#!/usr/bin/env bash
# genie-macos を配布可能な .app に包む。live mic/画面/グローバル操作の許可(TCC)は Info.plist の
# usage 文言が要る。ad-hoc 署名まで行う（正式配布は Developer ID 署名 + notarize が別途必要）。
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
source "$ROOT/scripts/build-resource-env.sh"
PKG="$ROOT/apps/genie-macos"
APP="$PKG/build/Genie.app"
# 版は package.json 1 か所から（release-macos.sh と同じ）。
VERSION="$(node -p "require('$ROOT/package.json').version")"

# A clean checkout has no Rust archive for Swift to link. Build it locally and
# give both compilers the declared minimum OS instead of the build host's OS.
export MACOSX_DEPLOYMENT_TARGET=14.0
if [[ -z "${ASTRA_CORE_LIB_DIR:-}" ]]; then
  command -v cargo >/dev/null || { echo "FAIL: Rust (cargo) is required; see docs/LOCAL_PREVIEW.md." >&2; exit 1; }
  cargo build --manifest-path "$ROOT/core/genie-core/Cargo.toml" --lib
  export ASTRA_CORE_LIB_DIR="$ROOT/core/genie-core/target/debug"
fi

cd "$PKG"
swift build -c release --jobs "$GENIE_SWIFT_BUILD_JOBS" >/dev/null
BIN="$(swift build -c release --jobs "$GENIE_SWIFT_BUILD_JOBS" --show-bin-path)/GenieMac"

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$BIN" "$APP/Contents/MacOS/Genie"
# SwiftPM's build-folder rpath is not portable. Ship the existing pinned runtime
# with the app, so another developer can launch it outside this checkout.
SPARKLE_FW="$PKG/Vendor/Sparkle/Sparkle.xcframework/macos-arm64_x86_64/Sparkle.framework"
if [[ ! -d "$SPARKLE_FW" ]]; then
  echo "FAIL: Sparkle runtime missing. Run bash scripts/fetch-sparkle.sh first." >&2
  exit 1
fi
mkdir -p "$APP/Contents/Frameworks"
cp -R "$SPARKLE_FW" "$APP/Contents/Frameworks/Sparkle.framework"
install_name_tool -add_rpath '@executable_path/../Frameworks' "$APP/Contents/MacOS/Genie"
mkdir -p "$APP/Contents/Resources/plugins"
cp -R "$ROOT/plugins/builtin" "$APP/Contents/Resources/plugins/builtin"
# Rust 静的ライブラリは実行ファイルに static link 済み（dylib 同梱不要）。
# Optional publisher configuration: public native-client parameters only, never user tokens.
if [[ -n "${ASTRA_CONNECTIONS_CONFIG:-}" ]]; then
  node "$ROOT/scripts/prepare-connection-config.mjs" "$ASTRA_CONNECTIONS_CONFIG" "$APP/Contents/Resources/connections.json"
fi
ICON_SRC="$ROOT/apps/genie-macos/Resources/AppIcon.icns"   # ランプの印（Resources/GenieMark-source.png から作った）
[[ -f "$ICON_SRC" ]] || { echo "FAIL: アイコン ($ICON_SRC) が無い" >&2; exit 1; }
cp "$ICON_SRC" "$APP/Contents/Resources/AppIcon.icns"

cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>Genie</string>
  <key>CFBundleDisplayName</key><string>Genie</string>
  <key>CFBundleIdentifier</key><string>com.astra.mac</string>
  <key>CFBundleExecutable</key><string>Genie</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>$VERSION</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>LSMinimumSystemVersion</key><string>14.0</string>
  <!-- overlay として Dock に出さない -->
  <key>LSUIElement</key><true/>
  <!-- 許可の説明文言（無いと TCC プロンプトが出ない） -->
  <key>NSMicrophoneUsageDescription</key><string>会議を録音し、手元で文字にするためにマイクを使います。</string>
  <key>NSLocationWhenInUseUsageDescription</key><string>「近くの店」を頼んだときだけ、現在地の近くの店を探すために使います。現在地はそのときだけGoogleマップの検索に送り、保存しません。</string>
  <key>NSAppleEventsUsageDescription</key><string>他アプリの文脈を読むために使います。</string>
  <key>NSCalendarsUsageDescription</key><string>会議の予定を取り込むために使います。</string>
  <key>NSCalendarsFullAccessUsageDescription</key><string>会議の予定を取り込むために使います。</string>
  <key>NSSpeechRecognitionUsageDescription</key><string>会議の音声を文字起こしします。設定で許可した場合は高精度化のためGoogle STTへ送信します。</string>
</dict>
</plist>
PLIST

# 署名。ad-hoc（"-"）だと TCC は実行ファイルの cdhash で許可を覚えるので、作り直すたびに
# マイク・音声認識・画面収録の許可が消える（本人がまた許可し直すことになる）。
# 手元に Apple Development の証明書があればそれで署名し、識別子と証明書で覚えてもらう。
# GENIE_SIGN_IDENTITY で指定でき、"-" なら従来の ad-hoc。証明書が無ければ ad-hoc。
IDENTITY="${GENIE_SIGN_IDENTITY:-}"
if [[ -z "$IDENTITY" ]]; then
  IDENTITY="$(security find-identity -v -p codesigning 2>/dev/null | sed -n 's/.*"\(Apple Development: [^"]*\)".*/\1/p' | head -1)"
fi
codesign --force --deep --sign "${IDENTITY:--}" --timestamp=none "$APP"
codesign --verify --deep --strict "$APP"
echo "built $APP"
codesign -dv "$APP" 2>&1 | grep -E "Identifier|Signature|^Authority" | head -3 || true
