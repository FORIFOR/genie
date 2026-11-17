# Integrating the experimental preview

Genie first-party code is [MIT-licensed](../LICENSE). Keep third-party notices. The workspace packages are **private, version 0.0.0**, not a published stable npm SDK. Build and pin app, Rust bindings, gateway, workers, `@genie/contracts` and `@genie/api-client` to the **same Git revision**. `/v1` and a 0.1.4 display version do not guarantee cross-revision binary or schema compatibility. macOS requires 14+ (computer vision 14.4+); Windows remains separately verified work. Node requires 22+, pnpm 10.12.2.

## Boundaries and contracts

| Responsibility | Authoritative implementation |
|---|---|
| Task states/transitions, JSON input/output, errors/events | [Zod contracts](../packages/contracts/src/task.ts), [events](../packages/contracts/src/events.ts), [errors](../packages/contracts/src/errors.ts) |
| Tenant authentication, authorization, request idempotency | Gateway routes + [TaskService](../services/task/src/service.ts); never trust a UI permission claim |
| Durable orchestration and side-effect retry policy | [workflow](../services/task/src/workflows.ts), [plan](../services/task/src/plan.ts), [activities](../services/task/src/activities.ts) |
| HTTP/SSE transport, schema validation | [API client](../packages/api-client/src/index.ts) |
| Model/provider/device execution | `workers/agent-host`; no automatic paid-provider replacement |
| Native presentation, local edited copy, Markdown export | `apps/genie-macos`; shared native functionality through `core/genie-core` |

No new business rules are introduced in CLI/SDK. A local edit is a local document revision, not an update of the backend artifact or a new model task.

## First integration

Run `pnpm install --frozen-lockfile && pnpm build` in the workspace. Depend on `@genie/api-client` via `workspace:*` inside this repo; do not assume `npm install @genie/api-client` is available. Supply your current access token from your authentication layer, never commit it. Development sign-in is local testing only.

```ts
import { GenieClient } from '@genie/api-client';
const client = new GenieClient({
  baseUrl: 'http://127.0.0.1:43123',
  accessToken: () => currentAccessToken, // supplied by your app
});
const task = await client.getTask(savedTaskId);
// PENDING/RUNNING/WAITING_APPROVAL/PAUSED_HOST_OFFLINE/CANCELLING are not success.
if (task.status === 'COMPLETED' && task.result_artifact_id) {
  const markdown = await (await client.artifactContent(task.result_artifact_id)).text();
  // Reject empty output; display as untrusted text, let the user review and save.
}
```

The executable [readDocument example](../packages/api-client/examples/read-document.ts) is covered by SDK tests. It returns null while work is pending, rejects failed/cancelled or empty/missing results, and never starts another task. Native export additionally includes the title and original request; SDK content is the backend artifact only.

`createTask({kind,input,title?}, key)` uses `POST /v1/tasks`. Persist a unique idempotency key **before** submitting and preserve it for the same request. The server scopes deduplication to tenant/user/key; never reuse it for a different input. HTTP 202 is acceptance, not completion. This does not guarantee exactly-once effects at an external provider. Conversation `sendTurn` now accepts an optional persisted `request_id` UUID; see the receipt contract below. Legacy unkeyed requests still cannot be reconciled after a lost response. Never blindly resubmit a side effect.

## Events, errors and recovery

`streamTask` uses authenticated GET + SSE and `Last-Event-ID`. It handles UTF-8 split across chunks, LF/CRLF/CR, multiline data, comments, gaps and duplicate sequences according to the [WHATWG event-stream framing](https://html.spec.whatwg.org/multipage/server-sent-events.html#parsing-an-event-stream) (checked 2026-09-19). Genie additionally requires the JSON event envelope and contiguous numeric sequence; this is not a general browser EventSource replacement (`retry` is controlled by SDK options). Unknown event types advance the cursor through `onUnknown`. Throwing synchronous handlers are redelivered; make consumers idempotent and do not use an async handler as a durable acknowledgement.

A resolved stream returns the last cursor, **not a completion verdict**: abort and exhausted reconnect attempts also resolve. Read `getTask` after reconnect and inspect actual artifact content before declaring document success. `maxAttempts`, backoff and `AbortSignal` bound observation; aborting observation does not cancel a backend job. `cancelTask` requests cancellation; wait for terminal state. No HTTP retry occurs for network ambiguity; the optional 401 hook retries once using the same options/key. `GenieError` exposes code/httpStatus/retryable; schema and network errors can be other error types. A retryable label does not authorize replaying a side effect.

Approval, credentials, permission scope, external destination and cost must be shown before external execution. Computer use and external connectors are opt-in experimental adapters. See [security](../SECURITY.md), [first success](FIRST_RUN.md) and [acceptance evidence](quality/acceptance.md). No production or competitive quality claim follows from passing SDK fixtures.

## Cancellation and terminal commits (2026-09-19 follow-up)

Cancellation requests serialize their state check with terminal updates using the task row lock. An already terminal task returns `task.invalid_state` instead of reverting to `CANCELLING`. The completion/cancellation activities emit a terminal event only when their conditional update changes the row; retries return the persisted result and do not duplicate the terminal event or cancellation audit entry. Completion encountering a committed cancellation request finalizes cancellation even if its Temporal signal has not arrived. Delayed start/host-pause activities cannot erase CANCELLING, and zero-row start/pause updates emit no state event. Artifacts already created during composition can remain in Library; cancellation does not undo external work or erase saved objects.

New workflow executions use the `task-terminal-outcome-v1` Temporal patch. The unpatched historical command path is retained; these stronger workflow-result guarantees must not be claimed for old executions. Deploy workflow and activities from the same revision and verify replay against retained histories before a production rollout (not performed here). That terminal-state fix alone did not change HTTP status enums or require a migration. The subsequent receipt feature below adds an optional request field and a required database migration. The durable DB event stream is authoritative; transient publisher delivery is not an exactly-once commitment.

See the [follow-up verification](quality/FOLLOWUP.md) for DB concurrency tests and [current recovery results](quality/RECOVERY.md) for receipt recovery and genuine prior-revision Temporal replay.

## Recover an accepted conversation request without resubmission

Apply `20260919090000_conversation_requests.sql` before deploying the new gateway, then use matching SDK/native clients. Existing unkeyed POSTs remain supported. New callers persist the UUID, conversation ID and target base URL before sending:

```ts
// savedRequestId and conversationId come from your durable local record.
await client.sendTurn(conversationId, { text: 'メモをチェックリストにしてください', request_id: savedRequestId });
// If the response was lost, use only this GET:
const receipt = await client.getTurnReceipt(conversationId, savedRequestId);
if (receipt.status === 'resolved' && receipt.response.task_id) {
  const markdown = await readDocument(client, receipt.response.task_id);
  // null still means working; retain the same IDs.
}
```

POST admission is unique per tenant/user/conversation/UUID and hashes the entire parsed request. Repeating that key with different content returns `common.conflict` (409). A concurrent unfinished request also returns409; it is not re-executed. GET `/v1/conversations/:conversationId/requests/:requestId` is read-only: `pending` means the receipt exists but has no recoverable outcome; `resolved` contains the original response, including clarification/notice/reply metadata or the same task ID. Other owners/tenants and missing receipts receive404. Resolved receipt is acceptance, not task completion. SDK receipt decoding currently exposes clarification/notice/task fields; use the existing native response parser for reply-draft metadata.

The gateway injects `TaskService.findByConversationTurn` into `ConversationService` as `findAcceptedTask`. Custom gateway assembly must supply that adapter to recover a task committed before response finalization; omitting it conservatively leaves the receipt pending. No service reads another service's owned table directly.

Receipt GET never dispatches a task. If the process crashed before task creation or between DB creation and runtime dispatch, the request/task may remain pending and requires operator reconciliation; automatic resubmission is deliberately absent. This is not exactly-once external-provider execution. Direct consumer-task creation and legacy records without receipt IDs are outside this new recovery path. Roll out schema→gateway/worker→same-revision clients; do not roll back the receipt table while clients still reference it.
