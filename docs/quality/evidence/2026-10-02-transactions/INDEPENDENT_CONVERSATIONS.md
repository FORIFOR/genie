# Independent conversation → simulation transaction verification

2026-10-02 JST. The verification agent authored this integration test independently of the natural-language parser, conversation route and task implementation. It uses the production Fastify route pipeline through `app.inject`, real PostgreSQL and RLS roles, and the existing `InMemoryTaskRuntime`. It does not run Temporal, generate model text, click a native checkout, or make a real order. Passing task acceptance is not transaction completion.

Commands and candidate source hashes: [independent-conversations-run.json](independent-conversations-run.json). Build and full test TypeScript checks exited 0. The DB-backed command exited 0 with **15 passed, 0 failed, 0 skipped**, using a dedicated database on a separately owned disposable Postgres container. The other verifier paused its role-creating DB tests during this run. Complete logs: [build](independent-conversations-build.log), [integration](independent-conversations-transaction.log), [test typecheck](independent-test-typecheck.log).

| ID | Method / expected | Observed | Status |
| --- | --- | --- | --- |
| HTTP-T1 | Explicit fictional pizza, burger and stock requests enter the transaction task path | Three requests persisted exact fictional provider/account/payment/destination/items/budget; paper stock preserves the fixture symbol, market, side, quantity, limit and expiry policy | PASS, 3 cases |
| HTTP-T2 | Task dispatch is bound to the accepted turn and does not claim execution or approve automatically | One dispatch and one task; `orderKey=turn:<accepted turn ID>`, PENDING, no result artifact and no approval signal | PASS, included in 3 positive cases |
| HTTP-T3 | Actual order requests, quoted/negated instructions, changed quantities/budgets and extra instructions must not silently become fixed demos | Nine HTTP requests created no `transaction.order`; other existing routing remains outside this test's execution scope | PASS, 9 cases |
| HTTP-T4 | A task committed before a lost runtime acknowledgement is recoverable without another order identity | GET receipt and repeated POST return original turn/task; task creation called once, one persisted task | PASS |
| HTTP-T5 | Same request ID with changed order text must not replace or interrupt the original | HTTP 409, original pizza order retained, no extra dispatch or signal | PASS |
| HTTP-T6 | Another tenant must not read or replay the accepted transaction | Task, request receipt and turn submission return 404; task count unchanged | PASS |

Test source: `services/api-gateway/test/conversations-transaction.integration.test.ts`. The expected transaction terms are asserted directly rather than obtained from the production intent builder. The existing in-memory runtime is intentionally explicit: native input, financial approval execution, provider receipts and final result rendering are verified elsewhere.

Separate observation: the first attempt to launch the newly packaged main app was blocked by the launcher's existing version check (`1.0` in the bundle versus `0.1.4` in source), before touching any unrelated app. See [preview-launcher-main-app.log](preview-launcher-main-app.log). This was reported to the packaging owner; the version gate was not weakened.

The owner then corrected packaging to read the source package version. A second startup using `apps/genie-macos/.build/Genie.app` reached ready with the main app, production helper and explicit transaction simulation enabled. See [main-app-preview-start.json](main-app-preview-start.json) and [preview-launcher-main-app-2.log](preview-launcher-main-app-2.log). The verifier handed the GUI to the parent agent for native E2E; startup is not checkout success.
