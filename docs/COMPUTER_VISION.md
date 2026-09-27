# Background computer use (experimental macOS preview)

The managed `--computer-use` route now selects `.build/computer/genie-computer-background`. It does not raise the target app, move the shared cursor, inject global keyboard events, use the clipboard, or fall back to the old foreground driver. The old `.build/computer/genie-computer` source/binary remains for explicit custom-host compatibility; its [previous behavior](COMPUTER_VISION_FOREGROUND.md) is **not** background-safe.

This is a limited native AX adapter, not Codex parity or universal browser automation. No third-party driver or private Codex runtime is installed. The same existing model loop, task approval, local screenshot handover and visual verifier are used.

## Start and control

Requires macOS14.4+, Xcode Command Line Tools, existing managed-preview dependencies, an installed vision model, Accessibility and Screen Recording permissions for the helper's responsible process. Do not grant new OS permissions automatically. Start one terminal and keep it open:

```sh
node scripts/start-local-preview.mjs --model qwen3.5:9b --computer-use
```

In a second terminal:

```sh
node scripts/computer-use.mjs check
node scripts/computer-use.mjs start \
  --goal 'Open the details in my disposable test app' \
  --criteria 'The details heading and contents are visible' \
  --run-file /tmp/genie-computer-run.json
node scripts/computer-use.mjs status --run-file /tmp/genie-computer-run.json
# Inspect the pending approval summary and substitute its actual ID:
node scripts/computer-use.mjs approve --run-file /tmp/genie-computer-run.json --approval-id <ID>
node scripts/computer-use.mjs status --run-file /tmp/genie-computer-run.json
node scripts/computer-use.mjs cancel --run-file /tmp/genie-computer-run.json
```

For custom storage, give every command the same `--state-dir`. `check` is read-only: it checks the new helper's permissions and the matching launcher's **background** mode, without capture/input. Setup readiness is not task success. The released v0.1.4 DMG alone does not include these source changes.

The native consent dialog lists specific app windows, with an unselected placeholder. Select only a test window you authorize. Consent discloses the pixel recipient, one window, up to12 inputs/5minutes, and no confirmation for each individual input. The consent dialog itself is interactive; the subsequent target operations are background-only. Keep another app frontmost. Returning to the target app causes a conservative stop, not a foreground fallback or automatic resume.

## Supported operations and boundaries

| Operation | Current behavior |
|---|---|
| Native button | AXPress on a unique, unchanged button in the selected window subtree. Window close/minimize/zoom controls excluded |
| Empty editable field | AXValue insertion into an empty AXTextArea or an AXTextField with known non-secure subrole; requires settable support and exact readback |
| Existing text | Refused; no whole-field overwrite or selection guessing |
| Password/unknown field | Secure subroles excluded. Unknown/custom text-field metadata refused. Native NSTextView legitimately omits subrole and exposes AXTextArea |
| Keys, drag, scroll, arbitrary coordinates without a supported AX element | Refused; no shared-input fallback |
| Hidden/minimized/off-Space target, ambiguous AX window match | May be unavailable; never unhide/activate to continue |
| Browser or custom-rendered controls | Not generally supported or verified; no Playwright/CDP adapter in this increment |
| Operation indicator | Brief input-transparent nonactivating “↖ Genie” marker only when the action point is visible; suppressed if the human's window covers that point. It is an annotation, not an independent OS input cursor |

The execution layer binds the consent and snapshot to bundle ID, PID, kernel process start time, window ID and bounds. Window binding uses a unique AX window rectangle; ambiguous matches stop. Each capture saves an owner-only local AX sidecar with control path, role/subrole/identifier/title, relative bounds and value hash. The action must match that pre-model snapshot, not a newly invented target. The one-shot snapshot is consumed before AX dispatch, so a timeout or uncertain action is not repeated. Identity/value checks are not an atomic lock against arbitrary third-party app changes; changed/unavailable targets stop conservatively.

A separate monitor persists activation/click/scroll takeover until session end. It observes event types/locations, never records keyboard text, and uses an expiring heartbeat. Monitoring failure or inability to record an interruption stops authority. A human can still change state in the tiny interval between verification and dispatch; arbitrary apps are not transactionally isolated. Model prompts are not a security boundary for high-risk actions. Do not use mail, payment or production consoles as initial test targets.

After dispatch, the helper checks foreground app and clipboard change count; text additionally requires exact value readback. An app can itself activate as a result of AXPress: this is reported as interference/unknown and stops, without trying to restore focus. Therefore “never calls activation/global input” is a code contract, while “the target app never steals focus” needs per-app evidence. Continuous human pointer movement is not classified as interference merely because coordinates changed.

The visual loop verifies actual before/after PNGs and performs a fresh goal check. AX return success, task acceptance, and a changed cursor/image are not task completion. Visible verification does not prove remote delivery or durable saving; use structured APIs/readback for those goals.

A verdict is read in three separate ways, because they are three different things. A **malformed** reply is not a judgement: it is re-asked up to three times with the rejection code, and nothing is executed in between. An honest **uncertain** — including a `satisfied` claimed below the confidence floor — spends the same replan budget that `not_satisfied` already had, then stops; a single "I cannot tell" from a small model no longer ends the run, which it did while the model could not read one picture being replaced by another. A **blocked** verdict is not re-asked; it stops at once. None of these can complete a run: only an in-shape `satisfied` at or above the floor does. Where the helper re-read the operated element itself and saw it change, that readback stands in for the per-action model check (`evidence: target`); the goal check is never skipped.

A screen decision must arrive while the screenshot it was made from is still current, so the local model is asked for no extended reasoning when it plans or verifies a screen action. Measured on the same window and question with `qwen3.5:9b`: 36.9 s and 1314 generated tokens with reasoning, 0.9 s and 32 tokens without, reading the same image both times (1207 against 1209 prompt tokens). The answers were not worse — the larger, slower replies chose a bare `click` with no text where the fast ones chose `type_keys "genie"`. Other work is left as it was, and cloud providers are not given this hint because their vocabulary differs and it has not been measured there.

Web text fields are offered to the model. A Chromium `<input>` reports `AXTextField` with no subrole, which an earlier rule read as "cannot tell whether this is a password field" and dropped — leaving a browser window with no text target at all, and a model guessing element ids that did not exist. Measured on a page of plain, password, search and multi-line inputs: `type=password` reports the `AXSecureTextField` subrole, `type=search` reports `AXSearchField`, and only ordinary fields report none. Inside web content, therefore, a missing subrole is not missing information, and the rule is relaxed there only. The three independent refusals of secure fields all remain, and a run asked to type into a password field left it untouched.

A screenshot older than 60 seconds is not acted on; the loop recaptures and decides again. A model that regularly takes longer than that to answer therefore never sends anything — the picture it was given is already stale by the time its decision arrives. That is reported as `model_too_slow` after the second discarded decision, rather than spending the whole budget to end on a vague stale-frame stop. Measured with `qwen3.5:9b` on a 1200x966 window: 109 s, 94 s and 74 s for three consecutive planning calls, against a 60 s window — no input could be sent at all. The freshness rule is not relaxed to accommodate a slow model; a faster model is the fix.

Keys are addressed to a process, not to a window: `SLEventPostToPid` has no window field, and the application decides which of its windows receives them. The call meant to choose that window returns success without changing it — measured on Chrome 153 / macOS 26.6.2, asking it to focus a second window of the same application left the focused window unchanged, and the characters landed in the other window. A click does move it, because a click carries the window id. So before sending keys the helper checks that the intended window is the one the application treats as focused, and refuses without sending when it is not; the planner is told to click the field first, which makes that window current.

Keys are also physical keystrokes, so an input method stands between them and the text. With a Japanese input method active in the target, `genie` arrived as `げに絵`. The value had changed, so an effect check that only asks "did it change" called that confirmed — reporting delivery of text that never arrived. The key route now requires the field to actually contain what was asked for, and stops with `background_keys_not_literal` otherwise. The input method cannot be checked beforehand: macOS keeps it per application and a query returns the frontmost application's, not the background target's — on one machine, the same moment, a native fixture received `kakiku` literally while Chrome received kana. A target that must receive literal characters has to be in an alphanumeric input mode; writing a field's value with `type` goes around the keyboard entirely, but only suits screens that read the field rather than score the typing.

`type_keys` sends one physical key press and release per character, for screens that score the typing itself rather than reading a field's value. Keys arrive at whatever the window has focused, so naming the field with `element_id` makes the host focus it first — through the accessibility attribute, not a synthetic click, and never into a secure field. Without that, a run only worked where the page happened to autofocus, and the keys silently went wherever focus already was.

The planner is also told what it has already done this run: how many inputs were sent, to which element ids, and which of those could not be confirmed. That is the host's own record, not screen content, so it sits with the instructions rather than in the untrusted block, and it carries no screen text — an element id is a position in the accessibility tree. Without it a goal phrased as a count ("click three of them") could not terminate: the model kept acting until the time ran out, because nothing in view told it how many it had already clicked.

When a run stops, its reason and the last audit rows are appended to that request's existing claim record under `ComputerRuns`. The claim itself is the replay lock and is never rewritten or removed; the appended line holds the stop code, action types and image hashes only — no screenshots and no typed text.

## Storage, recovery and cancellation

`start` saves a private run file before POST and refuses to overwrite it; it never approves automatically. `APPROVAL_SENT` and `CANCELLING` are not terminal success. Cancellation stops future input, not an undo of prior actions. `human_takeover` now pauses the run instead of ending it: the helper never touches the human, and the host waits (at most 3 times, up to 20s each) until the target app is not frontmost and 1.5s have passed since the last human input on it. Resuming always advances a **run generation**, so every screenshot taken before the interruption — and any decision still undelivered — is refused as `stale_generation` before input. An explicitly stopped session (`session_stopped`) is never resumed. Cancellation still works while waiting. A native history/stop control panel is **not implemented** by this change. See [docs/quality/MULTISTEP.md](quality/MULTISTEP.md); the runtime evidence for the pause/resume path is **not yet collected** (the native suite is blocked by a machine-level accessibility fault recorded there).

On lost acceptance, use `recover --run-file <same file>`. With an ID it uses GET; without one it repeats the original create body/key, which may retry existing PENDING workflow dispatch but cannot grant approval. Never edit the stored request/key or start a new task merely to retry an unknown mutation. The existing task API does not reject same-key/different-body requests; the client preserves the original body.

Managed host and native app share `state-dir/app/VisualContext`. New run journals stay there. Old shared-cache claims are still checked read-only, preserving replay protection across migration. PNGs/AX sidecars/consumed-snapshot files are removed on normal close; the conflict watcher exits on session close/expiry. Abrupt process death can leave cache files for existing retention cleanup. Logs/audit do not include typed text or image pixels. Screenshots remain with the pinned local model unless the separately configured custom-host external-egress path has explicit user consent; the managed launcher never selects an external model.

## Cloud models: free tier only, and never silently paid

The screenshots go to whichever model is pinned. A model outside this machine additionally needs `ASTRA_COMPUTER_VISION_EXTERNAL=on` on the agent host **and** the local consent dialog, which names the recipient before the first capture. The managed launcher never selects one for you.

A cloud model without a spending guard does not run at all: the loop stops with `budget_required` before the first capture, so there is no path where pixels leave the machine with nothing counting the cost. The guard defaults to **free tier only**:

| Setting | Default | Meaning |
| --- | --- | --- |
| `ASTRA_CLOUD_VISION_TIER` | `free` | `paid` is only ever reached by setting this by hand. Nothing upgrades on its own, and no run falls back to a different provider. |
| `ASTRA_CLOUD_VISION_BILLED_PROJECT` | unset | Set to `yes` when the key belongs to a project with billing enabled. The API cannot be asked this, so it is your declaration — and while it is `yes`, free-tier mode refuses to run rather than calling a billed key "free". |
| `ASTRA_CLOUD_VISION_TASK_CALLS` / `_MONTH_CALLS` | unset | Hard caps on model calls, checked **before** each call. |
| `ASTRA_CLOUD_VISION_TASK_USD` / `_MONTH_USD` | unset | Caps on the estimate, judged including the call about to be made. |
| `ASTRA_CLOUD_VISION_PRICE_USD` | `0` | Estimated price of one call. It is an estimate for the caps, never a bill. |

`ASTRA_CLOUD_VISION_TIER=paid` is refused unless at least one monthly cap is set: turning billing on must not also mean turning the ceiling off.

When the provider answers `429`, that is treated as the allowance being gone: the run stops, nothing is re-sent, and **the rest of that calendar month refuses before calling**. A new month starts counting again. The ledger lives beside the run journals, owner-only, and holds a month, a call count and an estimate — no key, no screenshot, no typed text, no prompt.

The ledger is not a bill. Only the provider knows what was actually charged; the caps are the local ceiling, and the `429` is the real floor. While testing on the free tier, use screens that carry no personal or confidential content — free-tier terms commonly allow the provider to use submitted data.

`scripts/computer-model-compare.mjs` runs the same goals through a local and a cloud model and reports, per model: runs completed with visual confirmation, inputs sent whose effect could not be confirmed, wall-clock seconds, model calls, and token counts costed at a price **you** supply on the command line.

## Verification and limitations

[Background acceptance and evidence](quality/BACKGROUND_COMPUTER_USE.md) distinguish native adapter tests from model-driven UI E2E and human evaluation. Run `bash scripts/test-background-computer.sh` only when two disposable fixture windows may temporarily occupy the desktop. It compiles the production adapter into a test-only harness with fixture-scoped authority; that does **not** test the real consent/model/planner loop. The target and foreground sentinel have separate structured readbacks. `GENIE_FIXTURE_PASSIVE=1` runs a different preservation-only scenario without typing into a foreground app; it does not replace the default test.

The command interface is a developer preview. Natural-language native launching, arbitrary app support, user-facing resumable pause/history, true human parallel-work trials and full Codex-equivalent behavior remain outside the verified scope. Windows requires a separate implementation and Windows-native evidence.
