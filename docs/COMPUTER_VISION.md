# Screenshot-grounded computer use

`computer.run` now uses **fresh screenshots, grounded targets and independent visual verification**. The old metadata-only planner is not a fallback for this route. Connecting a text model alone never enables desktop control.

## What the user can try

Build current source and run the managed preview on **macOS 14.4 or later**:

```sh
node scripts/start-local-preview.mjs --model <installed-vision-model> --computer-use
```

This builds `.build/computer/genie-computer` using Xcode Command Line Tools. Grant Accessibility and Screen Recording to the executable/process macOS identifies in its permission UI; the helper refuses to run without both. This does not bypass TCC. The old v0.1.4 DMG does not include this feature.

Submit the existing `computer.run` task through the authenticated task API with `goal` and optionally `successCriteria`. A regular task approval is still required. A **native local dialog selects the target app and discloses the screenshot recipient**, then every input operation is confirmed locally with a screenshot and the proposed input. The chosen foreground window is pinned for the run; changing windows/apps stops it rather than extending access silently.

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
4. The helper rechecks permissions, foreground window, geometry and exact image equality before input. It asks for local per-action confirmation and rechecks again afterwards. Japanese and surrogate-pair emoji are preserved.
5. The verifier receives actual **BEFORE and AFTER** PNGs and checks the expected visible state. A separate fresh-image goal verification is required even when the planner says `done`.

Coordinates are transformed from image pixels to Quartz global points using the captured window bounds. Retina scaling and negative monitor origins are supported by the mapping; they are regression-tested. No OCR is required.

## Boundaries enforced outside the model

- A nonempty, unexpired, matching task approval is required before capture. The native helper independently checks approval expiry immediately before input. This is validation of the trusted task channel's proof, not a new cryptographic signature scheme.
- Screenshot egress is local by default. External APIs / Codex require `ASTRA_COMPUTER_VISION_EXTERNAL=on` on the **agent host** and the local recipient-consent dialog. Provider choice stays pinned; failure does not silently switch providers. Claude Code vision is not enabled because its existing broad Read-tool boundary needs separate review.
- Only click, bounded single-field text, and navigation keys (Tab, Escape, arrows) are accepted. No Enter, send hotkeys, shell/URL tool, arbitrary modifiers or model-supplied permission grants.
- Every mutating operation requires native human confirmation. Model prompts additionally stop at high-risk boundaries; those prompts alone are not a safety guarantee.
- Stale IDs, out-of-window targets, low confidence, changed targets, unavailable images and uncertain verification stop the run. Exact pixel equality deliberately favours refusal over a stale click: animation, blinking carets or tooltips may require replanning.
- Maximum 12 inputs, 30 model calls, 5 minutes by default, at most two replans. Cancellation is propagated to model HTTP/CLI calls and the helper. No implicit undo is claimed for input already emitted.
- Computer tasks are non-reversible/single-attempt in the task planner. A private local start journal prevents replay after an interrupted host; a new user task is required to retry. Never delete that journal to "resume" ambiguous mutations.
- Temporary PNGs are removed on normal completion, failure or cancellation. Abrupt process/OS death can leave files; the existing handover cache retention policy remains relevant. Journal entries contain only a hashed request ID, state and timestamp. Returned audit data contains action types and image hashes, not screenshots, typed text or model-extracted private text.

## What visual verification proves — and does not

Visual verification is a model assessment of **visible** evidence, not a guarantee that an email was delivered or data was durably saved. Prefer a structured API/readback verifier for such completion conditions. Identical screenshots and a moved cursor are never independently sufficient evidence of a successful operation.

The native helper is compiled and its coordinate/refusal self-tests run by the dedicated macOS workflow. Node regression tests cover the loop, privacy boundary, cancellation, replay, malformed output and real PNG payload wiring. GUI/TCC behaviour and real-model success rates require an interactive Mac test and are not inferred from these tests.
