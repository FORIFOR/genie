#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/.build/computer"
mkdir -p "$OUT"
swiftc -parse-as-library -O "$ROOT/tools/computer-use/genie-computer.swift" -o "$OUT/genie-computer"
"$OUT/genie-computer" --self-test
