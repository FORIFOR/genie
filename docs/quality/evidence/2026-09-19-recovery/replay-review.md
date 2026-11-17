# Previous-revision Temporal replay verification

Independent verification agent applied `.agents/skills/independent-product-verification/SKILL.md` and its evidence contract. Same-model separate agent; not a human or production evaluation. Product source files were not changed by this agent.

| id | method | expected | observed | status | evidence |
|---|---|---|---|---|---|
| REPLAY-OLD-COMPLETE | Copy unchanged workflow and plan from git revision `28f89f2636a3b780e813ea902e07d2e4900a6e3f`; execute with local synthetic activities on isolated real Temporal; replay history using current workflow | Old void `completeTask` result remains replayable | Old completion returned COMPLETED + fixture artifact; current replay succeeded. Terminal activity payload verified `binary/null`. No new `task-terminal-outcome-v1` marker in old history | PASS | `replay-capture.log`, `replay-offline.log`, `services/task/test/replay-fixtures/completed.json` |
| REPLAY-OLD-CANCEL | Same, signal cancellation during fixture step and retain old void `cancelTask` result | Old cancellation remains replayable | Old cancellation returned CANCELLED + null artifact; current replay succeeded; terminal payload verified `binary/null` | PASS | same logs, `services/task/test/replay-fixtures/cancelled.json` |
| REPLAY-PRODUCTION | Replay a previously deployed production history | Known deployed histories replay without nondeterminism | No approved production history is available in this repository/session. Synthetic fixtures are not production captures and do not cover every older release/branch | BLOCKED | no production fixture |

Environment, exact commands, exit codes and current source hashes: `replay-result.json`. Historical source and history hashes: `services/task/test/replay-fixtures/provenance.json`. Existing cached Temporal executable used with server version checks disabled by the SDK; loopback random port, no shared services, model calls, database writes, or downloads. Server and worker stopped after capture.

The two fixture histories are genuine engine outputs from the previous revision, not handcrafted command lists. Activities intentionally contain synthetic data and no business persistence. This verifies workflow determinism for these two paths, not the production database adapter or cancellation race itself (covered separately).

Normal test runs replay both stored histories offline. The capture test is opt-in because it regenerates fixtures and requires an explicit executable path; its default skip is not skipped compatibility coverage. Capture was also executed successfully (3 tests total).

Harness failures are retained, not represented as product failures: macOS temporary-directory symlink path resolution; missing/incorrect synthetic approval activity; incompatible JSON history serialization. Final capture uses realpath, a null no-approval response, and unchanged protobuf JSON restored with the exact Temporal protobuf `History.fromObject`. Temporal 1.22.0's `historyToJSON` triggered its documented `proto3-json-serializer` Buffer limitation. No expectation or workflow history was relaxed to pass. See `replay-result.json` for failed-attempt exit statuses.
