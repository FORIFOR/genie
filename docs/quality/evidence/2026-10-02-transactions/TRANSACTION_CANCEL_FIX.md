# Preserve a stopped task and its unconfirmed order

2026-10-02 JST. Implementation verification by `/root/computer_correctness`, on the uncommitted working tree. This is not independent review of the same author's backend changes. The earlier main-app **FAILED after Stop** observation remains in [FIXTURE_SESSION_EXIT.md](FIXTURE_SESSION_EXIT.md); these backend tests do not replace it with a native success claim.

The new `transaction-cancel-failure-v1` workflow patch passes transaction failures to cancellation-aware persistence. `failTask` locks the task row and retains an already accepted `CANCELLING` request even if its Temporal signal has not arrived. It commits `CANCELLED` with the original error and a quote-bound `transaction_result` lookup identity. A completed receipt is immutable. If no stop was accepted, the same unknown result remains `FAILED`. An accepted stop means Genie stopped, not that an external order was cancelled.

Explicit unknown host results are propagated only when their provider, mode, account, order key, and quote hash match the dispatched quote. They carry no invented provider receipt. `TaskError` and `TaskCancelledPayload` preserve this typed data for task GET, SSE, event replay, and audit. Older ordinary cancellation payloads containing only `reason` remain valid. Old unpatched workflow failures retain the two-argument activity command and tolerate the former void result.

Verification on the first cancellation-fix candidate (before the later fallback below):

- Service build and whole-workspace test typecheck passed.
- [Unit/schema/workflow and recorded-history replay](transaction-cancel-unit-replay-final.log): **48 passed, 1 skipped**. Both existing completed/cancelled history replays passed. The skip is explicit history fixture regeneration.
- [Isolated real PostgreSQL/RLS tests](transaction-cancel-db-final.log): **30 passed, 1 skipped**. Includes quote-bound failure propagation, stop signal present/absent, eight concurrent stop/failure races, task GET/event/audit evidence, unchanged completed receipts, bounded-authorization ledger, and authorization HTTP integration. The skip is an existing real-Temporal composition test requiring an unavailable cached executable. The dedicated port-32768 wrapper created and cleaned up its own database; preview data was not used.

The [initial database run](transaction-cancel-db.log) had **2 failures, 28 passes, 1 skip**: `TaskCancelledPayload` stripped the stored error and message from the public event envelope. The schema correction and the final passing run are both retained; no assertions were removed to hide that failure.

The new workflow failure branch was tested with activity mocks plus actual database arbitration. No new real-Temporal server cancellation history was generated or downloaded. No native input, screenshot, real order, live provider, or financial trade was involved in these tests. Main-app stop and restart display verification belongs to the separate UI/native candidate run.

Commands, source hashes, log hashes, and exact limitations are recorded in [transaction-cancel-fix.json](transaction-cancel-fix.json), with its [SHA-256](transaction-cancel-fix.json.sha256). Historical broader verification totals are not added to these overlapping suites.

## Later missing-result fallback candidate

Subsequent review identified an additional boundary: a timed-out/crashed worker or missing host result could leave the task stopped without the structured lookup identity. `transaction-unknown-fallback-v1` now carries the exact submit arguments actually scheduled after approval into finalization. Persistence recovers only from a durable matching host claim, matching approved-row input hash, and matching host proof/arguments. It excludes unclaimed work, missing approval/proof, changed arguments, and known pre-dispatch refusal results. This is conservative lookup information, not a receipt. No submit or provider lookup is performed during finalization.

Two workflow regressions and eight database cases were added for this candidate. At the initial handoff, they had not been executed or built/typechecked: the user reported memory pressure while streaming, so root stopped heavy verification. That initial, explicitly unverified snapshot is preserved in [transaction-cancel-fallback-candidate.json](transaction-cancel-fallback-candidate.json). The earlier passing logs and hashes are not relabeled as results for that update.

Separately, this agent independently read the revised Mac UI by `/root/pointer_ui`. The corrected code treats typed transaction terminal states without receipt evidence as unknown, rejects missing task metadata, preserves saved uncertainty through generic/empty results and read failures, disables request reuse, and permits read-only refresh. Optional Codable fields preserve older saved requests. Task GET and cancellation-event field shapes match the backend. No additional material issue was identified in that static pass. The new Swift regression cases were not executed here, and this is not native or visual verification.

## Root's subsequent serial verification

Root subsequently ran the following checks serially. This agent inspected and preserved their logs without rerunning any build, test, database, or GUI action:

- **TypeScript build and whole-workspace test compilation passed**, reported by root. [memory-candidate-types.log](memory-candidate-types.log) is empty because the commands emitted no diagnostics; the log alone does not attest to the exit code.
- [Workflow and recorded-history replay](transaction-stop-fallback-unit.log): **17 passed, 1 skipped**, at 02:27 JST. This comprises 15 transaction workflow tests and two existing Temporal history replays. The skipped case is explicit history fixture generation, not a failed replay.
- The [first fallback database run](transaction-stop-fallback-db.log), at 02:30 JST, had **7 passed and 7 failed**. All seven failures occurred while inserting the test host: eight scenarios reused `device_label: 'Timeout fixture'` under the same tenant/user, violating `agent_hosts_device (tenant_id, user_id, device_label)`. These setup failures did not exercise or demonstrate failures in production fallback behavior. The fixture now includes its unique `hostId` in the label; production code and assertions were unchanged.
- The [corrected database rerun](transaction-stop-fallback-db-fixed.log): **14 passed**, at 02:36 JST. All eight new fallback cases now reach their assertions: claimed or lost-result/crashed-host recovery, versus unclaimed, known-not-sent, changed-argument, unapproved, and missing-proof cases.
- [Focused Swift test summary](native-memory-final-tests.summary.log): **66 passed**, including **15 `TaskOutcomeTests`**, at 02:35 JST. This covers saved uncertainty, missing/generic result handling, structured task/event context, read-only recovery, and saved-record compatibility. It is a focused unit suite, not an interactive main-app stop journey. The [complete build/test log](native-memory-final-tests.log.gz), including build warnings, is preserved losslessly in gzip form.

The fallback verification record and current source/log hashes are in [transaction-cancel-fallback-verified.json](transaction-cancel-fallback-verified.json), with its [SHA-256](transaction-cancel-fallback-verified.json.sha256). These suites overlap earlier verification and are not added into a cumulative pass total. No full gate completion, actual live provider coverage, real order cancellation, or new native Stop success is asserted.

## Later main-app Stop observation

The later [main-app Stop run](MAIN_APP_STOP_UNKNOWN.md) persisted **CANCELLED** with the structured unknown lookup identity, zero saved fixture clicks, and no receipt. Root observed conservative warning text and disabled request reuse through read-only refresh. This scoped success does not erase the earlier failure or complete the interrupted full gate.
