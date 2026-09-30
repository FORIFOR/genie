#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
swiftc "$root/apps/genie-macos/Sources/GenieMac/Integrations/OathraGatewayClient.swift" \
  "$root/scripts/oathra-client-selftest.swift" -o "$work/oathra-client-check"
"$work/oathra-client-check"
