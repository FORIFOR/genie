#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/.build/computer"
mkdir -p "$OUT"
swiftc -parse-as-library -O "$ROOT/tools/computer-use/genie-computer.swift" "$ROOT/tools/computer-use/GeneratedPointerMetrics.swift" -o "$OUT/genie-computer"
"$OUT/genie-computer" --self-test
# 背景経路。非公開 SPI は PrivateSPIBridge.swift だけに閉じ込めてある。
# GENIE_NO_PRIVATE_SPI=1 で外したビルドを作れる（公開 API のみを求める審査条件向け）。
# 外した場合、AX で表せる操作は動き、座標クリックとキーは経路なしとして拒否される。
SPI_FLAG="-D GENIE_PRIVATE_SPI"
if [[ "${GENIE_NO_PRIVATE_SPI:-0}" == "1" ]]; then SPI_FLAG=""; fi
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
  -o "$OUT/genie-computer-background"
