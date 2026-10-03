# Independent Computer Use entry review

2026-09-19. Separate agent/session from implementation; same model family, not human usability evaluation. Applied `.agents/skills/independent-product-verification/SKILL.md` and its evidence contract. Read-only implementation review; only evidence files written. Base revision, OS, Node, exact commands, exit codes and reviewed file SHA-256 are in [independent-manifest.json](independent-manifest.json).

Scope: new local CLI, launcher readiness property, helper permission probe, task consent wording, and existing execution/authorization boundaries those entry points invoke. No external transmission, OS permission changes, screenshot capture, clicking, or dependency installation performed by reviewer. Parent performs separate real native end-to-end verification.

| ID | Method / expected | Observed | Status | Evidence |
|---|---|---|---|---|
| I1 | CLI contract tests: durable key reused after response loss; explicit approval; no mutation on status | 6 tests pass, exit 0; injected transport rather than real gateway | PASS | independent-1.log |
| I2 | Existing vision regression suite: authorization, selected-model failure, cancellation, action bounds and uncertain outcomes | 24 tests pass, exit 0 against existing worker dist; mocked device/model, not actual desktop input | PASS | independent-2.log |
| I3 | Real native helper permission probe: JSON without capture/input/prompt | supported/accessibility/screenRecording/ready all true, exit 0; source branch returns before NSApplication setup | PASS | independent-3.log; source hash manifest |
| I4 | Static entry review: local destination only; no redirected credential/pixel request; persisted identity before submission | Validated runtime config, literal loopback gateway, redirect:error, exclusive 0600 run file and fsync before task request; approval is separate | PASS | scripts/computer-use.mjs; scripts/local-preview/config.mjs |
| I5 | Static recovery review: uncertain responses cannot unconditionally create another task or approve | Reuses original saved body/key; task service unique tenant/user/key and Temporal workflow ID prevent new task; known identity uses GET. No automatic retry/approval in CLI | PASS | scripts/computer-use.mjs; services/task/src/service.ts |
| I6 | Consent wording agrees with existing execution | Task/start help now describe initial consent, selected window, 12 operations/5 minutes, no per-operation confirmation | PASS | services/task/src/plan.ts; native helper selectTarget |
| I7 | Native task completion with actual observed input and independent result check | Not executed in reviewer session; see parent live evidence. A ready=true probe does not establish Computer Use success | BLOCKED | Reviewer limited to entry/contract review |
| I8 | Human beginner/assistive technology evaluation | No participant/VoiceOver session supplied or executed; AI review is not human evaluation | BLOCKED | No evidence claimed |

No blocking implementation defect found in the reviewed addition. This is a scoped result, not a claim that every arbitrary computer task is safe or supported.

Important contract qualifications:

- `recover` without a task ID is an explicit POST using the saved idempotency key and body. The existing task service may retry dispatch of a PENDING workflow. It is not a read-only receipt lookup. Once the task ID exists, recovery only GETs that identity. UI/input actions are not replayed automatically.
- The existing task idempotency endpoint returns the original task for a reused key; it does not compare changed bodies. CLI recovery reads the original saved request, so users must retain rather than edit/re-purpose a run file. Do not describe this as a general request-body conflict guarantee.
- Permission status describes this helper invocation. It does not establish that a selected model understands images, that input succeeds, or that another launcher ancestry/OS installation has permission.
- The vision regression run used the existing compiled dist; source compilation/fresh build evidence must accompany the parent report. The reviewer did not build or alter implementation.
- Filesystem/authentication/transport failures preserve the initial run file. If local save after acceptance fails, the same-key recovery path is still available; no new key is synthesized during recovery.

## Follow-up: isolated data root and canonical state path

Reviewed `ASTRA_DATA_ROOT=join(stateDir, 'app')` in serviceEnvironment and CLI `realpath(resolve(stateDir))` before computing the launcher lock port. CLI now matches loadConfig/start canonicalization, including macOS /tmp → /private/tmp and symlink aliases. Host and native app image handover paths now agree and fresh preview journals avoid shared cache. Both changes are correct for newly created isolated state.

Command: `node --test scripts/tests/managed-local-preview.test.mjs scripts/tests/computer-use.test.mjs`, exit 0, 19 PASS. Evidence: independent-followup.log and independent-followup-manifest.json. Tests use local temporary config/HTTP fixtures, not live computer input.

Migration finding (FAIL until addressed): previously running managed previews used `~/Library/Caches/Astra/VisualContext/ComputerRuns` claims. Merely changing ASTRA_DATA_ROOT points durable duplicate detection at an empty new directory. A previously claimed step redelivered after restart can miss its old claim. Preserve existing journals and either fail closed on matching legacy claim or explicitly prevent legacy unfinished computer task resumption. Do not automatically migrate or erase shared screenshots/consent files. Fresh isolated test environments do not exercise this compatibility case.

Actual native run success remains unproven by this reviewer. Parent reports planner_stopped and a different application selected; those observations must not be replaced by the successful permission probe or contract tests.

## Migration fix re-review

The migration finding above is now resolved for existing legacy claims. `NativeVisionDevice.claim` checks the legacy HOME cache for the same SHA-256 request ID before exclusively creating the new claim; an existing object produces replay_blocked and only ENOENT permits progress. Other lookup errors fail closed. It neither removes nor modifies legacy screenshots, consent, or journals. The current local claim still uses exclusive creation for new-directory concurrency.

PASS: independently ran `node --test workers/agent-host/test/computer-vision-integration.node.mjs`, exit 0, 4 tests passed. The new test creates a legacy claim under a synthetic HOME, switches to isolated storage, verifies the old request is rejected, and verifies a fresh request succeeds. Existing instance/restart duplicate checks, pinned local image transport, and cancellation also pass. Transport is mocked and /unused-helper is not executed; this is durable filesystem evidence, not desktop input success. Command output and source/dist hashes: independent-migration.log and independent-migration-manifest.json.

This closes the storage-migration finding, not the outstanding real Computer Use completion check.
