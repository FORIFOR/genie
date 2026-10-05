#!/usr/bin/env bash
# Genie macOS を署名済み .app にする（Calendar 等の TCC を実機で検証するため）。
# TCC プロンプトは署名 .app を LaunchServices(open) 経由で起動したときだけ出る。
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
source "$ROOT/scripts/build-resource-env.sh"
IDENTITY="${ASTRA_SIGN_IDENTITY:-Apple Development}"   # security find-identity -v -p codesigning で確認
APP="$ROOT/apps/genie-macos/.build/Genie.app"
VERSION="$(node -e 'const v=JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")).version; if (!/^\d+\.\d+\.\d+$/.test(v)) throw Error("A numeric release version is required"); process.stdout.write(v)' "$ROOT/package.json")"
( cd "$ROOT/apps/genie-macos" && swift build -c release --jobs "$GENIE_SWIFT_BUILD_JOBS" )
rm -rf "$APP"; mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources/ja.lproj"
cp "$ROOT/apps/genie-macos/.build/release/GenieMac" "$APP/Contents/MacOS/GenieMac"
mkdir -p "$APP/Contents/Resources/plugins"
cp -R "$ROOT/plugins/builtin" "$APP/Contents/Resources/plugins/builtin"
if [[ -n "${ASTRA_CONNECTIONS_CONFIG:-}" ]]; then
  node "$ROOT/scripts/prepare-connection-config.mjs" "$ASTRA_CONNECTIONS_CONFIG" "$APP/Contents/Resources/connections.json"
fi
ICON_SRC="$ROOT/apps/genie-macos/Resources/AppIcon.icns"   # ランプの印（Resources/GenieMark-source.png から作った）
[[ -f "$ICON_SRC" ]] || { echo "FAIL: アイコン ($ICON_SRC) が無い" >&2; exit 1; }
cp "$ICON_SRC" "$APP/Contents/Resources/AppIcon.icns"
cp "$ROOT/shared/design/liquid-orb/LICENSE" "$APP/Contents/Resources/LiquidOrb-LICENSE.txt"
cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleExecutable</key><string>GenieMac</string>
  <key>CFBundleIdentifier</key><string>com.astra.desktop</string>
  <key>CFBundleName</key><string>Genie</string>
  <key>CFBundleDisplayName</key><string>Genie</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>${VERSION}</string>
  <key>CFBundleVersion</key><string>${VERSION}</string>
  <key>LSMinimumSystemVersion</key><string>14.0</string>
  <!-- 画面は日本語。Sparkle は**アプリの**言語に合わせて自分の窓を出すので、
       ja.lproj を持たないと更新の窓だけ英語になった（Atlas system.update-available）。 -->
  <key>CFBundleDevelopmentRegion</key><string>ja</string>
  <key>CFBundleLocalizations</key><array><string>ja</string></array>
  <key>NSCalendarsFullAccessUsageDescription</key><string>会議の予定を文脈として読むために、カレンダーを使います。読み取りは手元で行い、外部には送りません。</string>
  <!-- 用途説明が無い権限を要求すると、OS がプロセスを**落とす**
       （TCC crashing due to privacy violation）。実際に録音開始でそうなった。
       要求しうるものは全部ここに書く。 -->
  <key>NSMicrophoneUsageDescription</key><string>会議を録音し、文字起こしするためにマイクを使います。クラウド文字起こしを許可した場合は、録音音声をGoogleへ送信します。</string>
  <key>NSSpeechRecognitionUsageDescription</key><string>ライブ文字起こしをこのMac内で処理するために使います。別途クラウド文字起こしを許可した場合はGoogleへ録音音声を送信します。</string>
  <key>NSLocationWhenInUseUsageDescription</key><string>「近くの店」を頼んだときだけ、現在地の近くの店を探すために使います。現在地はそのときだけGoogleマップの検索に送り、保存しません。</string>
  <key>NSAppleEventsUsageDescription</key><string>前面アプリの文脈（開いている書類名など）を読むために使います。</string>
  <key>NSCameraUsageDescription</key><string>使いません。</string>
  <key>NSCalendarsUsageDescription</key><string>会議の予定を文脈として読むために、カレンダーを使います。</string>
  <!-- 自動更新（Sparkle）。release-macos.sh と同じ鍵と配布先。これが無いと SoftwareUpdate は起動せず、
       UI Atlas の system.update-available / up-to-date（sysshots）を撮れない。
       検証用の .app なので、起動時の自動チェックは切る（hands-on gate の途中で更新の窓を出さない）。 -->
  <key>SUFeedURL</key><string>${ASTRA_UPDATE_FEED:-https://github.com/FORIFOR/genie/releases/latest/download/appcast.xml}</string>
  <key>SUPublicEDKey</key><string>${ASTRA_UPDATE_PUBKEY:-b61dWnFNEdpzAWG/V5SMb4bZGrqgzJwMDAcuw/564cs=}</string>
  <key>SUEnableAutomaticChecks</key><false/>
</dict></plist>
PLIST
# ja.lproj に実体を置く（中身の無い lproj は localization として数えられない）。Sparkle は
# メインバンドルの言語に合わせて自分の窓を出す。
printf 'CFBundleName = "Genie";\n' > "$APP/Contents/Resources/ja.lproj/InfoPlist.strings"
# Sparkle を同梱する。**入れないと起動できない**（実行体が @rpath/Sparkle.framework を要求し、
# dyld が "Library not loaded" で落とす）。Sparkle を入れた後もこの台本は更新されておらず、
# ここで作った .app は起動即クラッシュしていた —— TCC を要る検証が全部できない状態だった。
SPARKLE_FW="$(find "$ROOT/apps/genie-macos/Vendor/Sparkle/Sparkle.xcframework" \
  -type d -name "Sparkle.framework" -path "*macos*" 2>/dev/null | head -1)"
if [[ -n "$SPARKLE_FW" ]]; then
  mkdir -p "$APP/Contents/Frameworks"
  rm -rf "$APP/Contents/Frameworks/Sparkle.framework"
  cp -R "$SPARKLE_FW" "$APP/Contents/Frameworks/Sparkle.framework"
  install_name_tool -add_rpath "@executable_path/../Frameworks" \
    "$APP/Contents/MacOS/GenieMac" 2>/dev/null || true
else
  echo "FAIL: Sparkle.framework が見つからない（scripts/fetch-sparkle.sh を先に）" >&2; exit 1
fi

# 内側から署名する（入れ子を後から署名すると外側が壊れる）。release-macos.sh と同じ順。
while IFS= read -r nested; do
  codesign --force --sign "$IDENTITY" "$nested"
done < <(find "$APP/Contents/Frameworks/Sparkle.framework" \
  \( -name "*.xpc" -o -name "Autoupdate" -o -name "Updater.app" \) 2>/dev/null)
codesign --force --sign "$IDENTITY" "$APP/Contents/Frameworks/Sparkle.framework"
codesign --force --sign "$IDENTITY" --identifier com.astra.desktop "$APP"
codesign --verify --strict --verbose=2 "$APP"
codesign -dv --verbose=2 "$APP" 2>&1 | grep -iE "Identifier=|TeamIdentifier=|Authority=Apple Dev" | head -3
# 起動できることをここで確かめる。落ちる .app を渡すと、TCC の検証が全部そこで止まる。
"$APP/Contents/MacOS/GenieMac" --selftest facts >/dev/null 2>&1 \
  && echo "launch: OK（実行体は起動する）" \
  || { echo "FAIL: パッケージした .app が起動しない" >&2; exit 1; }
echo "packaged: $APP"
echo "実 Calendar 検証: open \"$APP\" --args --selftest calendarlive  → プロンプトで許可 → 結果は /tmp/astra-calendarlive.txt"
