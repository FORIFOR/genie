#!/usr/bin/env bash
# 反復試験のためだけのビルド。**出荷しない。**
#
# 違いは 1 つだけ——保存先に置いた `unattended-test-target` が指す窓を対象として、
# 同意ダイアログを出さずに許可を作る。省くのは「人が対象を選ぶ操作」だけで、
# 窓の同一性・実行世代・期限・見張り・伏せ字の拒否・承認の検査は本番と同じ経路を通る。
#
# 名前も出力先も本番と分けてある。`--status` は unattendedTest:true を返すので、
# どちらの実行ファイルで取った結果かを後から必ず見分けられる。
# この実行ファイルで取った結果は「同意 UI を通っていない」ものとして記録すること。
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/.build/computer-unattended-test"
mkdir -p "$OUT"
SPI_FLAG="-D GENIE_PRIVATE_SPI"
if [[ "${GENIE_NO_PRIVATE_SPI:-0}" == "1" ]]; then SPI_FLAG=""; fi
# shellcheck disable=SC2086
swiftc -D GENIE_BACKGROUND -D GENIE_UNATTENDED_TEST $SPI_FLAG -parse-as-library -O \
  "$ROOT/tools/computer-use/genie-computer.swift" "$ROOT/tools/computer-use/GeneratedPointerMetrics.swift" \
  "$ROOT/tools/computer-use/PrivateSPIBridge.swift" \
  "$ROOT/tools/computer-use/BackgroundNativeInput.swift" \
  "$ROOT/tools/computer-use/BackgroundTextEdit.swift" \
  "$ROOT/tools/computer-use/BackgroundScroll.swift" \
  "$ROOT/tools/computer-use/BackgroundWebLink.swift" \
  "$ROOT/tools/computer-use/TargetPreview.swift" \
  "$ROOT/tools/computer-use/BackgroundAX.swift" \
  -o "$OUT/genie-computer-unattended-test"
"$OUT/genie-computer-unattended-test" --status | grep -q '"unattendedTest":true' \
  || { echo "試験用ビルドの印が出ていない" >&2; exit 1; }
echo "$OUT/genie-computer-unattended-test"
