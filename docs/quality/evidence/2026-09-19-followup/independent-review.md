# Independent technical verification — terminal outcome follow-up

Date: 2026-09-19 JST. Reviewer: separate AI subagent `terminal_verification`, applying the installed `independent-product-verification` skill and its evidence contract. The reviewer did not edit product implementation, and authored the DB/runtime tests independently. This is technical independent review, not a human usability study or complete model independence.

Target: HEAD `28f89f2636a3b780e813ea902e07d2e4900a6e3f` plus uncommitted source identified by [SHA-256 manifest](independent-source-manifest.json). Backend-only scope: accepted cancellation versus completion; persisted state, workflow return, events and duplicate delivery must agree. Existing broad product limitations are not cleared by this review.

Environment: macOS 26.6.2 (25G83), arm64, Node 26.5.0, pnpm 10.12.2; cached Temporal CLI 1.8.3 / server 1.31.2 and TypeScript SDK 1.22.0. PostgreSQL 16.15 from already-cached `pgvector/pgvector:pg16`, one uniquely named ephemeral container `genie-quality-terminal-20260919` on `127.0.0.1:32768`, no persistent volume. `genie_app` has neither superuser nor BYPASSRLS. Data: synthetic tenants/users, echo tasks, local filesystem artifacts. No real provider credentials, remote generation, or external delivery used. Runtime test creates fresh loopback Temporal servers with an explicit existing executable, no download.

| id | method | expected | observed | status | evidence | environment |
|---|---|---|---|---|---|---|
| IV-1 | Independently review final product diff | Cancellation and completion serialize; events follow committed transitions | `cancel` locks row before terminal check; complete/cancel/fail/start/pause append events only after successful conditional update; workflow returns persisted outcome behind a version patch | PASS | `services/task/src/{service,activities,workflows,activity-types}.ts`, manifest | Static review |
| IV-2 | Real PostgreSQL: accept cancel before complete; duplicate complete/cancel/fail; different-tenant calls | No opposite terminal event, no timestamp mutation, no repeated cancellation audit, tenant isolation | Assertions passed for state/artifact/events/audit and tenant-hidden errors | PASS | [runtime log](terminal-runtime-final.log), `terminal-state.test.ts` | Real DB, controlled runtime substitute for these tests |
| IV-3 | Hold completion transaction open; start cancel; verify actual DB Lock wait; commit barrier | Cancel rereads committed terminal state and rejects instead of overwriting COMPLETED | `task.invalid_state`, final COMPLETED | PASS | same log, deterministic lock-barrier test | Real PostgreSQL concurrent sessions |
| IV-4 | Twelve concurrent cancel/complete iterations | Exactly one matching terminal event and correct result artifact | All iterations converged to COMPLETED or CANCELLED | PASS | same log | Real DB; supplementary scheduling coverage |
| IV-5 | Late start/pause/resume after CANCELLING and CANCELLED | Cancellation and events unchanged | Task equality and event equality assertions passed | PASS | same log | Real DB |
| IV-6 | Real workflow engine: hold artifact composition after artifact persistence, accept cancellation, then release; repeat suppressing signal delivery | Workflow result, DB row and terminal event all CANCELLED, result artifact null; already-created artifact retained | Both scenarios passed and source artifact was found in Library | PASS | same log, final runtime test in `terminal-state.test.ts` | Real Temporal + DB; intentional injected barrier/signal loss, no provider |
| IV-7 | Existing 15 task E2E cases on private Temporal+DB | Completion, progress, event replay, approval and isolation continue working | 15 passed; injected Gmail/Outlook response loss tests used local host doubles, not actual mail | PASS | same log, `task.e2e.test.ts` | Real engine/storage; provider doubles |
| IV-8 | `pnpm typecheck` | exit 0 | exit 0 | PASS | [independent typecheck](independent-typecheck.log) | Repository TS build/test configs |
| IV-9 | Production pre-patch history replay / mixed-version rollout | Historical workflow execution remains compatible | No production history available; patch-false mock is not a historical-engine replay | BLOCKED | Implementation has `patched('task-terminal-outcome-v1')`, no genuine old history tested | Requires suitable captured history, not credentials in this review |
| IV-10 | UI first-use, visual craft, IME, native device usability | Applicable when changing UI | Backend-only increment; no new UI evaluated, prior blockers retained | NOT_APPLICABLE | Scope declaration | No UI claims |
| IV-11 | Competitor/human comparison | Comparable human/task evidence | Not performed or replaced by this AI reviewer | BLOCKED | Scope declaration | Real users/comparable sessions unavailable |

Final execution: **24 tests PASS, no skips** in the selected two-file run: 15 existing E2E + 9 terminal tests. The latter are 8 direct real-DB tests and 1 real-engine test containing two scenarios. Do not add the two scenarios as separate test cases when reporting totals. Final run started 18:51:42 JST, exit code 0, duration 9.91s. Independent typecheck exit code 0.

Initial fixture corrections are retained transparently: [invalid synthetic error code](terminal-db-fixture-invalid-code.log) failed because the fixture supplied a code absent from the existing contract; it was corrected to existing `task.step_failed`, without loosening assertions. [Lock-observation fixture](terminal-db-fixture-lock-filter.log) initially searched the wrong application name; the DB pool appends `:tenant`, so the observer was corrected to its actual prefix. The initial [four-test success](terminal-db-first.log) and [seven-test success](terminal-db-final.log) predate the final 24-test run and are not the final totals. Product-before-fix real-DB baseline was not captured because implementation landed while fixtures were being prepared; root's workflow mock baseline is separate evidence.

## Commands and cleanup

Provisioning (all exit 0):

```sh
docker run --pull=never --detach --name genie-quality-terminal-20260919 \
  --publish 127.0.0.1::5432 --env POSTGRES_USER=quality \
  --env POSTGRES_PASSWORD=quality-local --env POSTGRES_DB=quality pgvector/pgvector:pg16
dbmate --url 'postgres://quality:quality-local@127.0.0.1:32768/quality?sslmode=disable' \
  --migrations-dir infra/db/migrations --no-dump-schema up
docker exec -i genie-quality-terminal-20260919 psql -U quality -d quality \
  -v ON_ERROR_STOP=1 < infra/db/bootstrap.sql
```

Final test command (exit 0; credentials below belong only to discarded synthetic local data):

```sh
TEST_DATABASE_URL='postgres://genie_app:genie_app@127.0.0.1:32768/quality?sslmode=disable' \
TEST_IDENTITY_DATABASE_URL='postgres://astra_identity:astra_identity@127.0.0.1:32768/quality?sslmode=disable' \
ASTRA_TEST_TEMPORAL_PATH='/private/var/folders/xn/mdmvpkwd0yx4tcr7rvn_3xv80000gn/T/temporal-sdk-typescript-1.22.0' \
pnpm --filter @genie/service-task exec vitest run test/terminal-state.test.ts test/task.e2e.test.ts
pnpm typecheck
```

`ASTRA_TEST_TEMPORAL_PATH` is an explicit offline existing-binary option added to the existing E2E harness; unset preserves previous behavior. For the new real-engine case, no path means skip, never an implied PASS. This recorded run supplied the path and executed the case.

Private Temporal servers were torn down by test cleanup. Local artifact temp directories removed. Own PostgreSQL container removed with `docker rm --force --volumes genie-quality-terminal-20260919`, exit 0. [Cleanup log](independent-cleanup.log) lists existing user containers still running; none were changed. The random published port will differ on a rerun.

No additional blocker found in the final selected terminal-race implementation. Release-wide approval is **not** granted: reception reconciliation, production history replay, OS/IME and other previous acceptance blockers remain outside this tested increment.
