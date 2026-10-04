#!/usr/bin/env bash
# 「ジーニー」呼びかけ検出（端末の中だけで動く）の実行部品を取ってくる。
#
# - ONNX Runtime の C ライブラリ（xcframework）: SwiftPM の binary artifact 取得はこの環境で固まるので
#   Sparkle と同じく curl で取り、onnxruntime-swift-package-manager の Package.swift と同じ checksum で照合する
# - ONNX Runtime の Objective-C binding と livekit-wakeword の Swift 検出器: 固定したコミットのソースを置く
#   （どちらも Apache-2.0。LICENSE も一緒に置く）
#
# 置き場所は apps/genie-macos/Vendor/（git には入れない）。Package.swift はここを指す。
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST="$ROOT/apps/genie-macos/Vendor"
ORT_VERSION="1.24.2"
ORT_CHECKSUM="f7100a992d2a8135168c8afd831e6a58b465349101982aa58b3e11d36e600b54"
ORT_SPM_COMMIT="b7fb7f7dea8a2469e6335d95a61b8f36d0dc83b2"
LIVEKIT_COMMIT="fb92cb3641fedceb0bd8442409e14d1224f7fc97"

if [[ -d "$DEST/onnxruntime/onnxruntime.xcframework" && -d "$DEST/OnnxRuntimeBindings" && -d "$DEST/LiveKitWakeWord" && "${1:-}" != "--force" ]]; then
  echo "wakeword runtime: 取得済み ($DEST)"; exit 0
fi
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT

echo "onnxruntime: $ORT_VERSION を取得"
curl -fsSL -o "$TMP/ort.zip" "https://download.onnxruntime.ai/pod-archive-onnxruntime-c-${ORT_VERSION}.zip"
GOT="$(shasum -a 256 "$TMP/ort.zip" | awk '{print $1}')"
if [[ "$GOT" != "$ORT_CHECKSUM" ]]; then
  echo "FAIL: onnxruntime の checksum が違う（期待 $ORT_CHECKSUM / 実際 $GOT）" >&2; exit 1
fi
unzip -q "$TMP/ort.zip" -d "$TMP/ort"
rm -rf "$DEST/onnxruntime"; mkdir -p "$DEST/onnxruntime"
cp -R "$TMP/ort/onnxruntime.xcframework" "$DEST/onnxruntime/"
[[ -f "$TMP/ort/LICENSE" ]] && cp "$TMP/ort/LICENSE" "$DEST/onnxruntime/LICENSE"

fetch_commit() { # repo commit dir
  git -C "$TMP" init -q "$3"
  git -C "$TMP/$3" fetch -q --depth 1 "https://github.com/$1.git" "$2"
  git -C "$TMP/$3" checkout -q FETCH_HEAD
  [[ "$(git -C "$TMP/$3" rev-parse HEAD)" == "$2" ]] || { echo "FAIL: $1 のコミットが違う" >&2; exit 1; }
}
echo "onnxruntime objc binding: $ORT_SPM_COMMIT"
fetch_commit microsoft/onnxruntime-swift-package-manager "$ORT_SPM_COMMIT" ortspm
rm -rf "$DEST/OnnxRuntimeBindings"; mkdir -p "$DEST/OnnxRuntimeBindings"
( cd "$TMP/ortspm/objectivec" && tar cf - --exclude test --exclude docs --exclude ReadMe.md --exclude format_objc.sh \
    --exclude 'ort_checkpoint*' --exclude 'ort_training_session*' --exclude include/onnxruntime_training.h . ) \
  | ( cd "$DEST/OnnxRuntimeBindings" && tar xf - )
cp "$TMP/ortspm/LICENSE" "$DEST/OnnxRuntimeBindings/LICENSE"

echo "livekit-wakeword: $LIVEKIT_COMMIT"
fetch_commit livekit/livekit-wakeword "$LIVEKIT_COMMIT" livekit
rm -rf "$DEST/LiveKitWakeWord"
cp -R "$TMP/livekit/swift/Sources/LiveKitWakeWord" "$DEST/LiveKitWakeWord"
cp "$TMP/livekit/LICENSE" "$DEST/LiveKitWakeWord/LICENSE"
# 前処理モデル（mel・embedding）は SwiftPM の resource bundle にしない。Bundle.module は bundle が見つからないと
# アプリごと落ちる。.app の Contents/Resources（build-macos-app.sh が置く）と、開発中はこの Vendor の場所から読む。
cat > "$DEST/LiveKitWakeWord/Internal/ResourceLoader.swift" <<'SWIFT'
import Foundation

// Genie: Bundle.module を使わない版（scripts/fetch-wakeword-runtime.sh が置き換える）。
enum ResourceLoader {
    static func resourceURL(name: String, extension ext: String) throws -> URL {
        if let url = Bundle.main.url(forResource: name, withExtension: ext) { return url }
        let vendored = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("Resources/\(name).\(ext)")
        if FileManager.default.fileExists(atPath: vendored.path) { return vendored }
        throw WakeWordError.bundledResourceMissing(name: "\(name).\(ext)")
    }
}
SWIFT
# 推論の糸（thread）を 1 本にし、空き時間の spin を止める。既定では待機中も worker が回り続け、
# 声のある間 CPU 25〜65% を使っていた（推論そのものは 1 回 9 ms。2026-10-05 sample で確認）。
python3 - "$DEST/LiveKitWakeWord/Internal/ORTRuntime.swift" <<'PY'
import sys
p = sys.argv[1]; s = open(p).read()
old = """            throw WakeWordError.runtimeFailure(underlying: error)
        }

        switch provider {"""
new = """            throw WakeWordError.runtimeFailure(underlying: error)
        }
        // Genie: 1 本の糸で、待つ間は回らない（scripts/fetch-wakeword-runtime.sh が足す）。
        do {
            try options.setIntraOpNumThreads(1)
            try options.addConfigEntry(withKey: "session.intra_op.allow_spinning", value: "0")
            try options.addConfigEntry(withKey: "session.inter_op.allow_spinning", value: "0")
        } catch {
            throw WakeWordError.runtimeFailure(underlying: error)
        }

        switch provider {"""
assert s.count(old) == 1, "ORTRuntime.swift changed upstream"
open(p, "w").write(s.replace(old, new))
PY
echo "wakeword runtime: $DEST に置いた"
