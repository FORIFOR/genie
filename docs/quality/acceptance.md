# First useful document: acceptance contract

Fixed before implementation, 2026-09-19. Initial verdicts: [RESULTS.md](RESULTS.md); latest additional verification: [RECOVERY.md](RECOVERY.md). Extends [J08](../ux-benchmark/journeys/J08-first-run.md), [first run](../FIRST_RUN.md) and [claims rules](../ux-benchmark/CLAIMS.md); historical PASS labels are not evidence for this revision.

User: a new Mac user with a local model, and a developer integrating the same task API.
Input: `次のメモを、次の行動と担当者が分かるチェックリストにしてください。アプリをテストする、デモを録画する、リリースノートを書く。分からない担当者は「未定」とし、文章だけを作ってください。`
Output: readable, editable UTF-8 Markdown covering all three tasks, without invented owners. Success requires checking content, saving, and reopening identical content, not a submitted request or a green health check.

## Environment and evidence

Target: current source, macOS native SwiftUI (minimum macOS 14), Node >=22, pnpm 10.12.2; local Ollama only for live generation. Use synthetic text and isolated temporary application storage. Preserve existing user changes and service data. No external model, account, publication or payment. Evidence: `evidence/2026-09-19/`, with revision, dirty diff, OS/tool versions, exact commands, exit codes and observed outcomes. Fixture/model/real GUI evidence must be labelled separately.

| ID | Expected result | Verification and required evidence |
|---|---|---|
| A1 | First-run guide names prerequisites and one route; no manual `.env`/dbmate instructions mistaken for managed setup | Read docs against launcher; help output and read-only prerequisite tests. Missing prerequisites name the next action; readiness never claims task success |
| A2 | Home offers a filled, editable first example and describes the saved output; selection does not submit | Native Home, select example, edit Japanese text, inspect focus and request count; screenshot/observations |
| A3 | Text generation covers 3 inputs and unknown owners remain unknown | Real local-model run through native application and gateway; inspect generated Markdown and task/artifact IDs. A fixture is insufficient |
| A4 | Edit, save, close/reopen preserves exact document; original model output retained | Native storage tests and GUI save/reopen; compare UTF-8 bytes/hash; failed save retains editable text and reports failure |
| A5 | Empty/working/waiting/failed/cancelled/unknown never claim a completed artifact; refresh does not resubmit | Native state tests, failure/recovery interaction and request counts; original task ID remains unchanged |
| A6 | SDK consumes standard SSE line endings, multiline data, arbitrary network chunking, comments, duplicate/gap/reconnect behavior | Protocol regression tests, including byte-split Japanese text and CRLF. Cursor advancement must follow successful consumer delivery |
| A7 | Integrator can identify contracts, errors, states, permissions, retry boundary and compatible revision | Checked SDK example; schema and server implementation links; explicitly experimental/private packages, same-revision guidance |
| A8 | License grants reuse; third-party notices retained | User-authorized MIT license, package metadata, contribution/security docs; no claim that MIT replaces dependencies' licenses |
| A9 | Build, typecheck and relevant tests pass without weaker assertions | Commands + exit codes + logs. Full suite failures remain visible; no commit until repo gates are green |
| A10 | Native keyboard/focus/Japanese IME/long text/interface scaling/reduced motion remain usable | Running Mac application observations, not web screenshots. Windows requires Windows and is BLOCKED here; web mobile/200% zoom are NOT_APPLICABLE to this native task |
| A11 | Comparable task outcomes and effort are measured honestly | Same synthetic input in Genie and Raycast AI/Notion AI; measure setup separately, completion, actions, save/reopen and interruption recovery. No competitor login or external submission in this run; comparative execution and real-user ≥90% first success remain BLOCKED without participants/authorization |

Allowed verdicts: PASS / FAIL / BLOCKED / NOT_APPLICABLE. Unexecuted checks are never PASS. Independent AI review is not real-user evaluation.

## Improvement rounds (maximum three)

1. License, first-run/compatibility contract and evidence baseline.
2. Native first sample and local document editing; SDK SSE compatibility and recovery.
3. Independent review, bounded fixes and verification. Report remaining gates rather than changing the target.

## UI change record (DESIGN §4)

reference : Existing Genie Home/Work and docs/TESTING.md; use the existing example→document workflow, inspected 2026-09-19.
hypothesis: Replace one incomplete template with the acceptance input; add local editing within the existing result surface so generated text becomes usable without another model call.
measured  : Home has 3 starter cards; result toolbar has copy/read-aloud/save and a read-only document. No dimension/color token changes proposed.
candidates: A = current read-only result; B = same surface with explicit edit/save/cancel and retained original; choose B for functional A4, not an aesthetic claim.
gate      : Storage/state tests, native interaction and geometry/golden capture; preserve design metrics. No human visual preference claim.

## Follow-up: installed skills and terminal-state race (2026-09-19)

Scope: the same document task, specifically cancelling while its artifact is being composed or its completion is being committed. No visual redesign; world-class-ui is installed but its UI-only workflow is not executed in this backend increment. Skill instructions do not authorize publishing or external calls.

| ID | Environment / expected result | Verification / evidence |
|---|---|---|
| F1 | Local repo: five supplied skills installed without overwriting instructions; file hashes match supplied kit | Reviewed installer, dry-run/apply, bundled SHA256SUMS, installed file manifest |
| F2 | Workflow harness: cancel during composition or before completion commit returns CANCELLED; a committed completion remains COMPLETED | Deterministic boundary injection, asserts workflow result and activity calls; old-history patch path retained |
| F3 | Isolated PostgreSQL + real activity implementations: competing completion/cancellation leave one terminal DB state and matching event; retries add no second terminal event; delayed start/pause/resume must not erase CANCELLING | Concurrent transactions and activity retries, SQL/event assertions, complete output and exit code |
| F4 | Current source: build/typecheck/related task tests pass without weakened assertions | Commands/logs in evidence/2026-09-19-followup; independent reviewer audits final diff |

Audit priority: P0 terminal DB/event/workflow disagreement (fix now); P1 lost conversation acceptance response (separate durable turn identity and reconciliation contract, remains open); P2 visual/accessibility coverage (prior actual Mac evidence remains historical). Existing task status enum and transactional event stream are the boundary; no new external protocol.

UX outcome: requesting cancellation is not cancelled/completed until the execution layer commits the outcome. Work already committed as completed must not regress to CANCELLING. The existing document view and controls remain the design direction; this round changes their authoritative state source, not layout.

## Recovery round (2026-09-19)

Keep the existing thresholds. R1: optional UUID request_id persisted before submission; same owner/conversation/key/body cannot create two turns/tasks, changed body conflicts. R2: after POST response loss, authenticated GET receipt returns the original outcome/task without invoking any model/tool; pending and missing receipts remain unknown. Test real isolated DB/Gateway, concurrent duplicate requests, wrong owner/tenant, clarification and incomplete receipts. R3: native client stores receipt identity, survives close/open, exposes existing status-check action for unknown submissions; wire/GUI recovery returns identical output and one backend job. R4: real histories recorded by prior-revision workflow replay on current worker; disclose fixture vs production histories. R5: run available native accessibility, generated-file and build gates; do not equate missing OS/human participation with success. Evidence: evidence/2026-09-19-recovery.

reference : Existing Genie Work Recovery structure, DESIGN.md §0/§6 and DS-06, inspected 2026-09-19.
hypothesis: Enable the existing status-check action when a saved receipt can be queried, so a lost response has a visible recovery path without resubmission.
measured  : Current canRefresh requires backendTaskID, preventing recovery before its response arrives; no dimension/color changes.
candidates: A=current disabled recovery for unknown submission; B=existing action backed by durable receipt lookup; select B.
gate      : Request/storage/HTTP tests, actual native recovery interaction and artifact equality; screenshots/geometry for existing surfaces. No visual superiority claim.
