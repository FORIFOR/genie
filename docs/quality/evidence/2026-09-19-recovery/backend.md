# Durable conversation acceptance — backend evidence

Date: 2026-09-19. Source revision and SHA256: [backend-manifest.json](backend-manifest.json). Build/config/environment/exact commands/exit codes are recorded there. Status: **PASS for the tested backend contract**, not an overall product release claim.

The additive `request_id` contract reserves `(tenant,user,conversation,request)` durably before interruption, appending turns, or creating tasks. The hash includes the entire parsed request (including defaults), independent of JSON object property order. One concurrent reservation wins. Equal repeats return stored responses or 409 while pending; changed input is 409. UUID-only keys are accepted. Requests without keys keep the previous behavior.

`GET /v1/conversations/:conversationId/requests/:requestId` is read-only. It returns pending, resolved plus the original response (including clarification, notices, and reply metadata), or 404 for unavailable/foreign caller receipts. It never resubmits, resumes, dispatches or claims task completion. A prepared response and stable turn ID allow resolving a task inserted before the final response write. The task lookup belongs to TaskService and filters tenant, user, conversation and idempotency key. A crash before a durable task/response stays pending; automatic execution recovery is deliberately outside this contract.

## Observed checks

- **PASS** gateway and transitive TypeScript build, exit 0 ([log](backend-build.log)).
- **PASS** real PostgreSQL/RLS + Fastify HTTP injection, 16 tests, 0 skipped, exit 0 ([log](backend-tests.log)). Nine new cases cover discarded POST response then GET, clarification/notices, changed input before interruption, a pending concurrent request, 20 simultaneous DB reservations, lost task-runtime acknowledgement, abandoned reservation, task committed before response, and tenant/user hiding + malformed UUID. Seven existing screenshot/stream tests also pass.
- **PASS** ownership/convention checker, exit 0 ([log](backend-conventions.log)). The first independent gate found a direct task-table read from ConversationService; this was corrected by injecting the owner TaskService's read-only lookup. No checker exclusion was added.
- **PASS** generated SQL/types verified independently by the gate agent on the separate disposable `recovery_generated` DB; see `gates-check-generated.log`.

These tests use real persistence and request handling, with an in-memory Task runtime and synthetic data. No external model, account, provider, or third-party service is called. Discarding a POST response is simulated at the test client, and execution interruption is injected at bounded service boundaries; native/live transport checks are separate evidence.

## Migration and setup

`20260919090000_conversation_requests.sql` must be applied before enabling keyed requests. Existing data is unchanged. `schema.sql` was dumped from the migrated isolated PostgreSQL database; `schema.ts` was generated with the installed `kysely-codegen`. New table has forced RLS and the tenant policy, plus API/service user scoping. Durable receipts have no automatic expiry. Rollback drops receipt evidence and must not be used during recovery.

The first local setup command exited 127 because host `psql` was not on PATH. Retried using `/opt/homebrew/opt/libpq/bin` and container bootstrap; no dependency download occurred. All resources belong to dedicated container `genie-recovery-db-20260919`, never the preexisting user DB.
