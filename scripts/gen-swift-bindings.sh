#!/usr/bin/env bash
# genie-core の Swift bindings を生成する。生成物は手編集しない。
# 生成先: apps/genie-macos/Sources/GenieCoreFFI/{genie_core.swift, include/*}
#   --check: 既存が最新か（stale なら非0）。CI 用（gen-design-tokens と同じ作法）。
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CORE="$ROOT/core/genie-core"
SWIFT_DEST="$ROOT/apps/genie-macos/Sources/GenieCore"
HDR_DEST="$ROOT/apps/genie-macos/Sources/GenieCoreFFI/include"
CHECK="${1:-}"

cd "$CORE"
cargo build --quiet
LIB="$(find target/debug -maxdepth 1 -name 'libgenie_core.dylib' | head -1)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
cargo run --quiet --bin uniffi-bindgen -- generate --library "$LIB" --language swift --out-dir "$TMP" >/dev/null

# UniFFI emits whitespace-only lines in checksum prototypes. Normalize generated
# headers here so regeneration and git whitespace checks agree (never hand-edit outputs).
python3 - "$TMP/genie_coreFFI.h" <<'PY_HEADER'
import pathlib, sys
header = pathlib.Path(sys.argv[1])
header.write_text("\n".join(line.rstrip() for line in header.read_text().splitlines()) + "\n")
PY_HEADER

# SwiftPM の規約に合わせて配置: Swift は GenieCore、C ヘッダ+modulemap は GenieCoreFFI/include。
mkdir -p "$TMP/swift" "$TMP/inc"
cp "$TMP/genie_core.swift" "$TMP/swift/genie_core.swift"
cp "$TMP/genie_coreFFI.h" "$TMP/inc/genie_coreFFI.h"
cat > "$TMP/inc/module.modulemap" <<MAP
module genie_coreFFI {
    header "genie_coreFFI.h"
    export *
}
MAP

if [ "$CHECK" = "--check" ]; then
  stale=0
  diff -q "$TMP/swift/genie_core.swift" "$SWIFT_DEST/genie_core.swift" >/dev/null 2>&1 || stale=1
  diff -rq "$TMP/inc" "$HDR_DEST" >/dev/null 2>&1 || stale=1
  if [ "$stale" = "1" ]; then
    echo "FAIL: swift bindings are stale. Run: pnpm gen:swift-bindings" >&2
    exit 1
  fi
  echo "swift bindings are current"
else
  mkdir -p "$SWIFT_DEST" "$HDR_DEST"
  cp "$TMP/swift/genie_core.swift" "$SWIFT_DEST/genie_core.swift"
  rm -f "$HDR_DEST"/*.h "$HDR_DEST"/module.modulemap
  cp -R "$TMP/inc/." "$HDR_DEST/"
  echo "wrote $SWIFT_DEST and $HDR_DEST"
fi
