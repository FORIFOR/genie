> Historical foreground compatibility path. The managed `--computer-use` launcher now uses the background AX helper described in [COMPUTER_VISION.md](COMPUTER_VISION.md). Startup examples below are historical and no longer select this foreground mode.

# Screenshot-grounded computer use

`computer.run` now uses **fresh screenshots, grounded targets and independent visual verification**. The old metadata-only planner is not a fallback for this route. Connecting a text model alone never enables desktop control.

## What the user can try

Build current source and run the managed preview on **macOS 14.4 or later**:

```sh
node scripts/start-local-preview.mjs --model <installed-vision-model> --computer-use
```

This builds `.build/computer/genie-computer` using Xcode Command Line Tools. Grant Accessibility and Screen Recording to the executable/process macOS identifies in its permission UI; the helper refuses to run without both. This does not bypass TCC. The old v0.1.4 DMG does not include this feature.

Submit the existing `computer.run` task through the authenticated task API with `goal` and optionally `successCriteria`. A regular task approval is still required. A **native local dialog selects the target app, discloses the screenshot recipient and is the single human consent for the run**: it states that the run's individual operations are not confirmed one by one, and names the limits it grants (that window only, at most 12 inputs, 5 minutes). The chosen window is pinned for the run by application, PID and window id. Its position is re-read before every input, so moving the window does not stop the run; a different window, a different element under the target point, or another window covering it does.

Example task input (not a new endpoint):

```json
{
  "goal": "Open the preferences panel in the selected test app",
  "successCriteria": "The preferences panel heading and its controls are visible"
}
```

This is a developer-preview API workflow. No new natural-language TaskDock launch button or universal app automation claim is implied. Test first on a local page or disposable app account, not mail, payments, production consoles, or private documents.

## Data flow

1. The native helper uses ScreenCaptureKit to capture only the selected window, without the cursor or window shadow, at up to 1440 pixels on the longest side.
2. A new PNG is written exclusively with owner-only permissions into the existing `VisualContext` handover directory. The host validates PNG dimensions, hash, ID, timestamps and window identity.
3. The existing `locateImages` / `readVisualImages` path passes the actual pixels to the pinned model. The model returns an image-pixel bounding box, not ungrounded desktop coordinates.
4. The helper rechecks permissions, window identity, freshness and the target itself before input. The image hash records which pixels the decision was made from; **whether the input may be emitted is decided by identity, not by whole-window pixel equality** — a blinking caret in the field being typed into changes the window every second, so whole-image equality refused exactly the operation it was meant to protect. Japanese and surrogate-pair emoji are preserved.
5. The verifier receives actual **BEFORE and AFTER** PNGs and checks the expected visible state. A separate fresh-image goal verification is required even when the planner says `done`.

Coordinates are transformed from image pixels to Quartz global points using the captured window bounds. Retina scaling and negative monitor origins are supported by the mapping; they are regression-tested. No OCR is required.

## Boundaries enforced outside the model

- A nonempty, unexpired, matching task approval is required before capture. The native helper independently checks approval expiry immediately before input. This is validation of the trusted task channel's proof, not a new cryptographic signature scheme.
- Screenshot egress is local by default. External APIs / Codex require `ASTRA_COMPUTER_VISION_EXTERNAL=on` on the **agent host** and the local recipient-consent dialog. Provider choice stays pinned; failure does not silently switch providers. Claude Code vision is not enabled because its existing broad Read-tool boundary needs separate review.
- Only click, bounded single-field text, and navigation keys (Tab, Escape, arrows) are accepted. No Enter, send hotkeys, shell/URL tool, arbitrary modifiers or model-supplied permission grants.
- One native human consent covers the run, given in the target-selection dialog before any capture. Individual operations are not confirmed separately. Model prompts additionally stop at high-risk boundaries; those prompts alone are not a safety guarantee.
- Stale IDs, out-of-window targets, low confidence, changed targets, unavailable images and uncertain verification stop the run. Before each input the helper requires, outside the model: the pinned window still on screen at the same size; that window visible at the target point, not covered by another normal window; and the accessibility element under that point unchanged in role and in position and size within the window. Absent accessibility attributes are not read as a difference — they go missing while an application rebuilds its tree — but attributes present on both sides must agree. Where no accessibility element can be resolved, the original whole-window pixel equality still applies.
- Maximum 12 inputs, 30 model calls, 5 minutes by default, at most two replans. Cancellation is propagated to model HTTP/CLI calls and the helper. No implicit undo is claimed for input already emitted.
- Computer tasks are non-reversible/single-attempt in the task planner. A private local start journal prevents replay after an interrupted host; a new user task is required to retry. Never delete that journal to "resume" ambiguous mutations.
- Temporary PNGs are removed on normal completion, failure or cancellation. Abrupt process/OS death can leave files; the existing handover cache retention policy remains relevant. Journal entries contain only a hashed request ID, state and timestamp. Returned audit data contains action types and image hashes, not screenshots, typed text or model-extracted private text.

## What visual verification proves — and does not

Visual verification is a model assessment of **visible** evidence, not a guarantee that an email was delivered or data was durably saved. Prefer a structured API/readback verifier for such completion conditions. Identical screenshots and a moved cursor are never independently sufficient evidence of a successful operation.

The native helper is compiled and its coordinate/refusal self-tests run by the dedicated macOS workflow. Node regression tests cover the loop, privacy boundary, cancellation, replay, malformed output and real PNG payload wiring. GUI/TCC behaviour and real-model success rates require an interactive Mac test and are not inferred from these tests.

## Local command entry point (experimental)

The current source includes `scripts/computer-use.mjs`, a thin client for the existing authenticated task API. Start the preview in one terminal, then use a second terminal:

```sh
node scripts/start-local-preview.mjs --model qwen3.5:9b --computer-use
node scripts/computer-use.mjs check
node scripts/computer-use.mjs start \
  --goal 'Open the details panel in my test app' \
  --criteria 'The details heading and its contents are visible' \
  --run-file /tmp/genie-computer-run.json
node scripts/computer-use.mjs status --run-file /tmp/genie-computer-run.json
# Inspect the goal and approval summary above; substitute its actual approval ID.
node scripts/computer-use.mjs approve --run-file /tmp/genie-computer-run.json --approval-id <ID>
node scripts/computer-use.mjs status --run-file /tmp/genie-computer-run.json
node scripts/computer-use.mjs cancel --run-file /tmp/genie-computer-run.json
```

For a custom preview directory, give **every command** the same `--state-dir`. `check` reads helper permissions and authenticated launcher status, without taking screenshots, emitting input, or requesting OS permissions. Its readiness is setup readiness, not proof that the model can complete a task. Use an installed vision model; the command never downloads one. `--status` can also be invoked directly on `.build/computer/genie-computer` after `bash scripts/build-computer-helper.sh`.

`start` creates a private run file before its POST, and refuses to overwrite an existing file. It does not grant approval. `approve` verifies the current task and matching pending approval ID; the native dialog then selects the window and discloses the local model recipient. `APPROVAL_SENT` is not completion. `cancel` is a cancellation request, not an undo: inspect status until it is terminal.

If acceptance was lost, keep the run file and use `recover` with the same file. When a task ID is already saved this is a GET. Without an ID, it explicitly repeats the identical saved create request with its original idempotency key. The server returns the existing task and may retry its PENDING workflow dispatch; it does not automatically approve the task. Do not edit the stored key/input or delete the file to retry uncertain work. This existing API does not reject same-key/different-body requests; the client keeps the original body. Status and cancellation never create another task. The file contains the goal and task ID but no credential; keep it private.

The command is scoped to the managed local preview and its existing development identity. It is not a production login client, a new unrestricted computer tool, or a new native TaskDock button. Existing target/approval/egress guards remain in the execution layer.

A disposable native target for verification is in `tools/computer-use/test-app.swift`. It has only a local “Show details” button and writes a structured result only when `GENIE_TEST_RESULT` is explicitly set. It does not read user documents or access the network. Current evidence: [Computer Use verification](quality/COMPUTER_USE.md).

Managed preview now gives the host the same `state-dir/app` data root as the native app. Its screenshots and new run journals stay in `app/VisualContext`. Claims in the older ordinary cache are still checked read-only before a new claim, so moving the preview storage does not re-enable an interrupted request. Existing journals are not removed.
