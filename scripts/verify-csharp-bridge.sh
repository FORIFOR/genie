#!/usr/bin/env bash
# Windows の C# CoreBridge（apps/windows/Genie/CoreBridge/GenieCore.cs）を P/Invoke で実 core に繋ぎ、
# 正しい結果が返ることを検証する。WinUI に依存しないので、dotnet があれば Windows 実機なしで走る。
# WinUI の UI レイヤ（Windows App SDK）は Windows CI でのみビルドできる（ここでは対象外）。
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
source "$ROOT/scripts/build-resource-env.sh"
if ! command -v dotnet >/dev/null 2>&1; then
  echo "SKIP: dotnet not available"; exit 0
fi
# 実 core の共有ライブラリを用意（cdylib）。
( cd "$ROOT/core/genie-core" && cargo build --quiet )
PROJ="$ROOT/apps/windows/bridge-check"
dotnet build "$PROJ" -v q -o "$PROJ/bin/out" >/dev/null
# DllImport("genie_core") が見つけられるよう、共有ライブラリを出力先へ置く。
# 注意: Rust の cdylib は macOS=libgenie_core.dylib / Linux=libgenie_core.so だが
# **Windows は lib 接頭辞なしの genie_core.dll**。両系統の名前を探す。
TARGET="$ROOT/core/genie-core/target/debug"
for f in libgenie_core.dylib libgenie_core.so libgenie_core.dll genie_core.dll; do
  [[ -f "$TARGET/$f" ]] && cp "$TARGET/$f" "$PROJ/bin/out/"
done
# P/Invoke("genie_core") が探す名前を確実に用意する。
if [[ ! -f "$PROJ/bin/out/genie_core.dll" && -f "$PROJ/bin/out/libgenie_core.dll" ]]; then
  cp "$PROJ/bin/out/libgenie_core.dll" "$PROJ/bin/out/genie_core.dll"
fi
OUT="$(cd "$PROJ/bin/out" && dotnet bridge-check.dll)"
echo "$OUT"
# 必須は core への P/Invoke（version/PKCE/authorizeUrl/parseCallback/elapsed/geometry）。
# 実 gateway 往復は gateway があるときだけ（macOS ローカル）で、無い CI では CS_SKIP になる。
# よって「core bridge の CS_OK があり、CS_FAIL が無い」ことを成功条件にする（先頭行位置に依存しない）。
[[ "$OUT" == *"CS_OK bridge->core:"* && "$OUT" != *CS_FAIL* ]] || { echo "FAIL: C# bridge -> core" >&2; exit 1; }
