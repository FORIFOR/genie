#!/usr/bin/env bash
# Genie macOS を**配布できる形**にする。
#
# `package-macos-app.sh` との違い:
#   あちらは Apple Development 署名で、実機の TCC を出すための開発用。
#   自分の Mac でしか動かない（他人の Mac では Gatekeeper に止められる）。
#   こちらは Developer ID + hardened runtime + notarization で、配る用。
#
# 版番号は package.json 1 か所から取る。plist に直に書くと、必ずどこかとずれる。
#
# Sparkle の公開鍵は既定でこの Mac の keychain にある鍵のもの。**公開鍵なので
# 秘密ではない**（アプリに埋めて配るもの）。対の秘密鍵は keychain にあり、
# 失うと以後の更新に署名できない —— 別の鍵に変えると、古い版のアプリは
# 新しい更新を検証できなくなる。
#
# 必要なもの:
#   - "Developer ID Application" の証明書（security find-identity -v -p codesigning）
#   - notarization の資格情報。あらかじめ keychain profile にしておく:
#       xcrun notarytool store-credentials "astra-notary" \
#         --apple-id <Apple ID> --team-id <TeamID> --password <app 用パスワード>
#     プロファイル名は ASTRA_NOTARY_PROFILE で変えられる（既定 astra-notary）。
#
# 資格情報が無いときは **notarization の手前で止まる**。署名だけ済んだ .app を
# 「配布できる」と言わない（他人の Mac では開けないので）。
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# A candidate can be built without replacing the app the user is running.
OUT="${ASTRA_RELEASE_OUTPUT_DIR:-$ROOT/dist}"
APP="$OUT/Genie.app"
NOTARY_PROFILE="${ASTRA_NOTARY_PROFILE:-astra-notary}"
NOTARY_BACKEND="${ASTRA_NOTARIZATION_BACKEND:-notarytool}"
[[ "$NOTARY_BACKEND" == notarytool || "$NOTARY_BACKEND" == xcode ]] || {
  echo "FAIL: unknown ASTRA_NOTARIZATION_BACKEND: $NOTARY_BACKEND" >&2; exit 1; }
SOURCE_SNAPSHOT="$(python3 "$ROOT/scripts/release-provenance.py" snapshot "$ROOT")"

VERSION="$(node -p "require('$ROOT/package.json').version")"
[[ -n "$VERSION" ]] || { echo "FAIL: package.json から版番号を取れない" >&2; exit 1; }

# 署名 identity。Developer ID が無ければここで止める（開発署名で配らない）。
IDENTITY="${ASTRA_SIGN_IDENTITY:-}"
if [[ -z "$IDENTITY" ]]; then
  IDENTITY="$(security find-identity -v -p codesigning 2>/dev/null \
    | awk -F'"' '/"Developer ID Application/ { if (!seen++) print $2 }')"
fi
if [[ -z "$IDENTITY" ]]; then
  echo "FAIL: Developer ID Application の証明書が無い。開発署名では配布できない。" >&2
  exit 1
fi

echo "== build (release) =="
# **両アーキで作る。** arm64 だけで配ると Intel Mac では動かない
# （appcast にも hardwareRequirements=arm64 が入り、対象外として扱われる）。
# 不特定多数へ配るなら、どちらでも動く形にする。
# panic の位置文字列にはビルドした人の絶対パスがそのまま入る（実測 175 箇所）。
# 不特定多数へ配るものに開発者のユーザー名を載せない。開発ビルドはそのままにして、
# 配布ビルドだけ畳む。
for target in aarch64-apple-darwin x86_64-apple-darwin; do
  ( cd "$ROOT/core/genie-core" \
    && MACOSX_DEPLOYMENT_TARGET=14.0 \
       RUSTFLAGS="--remap-path-prefix=$HOME/.cargo=/cargo --remap-path-prefix=$ROOT=/astra ${RUSTFLAGS:-}" \
       cargo build --release --quiet --target "$target" )
done
export ASTRA_CORE_LIB_DIR="$ROOT/core/genie-core/target/universal-release"
mkdir -p "$ASTRA_CORE_LIB_DIR"
lipo -create \
  "$ROOT/core/genie-core/target/aarch64-apple-darwin/release/libgenie_core.a" \
  "$ROOT/core/genie-core/target/x86_64-apple-darwin/release/libgenie_core.a" \
  -output "$ASTRA_CORE_LIB_DIR/libgenie_core.a"
[[ -f "$ASTRA_CORE_LIB_DIR/libgenie_core.a" ]] || {
  echo "FAIL: release の libgenie_core.a が無い" >&2; exit 1; }
bash "$ROOT/scripts/fetch-sparkle.sh"
( cd "$ROOT/apps/genie-macos" && swift build -c release --arch arm64 --arch x86_64 )

# 実行時に外の dylib を掴んでいないこと。掴んでいたら、その絶対パスが無い
# 他人の Mac では起動しない（一度そうなっていた）。
BIN_DIR="$(cd "$ROOT/apps/genie-macos" && swift build -c release --arch arm64 --arch x86_64 --show-bin-path)"
BIN="$BIN_DIR/GenieMac"
[[ -x "$BIN" ]] || { echo "FAIL: 今回のuniversal実行体が無い: $BIN" >&2; exit 1; }
if otool -L "$BIN" | grep -q "genie_core.*dylib"; then
  echo "FAIL: genie_core を dylib で掴んでいる（静的リンクになっていない）" >&2
  otool -L "$BIN" | grep genie_core >&2
  exit 1
fi

echo "== bundle =="
rm -rf "$APP"; mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources/ja.lproj"
cp "$BIN" "$APP/Contents/MacOS/GenieMac"

# 両アーキ入っているか。片方だけだと、その CPU の人は起動できない。
for a in arm64 x86_64; do
  lipo -info "$APP/Contents/MacOS/GenieMac" | grep -q "$a" || {
    echo "FAIL: $a が入っていない（universal になっていない）" >&2; exit 1; }
done
echo "arch: $(lipo -info "$APP/Contents/MacOS/GenieMac" | sed 's/.*are: //')"

# 記号を落とす。**署名より前に**やること（後でやると署名が壊れる）。
# 依存の C ソース（ring 等）の絶対パスは rustc の --remap-path-prefix では
# 畳めない（cc が埋めるため）ので、ここで消す。配るものに開発者の
# ユーザー名を載せない。
strip -x "$APP/Contents/MacOS/GenieMac"
# 残った分は panic の位置文字列（__TEXT のリテラル）。記号ではないので strip では
# 消えず、依存の C ソース由来は rustc の --remap-path-prefix でも畳めない。
# **体裁の話で、機能でも安全性でもない**ので、ここでは止めずに数だけ報告する。
LEAK="$(strings "$APP/Contents/MacOS/GenieMac" 2>/dev/null | grep -c "$HOME" || true)"
if [[ "${LEAK:-0}" -eq 0 ]]; then
  echo "strip: 記号を落とした（個人パス 0 件）"
else
  echo "strip: 記号を落とした（panic の位置文字列に個人パスが $LEAK 件残る・体裁のみ）"
fi

# 同梱プラグインをバンドルへ。入れ忘れると、配った先では 1 件も読めない
# （以前は開発機の絶対パスで拾えていたので、手元でだけ動いていた）。
mkdir -p "$APP/Contents/Resources/plugins"
cp -R "$ROOT/plugins/builtin" "$APP/Contents/Resources/plugins/builtin"
PLUGIN_COUNT="$(find "$APP/Contents/Resources/plugins/builtin" -name plugin.yaml | wc -l | tr -d ' ')"
[[ "$PLUGIN_COUNT" -gt 0 ]] || { echo "FAIL: 同梱プラグインが 0 件" >&2; exit 1; }
echo "plugins: $PLUGIN_COUNT 件を同梱"

# アイコン。無いと Finder でも Dock でも「開く」ダイアログでも空白になる
# —— 不特定多数へ配るなら、名前より先に目に入るのはここ。
# Optional publisher configuration: public native-client parameters only, never user tokens.
if [[ -n "${ASTRA_CONNECTIONS_CONFIG:-}" ]]; then
  node "$ROOT/scripts/prepare-connection-config.mjs" "$ASTRA_CONNECTIONS_CONFIG" "$APP/Contents/Resources/connections.json"
fi
ICON_SRC="$ROOT/apps/desktop/src-tauri/icons/icon.icns"
[[ -f "$ICON_SRC" ]] || { echo "FAIL: アイコン ($ICON_SRC) が無い" >&2; exit 1; }
cp "$ICON_SRC" "$APP/Contents/Resources/AppIcon.icns"
cp "$ROOT/shared/design/liquid-orb/LICENSE" "$APP/Contents/Resources/LiquidOrb-LICENSE.txt"
echo "icon: 同梱した"

# 用途説明は package-macos-app.sh と同じものを使う。片方だけ直すとずれるので、
# verify-usage-descriptions.sh が両方を突き合わせている。
cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleExecutable</key><string>GenieMac</string>
  <key>CFBundleIdentifier</key><string>com.astra.desktop</string>
  <key>CFBundleName</key><string>Genie</string>
  <key>CFBundleDisplayName</key><string>Genie</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>${VERSION}</string>
  <key>CFBundleVersion</key><string>${VERSION}</string>
  <key>LSMinimumSystemVersion</key><string>14.0</string>
  <!-- 画面は日本語。Sparkle は**アプリの**言語に合わせて自分の窓を出すので、
       ja.lproj を持たないと更新の窓だけ英語になった（Atlas system.update-available）。 -->
  <key>CFBundleDevelopmentRegion</key><string>ja</string>
  <key>CFBundleLocalizations</key><array><string>ja</string></array>
  <key>NSHighResolutionCapable</key><true/>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <!-- Dock アイコンは出さない（常駐の Task Dock が入口）。 -->
  <key>LSUIElement</key><true/>
  <key>LSApplicationCategoryType</key><string>public.app-category.productivity</string>
  <key>NSHumanReadableCopyright</key><string>© 2026 Shuhei Horio</string>
  <key>NSCalendarsFullAccessUsageDescription</key><string>会議の予定を文脈として読むために、カレンダーを使います。読み取りは手元で行い、外部には送りません。</string>
  <key>NSMicrophoneUsageDescription</key><string>会議を録音し、文字起こしするためにマイクを使います。クラウド文字起こしを許可した場合は、録音音声をGoogleへ送信します。</string>
  <key>NSSpeechRecognitionUsageDescription</key><string>会議の音声を文字起こしします。設定で許可した場合は高精度化のためGoogle STTへ送信します。</string>
  <key>NSLocationWhenInUseUsageDescription</key><string>「近くの店」を頼んだときだけ、現在地の近くの店を探すために使います。現在地はそのときだけGoogleマップの検索に送り、保存しません。</string>
  <key>NSAppleEventsUsageDescription</key><string>前面アプリの文脈（開いている書類名など）を読むために使います。</string>
  <key>NSCameraUsageDescription</key><string>使いません。</string>
  <key>NSCalendarsUsageDescription</key><string>会議の予定を文脈として読むために、カレンダーを使います。</string>
  <!-- 自動更新（Sparkle）。**どちらも空のままでは更新を確かめない。**
       配布先が決まったら appcast の URL を、generate_keys を回したら
       その公開鍵をここへ入れる。片方だけ入れても SoftwareUpdate は起動しない。 -->
  <key>SUFeedURL</key><string>${ASTRA_UPDATE_FEED:-}</string>
  <key>SUPublicEDKey</key><string>${ASTRA_UPDATE_PUBKEY:-b61dWnFNEdpzAWG/V5SMb4bZGrqgzJwMDAcuw/564cs=}</string>
  <key>SUEnableAutomaticChecks</key><true/>
  <!-- 黙って入れ替えない。落としてくるかは利用者が決める。 -->
  <key>SUAutomaticallyUpdate</key><false/>
</dict></plist>
PLIST
# ja.lproj に実体を置く（中身の無い lproj は localization として数えられない）。Sparkle は
# メインバンドルの言語に合わせて自分の窓を出す。
printf 'CFBundleName = "Genie";\n' > "$APP/Contents/Resources/ja.lproj/InfoPlist.strings"

# hardened runtime で要る権利だけ。付けすぎると審査で不利になるうえ、
# 「何ができるアプリか」の説明にもならない。
cat > "$OUT/genie.entitlements" <<'ENT'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>com.apple.security.device.audio-input</key><true/>
  <key>com.apple.security.automation.apple-events</key><true/>
  <key>com.apple.security.personal-information.location</key><true/>
</dict></plist>
ENT

# Sparkle を同梱する。framework が入っていないと、更新の口だけ在って動かない。
SPARKLE_FW="$(find "$ROOT/apps/genie-macos/Vendor/Sparkle/Sparkle.xcframework" \
  -type d -name "Sparkle.framework" -path "*macos*" 2>/dev/null | head -1)"
if [[ -n "$SPARKLE_FW" ]]; then
  mkdir -p "$APP/Contents/Frameworks"
  rm -rf "$APP/Contents/Frameworks/Sparkle.framework"
  cp -R "$SPARKLE_FW" "$APP/Contents/Frameworks/Sparkle.framework"
  # 実行体が @rpath で framework を見つけられるように。
  install_name_tool -add_rpath "@executable_path/../Frameworks" \
    "$APP/Contents/MacOS/GenieMac" 2>/dev/null || true
  echo "sparkle: 同梱した"
else
  echo "FAIL: Sparkle.framework が見つからない（scripts/fetch-sparkle.sh を先に）" >&2; exit 1
fi

if [[ "$NOTARY_BACKEND" == xcode ]]; then
  # Xcode uses its signed-in Apple account; no app-specific password is copied.
  TEAM="$(printf '%s' "$IDENTITY" | sed -n 's/.*(\([A-Z0-9]*\))$/\1/p')"
  [[ -n "$TEAM" ]] || { echo "FAIL: Xcode backend requires a named Developer ID identity" >&2; exit 1; }
  python3 "$ROOT/scripts/release-xcode-notarize.py" "$APP" "$OUT/genie.entitlements" "$TEAM"
  ZIP="$OUT/Genie-${VERSION}.zip"
  rm -f "$ZIP"
  /usr/bin/ditto -c -k --keepParent "$APP" "$ZIP"
  python3 "$ROOT/scripts/release-provenance.py" create "$ROOT" "$ZIP" "$SOURCE_SNAPSHOT"
  echo "RELEASE_READINESS=NOTARIZED"
  echo "artifact: $ZIP"
  exit 0
fi

echo "== sign (Developer ID + hardened runtime) =="
# **内側から署名する。** 入れ子の framework を後から署名すると、外側の署名が壊れる。
# Sparkle は中に XPC サービスと Autoupdate を持つので、それぞれ署名が要る。
while IFS= read -r nested; do
  codesign --force --timestamp --options runtime --sign "$IDENTITY" "$nested"
done < <(find "$APP/Contents/Frameworks/Sparkle.framework" \
  \( -name "*.xpc" -o -name "Autoupdate" -o -name "Updater.app" \) 2>/dev/null)
codesign --force --timestamp --options runtime --sign "$IDENTITY" \
  "$APP/Contents/Frameworks/Sparkle.framework"

codesign --force --timestamp --options runtime \
  --entitlements "$OUT/genie.entitlements" \
  --sign "$IDENTITY" --identifier com.astra.desktop "$APP"
codesign --verify --strict --deep --verbose=2 "$APP"
echo "signed: $(codesign -dv --verbose=2 "$APP" 2>&1 | grep -m1 Authority=)"

ZIP="$OUT/Genie-${VERSION}.zip"
rm -f "$ZIP"
/usr/bin/ditto -c -k --keepParent "$APP" "$ZIP"
echo "zip: $ZIP ($(du -h "$ZIP" | cut -f1))"

# ここから先は資格情報が要る。無いなら**配布できるとは言わない**。
if ! xcrun notarytool history --keychain-profile "$NOTARY_PROFILE" >/dev/null 2>&1; then
  cat >&2 <<EOF

BLOCKED: notarization の資格情報が無い（keychain profile "$NOTARY_PROFILE"）。
署名済みの .app と zip はできているが、**他人の Mac では Gatekeeper に止められる**。
資格情報を入れてから、このスクリプトをもう一度実行すること:

  xcrun notarytool store-credentials "$NOTARY_PROFILE" \\
    --apple-id <Apple ID> --team-id <TeamID> --password <app 用パスワード>

RELEASE_READINESS=SIGNED_NOT_NOTARIZED
EOF
  exit 3
fi

echo "== notarize =="
xcrun notarytool submit "$ZIP" --keychain-profile "$NOTARY_PROFILE" --wait
xcrun stapler staple "$APP"
xcrun stapler validate "$APP"

# 配った先で本当に開けるか。ここを通らないものは配らない。
spctl --assess --type execute --verbose=4 "$APP"

rm -f "$ZIP"
/usr/bin/ditto -c -k --keepParent "$APP" "$ZIP"
python3 "$ROOT/scripts/release-provenance.py" create "$ROOT" "$ZIP" "$SOURCE_SNAPSHOT"
echo "RELEASE_READINESS=NOTARIZED"
echo "artifact: $ZIP"
