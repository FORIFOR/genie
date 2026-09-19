#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
mkdir -p "$ROOT/.build/execution"
swiftc -O "$ROOT/tools/execution/genie-field.swift" -o "$ROOT/.build/execution/genie-field"
printf '%s' '{"command":"selftest"}' | "$ROOT/.build/execution/genie-field"
