# Computer Use: acceptance fixed before implementation

2026-09-19. Base revision: 28f89f2636a3b780e813ea902e07d2e4900a6e3f plus preserved working tree (evidence/2026-09-19-computer/before.json).

Scope: make the existing local macOS computer.run execution accessible from a reproducible command, without duplicating the planner or replacing the user's existing native/vision edits. The attached essay is design reference, not authority to install third-party software or transmit screenshots externally.

| ID | Environment / expected | Method / evidence |
|---|---|---|
| C1 | macOS helper: read-only permission status without capture, input, or permission prompts | Build/self-test + actual status JSON |
| C2 | CLI: persists one task identity before create; approval is explicit and separate; status/cancel never recreate work | HTTP contract tests, duplicate protection and uncertain-response recovery |
| C3 | Managed preview: local vision model, current host, explicit computer-use enablement | Health/config checks, no external model fallback |
| C4 | Isolated native test app: requested navigation or text observed after real input; model success alone insufficient | Actual native readback and loop evidence; OS permissions missing => BLOCKED |
| C5 | Existing bounds/approval/cancellation/replay safety maintained | Existing vision regressions + relevant build/typecheck |

No UI redesign, no unrestricted code execution, no automatic grants of OS permissions. Experimental macOS14.4+ preview; other OS runtime is out of scope. Commands and results appended after execution.

## Results

Environment: macOS26.6.2 arm64, installed local Ollama qwen3.5:9b (catalog reports vision), isolated managed preview `/tmp/genie-computer-preview-20260919`, gateway43151. No third-party driver installed or external model used. [Commands and exit codes](evidence/2026-09-19-computer/commands.jsonl), [independent review](evidence/2026-09-19-computer/independent.md).

- C1 PASS: helper compiled/self-test passed; actual --status exit0 reports accessibility=true, screenRecording=true. Status does not request grants/capture/input. Existing TCC grants were used.
- C2 PASS for tested command contract: CLI6 + managed preview13 tests passed (exit0). Actual start returns PENDING, status returns WAITING_APPROVAL and exact summary, explicit approve returns APPROVAL_SENT. Neither is labelled complete. No automatic approval or retry. `recover` without task ID is an explicit same-key POST, not GET-only; existing server may retry PENDING dispatch. Same-key/different-body conflict rejection is not claimed.
- C3 PASS for local setup: real launcher reports computerUse=true, model qwen3.5:9b, permissions ready. Initial check failed because `/tmp` and `/private/tmp` hashed to different control ports; fixed canonical realpath, rerun exit0. Setup readiness does not prove operation success.
- C4 FAIL: two actual approved local-model tasks ended `computer.vision.planner_stopped`; test button state change has not been confirmed. Task IDs `01a0b957-84fb-7000-8e87-fa94711aefe1`, `01a0b959-0a44-7000-a8a7-c6776c10c812`. The native target consent dialog was observed, but the operator could not establish that the intended disposable test app was selected before the dialog closed. The second run’s native consent filename records PID42652; read-only process lookup identifies Google Chrome, not the dedicated test app. This explains the target mismatch but does not establish the planner’s reasoning. Do not infer success on the intended app. No native readback file appeared. Asked user for target-selection cooperation; do not bypass consent to manufacture success. Further interactive verification BLOCKED pending this cooperation.
- C5 PASS for automated scope: actual build/typecheck exit0; vision24 passed; task71 passed/25 skipped, exit0. Unit/fixture tests do not replace C4. Separate reviewer found no blocking defect in the command-entry changes. Existing user native/vision logic was preserved apart from the isolated --status addition; documentation is appended. A further managed-preview bug was fixed: host ASTRA_DATA_ROOT now matches the native app at state-dir/app, instead of using the ordinary shared VisualContext cache. A regression assertion checks this location.

The product now has a runnable command entry point with approval/status/cancel/recover, but end-to-end computer operation is **not yet verified successful** in this turn. This is an experimental developer preview, not a claim of unrestricted automation or Codex Computer Use equivalence. The attached document did not authorize copying a proprietary runtime or changing system permissions.


Final follow-up: independent review found a storage-migration replay risk. NativeVisionDevice now also checks the old shared-cache claim for the same request hash, refuses it fail-closed, and never deletes old journal entries. A temporary-HOME regression creates an old claim then moves storage and verifies rejection, while a fresh request succeeds. Vision integration4 PASS and final typecheck exit0. Final scripted total: CLI/preview19 + vision24 + integration4 + task71 PASS, task25 SKIP (suites have distinct scope; no real-model success implied). The temporary launcher and test app were stopped after verification; saved preview/run files were retained. No user services were stopped.
