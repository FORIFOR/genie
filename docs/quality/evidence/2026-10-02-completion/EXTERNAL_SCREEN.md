# External computer-use screen boundary and actual helper status

2026-10-02 JST. Implementation owner: `/root/pointer_ui`. This record covers launcher source and local regression, not a live external-screen run.

## Finding and correction

The prior `modelEnvironment(codex)` unconditionally enabled `ASTRA_COMPUTER_VISION_EXTERNAL=on` after conversation `--allow-cloud`. The problem was an overly broad opt-in, not a missing external-model route. Existing evidence of that former environment remains historical.

Current configuration requires a separate `--allow-external-screen` with `--computer-use` and an explicitly selected Codex connection. Its saved `externalScreenAuthorization` contains only exact `provider` and `model`, within the already private state directory's `runtime.json`. The same choice can be reused after restart. A provider/model switch invalidates it; switching away and back cannot restore it. `--no-external-screen` explicitly clears it while preserving the conversation provider choice. Legacy `allowCloud` alone and inherited ambient environment variables cannot enable it. Without an active `--computer-use` launch, the host receives `ASTRA_COMPUTER_VISION_EXTERNAL=off` even if the matching screen choice is saved.

This is an egress setup choice. It grants no target window, task approval, input action, OS permission or paid-tier change. The production helper still supplies per-run target/recipient consent, and model failures still do not fall back to another provider. Conversation and user-attached-image routing retain their existing explicit cloud selection.

## Status contract

Authenticated `GET /computer/status` on the loopback supervisor probes its exact resolved helper executable with only `--status` on every request. It accepts no path parameter, invokes no shell, captures no screen and sends no input. The subprocess has an 8-second timeout and 64 KiB output bound. The response includes `project`, `phase`, `computerUse`, `computerDelivery`, `model`, `modelProvider`, `recipient`, effective `externalScreenAllowed`, saved exact scope, and `computerHelper: {path,status,error}`. `computerHelperUnattendedTest` comes from the current probe. `probedAt` identifies that observation.

Only typed readiness/permission/support/test-mode booleans, delivery mode and bounded capability names are exposed. Unexpected fields and subprocess stderr are excluded. Missing, malformed or failed probes remain unavailable; they are not silently converted to a normal production helper or a ready state. Startup status alone is not current permission evidence. The separate CLI consumes this endpoint and displays the path; it does not execute an HTTP-returned path.

## Verification

[Managed launcher regressions](external-screen-launcher-tests.log): **38 passed, 0 failed, 0 skipped, exit 0**. [Source hashes and scope](external-screen-launcher.json).

New cases verify the separate opt-in, exact model/provider binding, actual saved-config reload, state-directory isolation, revoke/restart behavior, malformed saved scope rejection, and exclusion of ambient `ASTRA_COMPUTER_VISION_EXTERNAL`. A harmless owned Node executable reads a synthetic status JSON file; changing permissions between calls proves that the same selected path is probed again, not served from startup cache. Invalid output and thrown subprocess errors remain unavailable without leaking stdout/stderr. Existing launcher lifecycle/model/environment regressions also pass. Formatting and `git diff --check` pass.

These tests do not exercise real native target consent, screenshot-model inference, public websites, or transaction submission. Root owns any subsequent explicitly authorized public-page E2E and full-product gate. The local budget policy name `free` does not establish that a Codex account/subscription costs nothing or that the provider will not consume its allowance.
