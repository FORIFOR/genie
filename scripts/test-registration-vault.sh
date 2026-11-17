#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/.build/computer"
mkdir -p "$OUT"
swiftc -D GENIE_REGISTRATION_TEST -parse-as-library \
  "$ROOT/tools/computer-use/RegistrationVault.swift" \
  "$ROOT/tools/computer-use/RegistrationVaultTests.swift" \
  -o "$OUT/registration-vault-tests"
"$OUT/registration-vault-tests"
# Exercise the actual self-signature path too, with no certificate and no Keychain write.
printf 'enum RegistrationBuildSigning { static let expectedTeam = "ABCDE12345" }\n' > "$OUT/RegistrationTestSigning.swift"
swiftc -D GENIE_REGISTRATION_TEST -D GENIE_REGISTRATION_SIGNED -parse-as-library \
  "$ROOT/tools/computer-use/RegistrationVault.swift" \
  "$ROOT/tools/computer-use/RegistrationVaultTests.swift" \
  "$OUT/RegistrationTestSigning.swift" \
  -o "$OUT/registration-vault-unsigned-refusal-tests"
"$OUT/registration-vault-unsigned-refusal-tests"
