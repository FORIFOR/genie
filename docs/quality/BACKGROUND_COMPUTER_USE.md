# Background Computer Use — acceptance before implementation

2026-09-19, macOS26.6.2 arm64; base28f89f2636a3b780e813ea902e07d2e4900a6e3f plus uncommitted work. Preserve the existing foreground helper and ongoing edits. New default managed computer helper must have no shared-pointer/keyboard/focus fallback.

| ID | Expected | Evidence method |
|---|---|---|
| B1 | Exact target PID/process generation/window/snapshot/AX control, background AXPress and empty-field text insertion only | Production adapter with real disposable AppKit app behind separate foreground fixture; state readback |
| B2 | Foreground app/window, cursor, clipboard and unrelated input unchanged | Before/after OS observation and separate foreground field content; human participation distinguished from automated fixture |
| B3 | User activates target => stop; unsupported/missing/changed target => no fallback | Negative cases with real fixture and route/static checks; persistent activation observer from consent until expiry |
| B4 | No duplicate ambiguous mutation; verify text readback; AXPress alone not completion | Single-use snapshot claim, same snapshot replay refusal, existing visual verifier retained |
| B5 | Mode explicit in setup, consent and status; legacy foreground never selected silently | Launcher/helper tests, docs |
| B6 | AI position indicator does not activate/consume input; stop/history visible | Native nonactivating marker if implemented; otherwise BLOCKED, no fabricated completeness |

Reference: [Cua action support](https://github.com/trycua/cua/blob/main/libs/cua-driver/docs/action-support.md), [Peekaboo background click contract](https://github.com/openclaw/Peekaboo/blob/main/docs/commands/click.md), Apple AXUIElementPerformAction. Reviewed primary docs, no source copied or external driver installed. Existing Swift adapter avoids adding an entire parallel agent/runtime. No universal app support or exact Codex equivalence claim. App-driven focus changes are detectable after dispatch, not universally preventable; production support requires per-app evidence.

UI record (scope is helper consent/indicator, no product token changes):
reference : Existing single run-consent alert; background/foreground distinction in primary driver docs.
hypothesis: Explicit background-only consent and noninteractive action marker make authority and work position understandable.
measured  : Existing helper activates target and posts global CGEvents, violating noninterference.
candidates: Keep legacy foreground helper; introduce isolated AX-only executable with no fallback.
gate      : Exact target/readback and foreground/cursor/clipboard oracles; no visual-preference claim.


## Final result (2026-09-19)

This increment is an experimental native background adapter, **not complete Codex parity**. No expectation was relaxed to mark the original combined acceptance PASS. Native tests use synthetic fixture authority, not the real consent/model/planner loop.

| Condition | Verdict | Evidence and limit |
|---|---|---|
| B1 native button / empty text field | PASS | `final-native-passive.log` / `final-native-passive-result.json`: real AppKit target click count 1, exact Japanese and emoji readback; target remained background |
| B2 foreground/pointer/clipboard preservation, passive case | PASS | Same final-source run, activation counts 0 and unchanged observed foreground/pointer/clipboard. No human typing in this scenario |
| B2 concurrent foreground input, final combined case | BLOCKED | Earlier `native-background-unfocused.log` passed automated foreground fixture input before marker changes. Final `native-background-visible-final.log` exit 1: `sentinel_not_frontmost`; did not forcibly seize focus to complete it. Real human parallel typing/IME is untested |
| B3 guarded unsupported/secure/nonempty/takeover | PASS | Final passive run rejects keys, secure input, nonempty replacement and injected persistent takeover. Earlier full run verified actual target activation. Static review verifies recorded event coordinates and fail-closed watcher writes |
| B3 actual human takeover during visible marker | BLOCKED | No final runtime evidence of click/scroll through marker and separate watcher process. Reviewer describes exact missing oracle |
| B4 duplicate/unknown mutation | PASS | Native one-shot replay refused; 30 host tests retain uncertain-result stop and independent goal verification. Readback proves in-app text, not durable document save |
| B5 explicit background default and readiness | PASS | `final-readiness.log`: actual isolated managed services ready, background delivery and permissions true; `final-managed-start.log` launcher mode; CLI tests |
| B6 full marker + stop/history experience | BLOCKED | Nonactivating transparent marker implemented, suppressed for covered targets (verified). Visible floating marker behavior remains unverified; native resumable pause/history panel absent, CLI cancellation/status available |
| Full model-driven task / natural-language native entry | BLOCKED | Not executed for new background adapter. Previous foreground attempts stopped at planner; readiness is not completion |
| Windows native behavior | NOT_APPLICABLE | This increment is macOS-only; no Windows parity claim |
| Actual-user usability evaluation | BLOCKED | No human participant study; automated native input is not a substitute |

### Commands and evidence

All commands ran from the repository root. Exact arguments, duration, exit codes and retained failures are in [commands.jsonl](evidence/2026-09-19-background/commands.jsonl); output files share the command name. `GENIE_FIXTURE_PASSIVE=1` was set for the `final-native-passive` run (the runner records argv, not environment). Earlier `native-background-passive*` runs also used that variable. Source/environment fingerprints are in `final-manifest.json`.

- `pnpm typecheck`: exit 0; TypeScript project build and test typecheck.
- `bash scripts/build-computer-helper.sh`: exit 0; both native executables and legacy self-test; legacy activation deprecation warnings remain.
- `node --test workers/agent-host/test/{background-vision,computer-vision,computer-vision-integration}.node.mjs`: exit 0; 30/30 tests.
- `node --test scripts/tests/computer-use.test.mjs scripts/tests/managed-local-preview.test.mjs`: exit 0; 19/19 tests.
- `GENIE_FIXTURE_PASSIVE=1 bash scripts/test-background-computer.sh`: exit 0, final adapter native readback and negative cases. Separate preservation scenario, no foreground typing or visible indicator proof.
- `bash scripts/test-background-computer.sh`: exit 1 on final full scenario; foreground fixture precondition failed. Earlier full PASS predates indicator and is retained as limited historical evidence.
- Actual managed launcher started with `--state-dir /tmp/genie-computer-preview-20260919 --port 43151 --model qwen3.5:9b --computer-use --no-open`; read-only `computer-use.mjs check` exit 0. Services were explicitly stopped after checking; no model task or third-party transmission performed.

[Independent review](evidence/2026-09-19-background/independent.md) found two watcher defects and an indicator hit-test risk. All received source corrections; final runtime marker coverage remains BLOCKED. The reviewer did not implement the changes or run the desktop, and its static PASS must not be read as independent runtime or user validation.

Existing foreground helper edits were preserved: relative to the start-of-increment copy only two optional frame fields and build-conditional main guards were added. Original foreground documentation remains in `docs/COMPUTER_VISION_FOREGROUND.md`. No commit, push, deployment or publication performed.

## 2026-09-20 — model-driven completion on the product path

Same machine and helper design, run through the ordinary task API (`computer.run` → agent-host → native helper) with the default 5-minute budget and no test harness. Evidence in [evidence/2026-09-20-computer](evidence/2026-09-20-computer).

| Previously BLOCKED | Now | Evidence |
|---|---|---|
| Full model-driven task | **PASS** | Task `01a0bd4b-30c8…` COMPLETED: `{"completed": true, "verification": "visual", "actions": 1, "modelCalls": 3}`, one `type` over `ax_value` into a Chrome web field, `evidence: target` plus an independent goal check. `completed-run-result.json`, `completed-field.png` |
| Visible floating marker behaviour | **PASS** | Frame captured during that run's predecessor while it acted: accent pointer over the operated field and a badge naming the operated app. `marker-during-run.png`; small-target case in `marker-small-target.png` |
| Human takeover during a visible marker | BLOCKED | Still no runtime evidence of a click or scroll through the marker |
| Concurrent human typing | BLOCKED | Unchanged; automated fixture input is not a human participant |

Four delivery defects were found by running it, each one "sent but not delivered where promised":

- **Keys went to another window of the same application.** `SLEventPostToPid` addresses a process, and the call meant to choose the window returns success without changing it (measured: asking Chrome to focus a second window left the focused window unchanged; a click does move it, because a click carries the window id). The helper now checks the intended window is the focused one before sending and refuses without sending otherwise.
- **An input method rewrote the characters.** `genie` arrived as `げに絵`; the value had changed, so an effect check that only asked "did it change" reported delivery. The key route now requires the field to contain what was asked. The input method cannot be checked in advance: it is per application, and a query returns the frontmost one — the same moment, a native fixture received `kakiku` literally while Chrome received kana.
- **Web text fields were never offered.** A Chromium `<input>` reports `AXTextField` with no subrole, which was read as "cannot tell if this is a password field" and dropped, leaving a browser window with no text target. Measured on a page of plain/password/search/multi-line inputs: password reports `AXSecureTextField`, search reports `AXSearchField`, only ordinary fields report none. Relaxed inside web content only; all three secure-field refusals remain, and a run asked to type into a password field left it untouched.
- **AXPress is ignored across Chrome, not only in page content.** Switching a tab by `AXPress` did nothing twice in a row. Chromium-family applications now take the native mouse route for clicks.

Planning latency was the reason no run could finish earlier: a decision must arrive while its screenshot is still current (60 s). With `qwen3.5:9b` on a 1200x966 window, three consecutive calls took 109 s, 94 s and 74 s, so nothing was ever sent. Asking the local model for no extended reasoning on screen decisions cut the same question from 36.9 s and 1314 generated tokens to 0.9 s and 32 tokens, reading the same image (1207 against 1209 prompt tokens); answers did not get worse. A model that stays slower than the window now stops as `model_too_slow` after the second discarded decision instead of spending the whole budget.

### Environment fault observed afterwards, not a code regression

Later the same day the native input suite began failing with `background_window_ambiguous`. `AXWindows` returns elements whose role is `AXApplication`, carrying application attributes and no position, for Chrome, for the Genie app and for a freshly launched fixture alike, while `AXIsProcessTrusted()` is true and the helper reports `accessibility: true` (`ax-window-list-degraded.log`, `native-input-suite.log`). The same binaries passed repeatedly earlier in the day, and Finder still reads correctly. Treat a run of `background_window_ambiguous` across unrelated applications as this machine-level state, not as a target-specific refusal; it needs the accessibility layer restarted rather than a code change.
