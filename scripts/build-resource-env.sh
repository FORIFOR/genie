#!/usr/bin/env bash
# Build scheduling only. Never change optimization, model choice, or inference settings.
export GENIE_SWIFT_BUILD_JOBS="${GENIE_SWIFT_BUILD_JOBS:-2}"
export CARGO_BUILD_JOBS="${CARGO_BUILD_JOBS:-2}"
for resource_key in GENIE_SWIFT_BUILD_JOBS CARGO_BUILD_JOBS; do
  if [[ ! "${!resource_key}" =~ ^[1-9][0-9]*$ ]]; then
    echo "FAIL: $resource_key must be a positive integer" >&2
    return 1 2>/dev/null || exit 1
  fi
done
unset resource_key
