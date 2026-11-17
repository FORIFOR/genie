#!/usr/bin/env bash
# §1 配布物を作る: Developer ID 署名 + hardened runtime + DMG（+ 資格情報があれば notarize/staple）。
#
# 秘密情報はこのスクリプトに書かない。notarization は keychain profile を使い、
# 無ければ **notarize せずに終える**（していないものを「した」ことにしない）。
#
#   scripts/build-dmg.sh
#   ASTRA_NOTARY_PROFILE=astra scripts/build-dmg.sh   # 資格情報がある場合
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PKG="$ROOT/apps/genie-macos"
APP="$PKG/build/Genie.app"
DIST="$ROOT/apps/genie-macos/dist"
VERSION="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$APP/Contents/Info.plist" 2>/dev/null || echo 0.1.0)"
DMG="$DIST/Genie-$VERSION.dmg"

# Developer ID は「配布用」の証明書。Apple Development では Gatekeeper を通らない。
IDENTITY="${ASTRA_DEVELOPER_ID:-$(security find-identity -v -p codesigning \
  | sed -n 's/.*"\(Developer ID Application: [^"]*\)".*/\1/p' | head -1)}"
if [[ -z "$IDENTITY" ]]; then
  echo "FAIL: Developer ID Application 証明書が無い（§1 の配布要件）" >&2
  exit 1
fi

echo "== build =="
bash "$ROOT/scripts/build-macos-app.sh" >/dev/null

# hardened runtime。マイク/画面/AX と、手元 STT のために必要な例外だけ入れる。
ENT="$(mktemp -t astra-entitlements).plist"
cat > "$ENT" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>com.apple.security.device.audio-input</key><true/>
  <key>com.apple.security.automation.apple-events</key><true/>
  <key>com.apple.security.personal-information.location</key><true/>
</dict></plist>
PLIST

echo "== sign: $IDENTITY =="
codesign --force --options runtime --timestamp \
  --entitlements "$ENT" --sign "$IDENTITY" "$APP"
codesign --verify --strict --verbose=2 "$APP" 2>&1 | tail -2
# notarize に出せる形になっているかを、出す前に確かめる（弾かれてから気づかない）。
DESC="$(codesign -dv --verbose=4 "$APP" 2>&1)"
grep -q "flags=.*runtime" <<<"$DESC" || { echo "FAIL: hardened runtime が付いていない" >&2; exit 1; }
grep -q "Authority=Developer ID Application" <<<"$DESC" || { echo "FAIL: Developer ID で署名されていない" >&2; exit 1; }
codesign -d --entitlements - "$APP" 2>&1 | grep -q "device.audio-input" \
  || { echo "FAIL: マイクの entitlement が無い" >&2; exit 1; }

echo "== dmg =="
mkdir -p "$DIST"
rm -f "$DMG"
STAGE="$(mktemp -d)"
cp -R "$APP" "$STAGE/"
ln -s /Applications "$STAGE/Applications"
hdiutil create -volname "Genie" -srcfolder "$STAGE" -ov -format UDZO "$DMG" >/dev/null
rm -rf "$STAGE"
codesign --force --sign "$IDENTITY" --timestamp "$DMG"
echo "built $DMG"

PROFILE="${ASTRA_NOTARY_PROFILE:-}"
if [[ -z "$PROFILE" ]]; then
  echo "SKIP notarize: ASTRA_NOTARY_PROFILE が未設定（notarytool store-credentials で作る）"
  echo "NOTARIZED=no"
  exit 0
fi
echo "== notarize =="
xcrun notarytool submit "$DMG" --keychain-profile "$PROFILE" --wait
xcrun stapler staple "$DMG"
xcrun stapler validate "$DMG"
echo "NOTARIZED=yes"
