#!/usr/bin/env bash
# Swift → UniFFI → Rust → Swift の実 round-trip。ライブラリがリンクできただけでは不可。
# 入力を Rust へ渡し、core で処理した構造化結果を Swift で受けて検証する。
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
source "$ROOT/scripts/build-resource-env.sh"
CORE="$ROOT/core/genie-core"
SWIFT="$ROOT/apps/genie-macos/Sources/GenieCore"
INC="$ROOT/apps/genie-macos/Sources/GenieCoreFFI/include"

cd "$CORE"; cargo build --quiet
LIBDIR="$CORE/target/debug"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT

VERSION="$(node -p "require('$ROOT/package.json').version")"
cat > "$TMP/main.swift" <<'SWIFT'
import Foundation
let EXPECT_VERSION = "__VERSION__"

// Rust (genie-core) を Swift から実際に呼ぶ。
let version = genieCoreVersion()
guard version == EXPECT_VERSION else { fatalError("version round-trip failed: \(version) (want \(EXPECT_VERSION))") }

// 構造化入力 → Rust で派生 → 構造化結果
let snap = recordingSnapshot(input: RecordingInput(
    elapsedMs: 261_000, isPaused: false, link: .reconnecting, pendingMs: 12_000))
guard snap.mode == .recording,
      snap.elapsedLabel == "04:21",
      snap.heroText == "録音中",
      snap.linkText == "オフライン保存中…",
      snap.pendingLabel == "未送信 約12秒",
      snap.unsynced
else { fatalError("snapshot round-trip failed: \(snap)") }

// 音声変換 (f32 → 16-bit LE) も Rust 側で
let wire = toWire(samples: [0.0, 1.0, -1.0])
guard wire.count == 6 else { fatalError("wire round-trip failed") }

// RAG/context の決定的ランキングも core 側で
let ranked = rankContext(
    query: ContextQuery(terms: ["oauth", "審査"], limit: 0),
    candidates: [
        ContextCandidate(id: "a", text: "天気の話", source: .web, ageSeconds: 0, projectMatch: false),
        ContextCandidate(id: "b", text: "OAuth 審査がまだ", source: .meeting, ageSeconds: 0, projectMatch: true),
    ])
guard ranked.first?.id == "b" else { fatalError("context ranking round-trip failed") }

print("ROUNDTRIP_OK version=\(version) elapsed=\(snap.elapsedLabel) hero=\(snap.heroText)")
SWIFT
sed -i '' "s/__VERSION__/$VERSION/" "$TMP/main.swift"

swiftc \
  "$SWIFT/genie_core.swift" "$TMP/main.swift" \
  -I "$INC" \
  -L "$LIBDIR" -lgenie_core \
  -o "$TMP/roundtrip"

OUT="$("$TMP/roundtrip")"
echo "$OUT"
[[ "$OUT" == ROUNDTRIP_OK* ]] || { echo "FAIL: round-trip assertion failed" >&2; exit 1; }
