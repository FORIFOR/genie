# Actual managed-app SIGTERM hang

2026-10-02 JST. **FAIL / P1:** root stopped the dedicated preview to prioritize streaming, but the native app PID 85691 remained for more than 50 seconds after SIGTERM. Services and the owned Colima VM stopped. The previous source-only review and 74 passing focused tests are retained; they did not exercise the actual AppKit signal / `terminateLater` scheduling path and do not establish successful native shutdown.

This is root-executed runtime evidence with independent read-only review by `/root/verification_audit`. The reviewer did not run an app, build, test, model, or stop command. Original evidence and hashes are in [termination-hang-review.json](termination-hang-review.json).

| ID | Method / expected | Observed | Status |
| --- | --- | --- | --- |
| TERM-1 | Stop the managed native app using its owned SIGTERM path | PID 85691 stayed alive beyond 50 seconds. The [03:06:25 JST sample](termination-hang.sample.txt) places all 867 main-thread samples inside main dispatch source → `GenieAppDelegate` signal callback → `NSApplication.terminate` → `_shouldTerminate` → nested AppKit run loop | FAIL / P1, actual native shutdown |
| TERM-2 | Explain the wait using sample and reviewed source | The sampled dispatch callback entered `terminateLater` while cleanup and reply were queued in a `Task @MainActor`. That serial main-dispatch callback had not returned | Source-supported cause: the nested loop prevents the queued cleanup from draining. The stack directly establishes the nested wait; task starvation is the code-based inference |
| TERM-3 | Recover only the verified owned process | Root waited, rechecked exact PID/argv ownership, then sent SIGKILL only to app PID 85691. Around 03:08 JST root reported all owned preview app/service/VM PIDs absent, pressure 1 and free memory 44% | PASS, attributed scoped recovery; saved Codex / gpt-6-sol settings remain unchanged |
| MEM-6 | Check the user's pressure report against saved sampling | [Noa's local observation](noa-start-memory-warm-observation.json) contains nine samples from 02:58:39.355 through 02:59:19.409 JST, all pressure 2, free memory 38–42% | PASS for confirming a real warning interval; cause and streaming-crash attribution remain unproven |

The Noa-side `qwen3.5:9b` model, reported at about 5.5 GB during recovery, was not touched. Earlier “Ollama empty” and running-preview snapshots apply to their recorded instants only. The current Genie preview is stopped; the external model preference is preserved.

The implementation owner is preparing a narrow fix that leaves the signal dispatch callback before calling AppKit termination, runs async cleanup outside the main actor, and returns the termination reply through the main run loop. A small standalone AppKit harness is intended to exercise the scheduling edge without rebuilding the main product. Source review and any harness results will be appended separately; no correction or deployment PASS is asserted here. Full-product verification remains incomplete.

Root then saved a [45-second post-stop sequence](stream-priority-after-stop.json), 03:10:07.968–03:10:53.278 JST. All ten samples report pressure 1, free memory 45–46%, and no owned PIDs remaining. The reviewer read and hashed the complete sequence. Pressure had already returned to normal before Genie was stopped, so this does not establish that the stop caused the recovery. Genie remains stopped, its external `gpt-6-sol` configuration is saved, and the Noa model was left loaded.

## Narrow correction and AppKit regression

The implementation owner added `TerminationDispatch`: the signal handler schedules termination through the main run loop after the serial dispatch callback returns; cleanup runs in a detached task, and its reply also uses the run loop. The reviewer independently read the helper, AppDelegate integration, harness, and script and found no additional P1. The selftest/native-messaging exclusions and ordinary recording confirmation remain intact. Final reviewed hashes are in [appkit-termination-regression.json](appkit-termination-regression.json).

Root ran `bash scripts/test-app-termination.sh` with reported exit 0. The script compiles the actual production helper into a small AppKit harness with no windows, model, or full application build. The complete [log](appkit-termination-regression.log) shows four passing cases:

| Case | Observed result |
| --- | --- |
| Legacy negative control | Old direct-dispatch termination plus `Task @MainActor` reproduces the timeout; cleanup never starts. This PASS means the expected old defect was reproduced |
| Scheduled termination | Dispatch returns before AppKit termination; MainActor cleanup, reply, and final termination complete in order |
| Direct caller | Detached cleanup and run-loop reply complete even when termination began in a main-dispatch callback. This case deliberately has no MainActor-dependent cleanup, matching production Codex shutdown |
| Actual self-SIGTERM | The harness signals only itself and completes the scheduled handoff, MainActor cleanup, reply, and termination |

Root reported pressure 1 and free memory 46% immediately afterward. This is a narrow native scheduling regression, **not** a rebuilt/restarted Genie E2E result. The original app failure remains recorded; the old packaged app is stopped, and the corrected product source has not been packaged or launched. Full-product verification remains incomplete.

## Launcher termination confirmation

The launcher source now waits up to 10 seconds after TERM, rechecks the exact PID/start-time/argv before any KILL, and confirms disappearance for up to two more seconds. Inspection, identity, signal, or final-exit failures remain failures while other cleanup continues; escalation is disclosed. This is additional containment, separate from the AppKit deadlock correction.

[Lightweight Node tests](launcher-stop-node.log) passed **32/32, zero skips**, including real tiny-child normal exit and TERM resistance, plus mocked timeout, denied inspection/signal, and PID/start/argv reuse. No Genie, VM, model, or full build was run. Root read the final source and log without finding another issue, and reports a successful self-PID identity probe on macOS. [Source hashes and scope](launcher-stop-node.json) and [SHA-256](launcher-stop-node.json.sha256) are preserved. The already stopped packaged app was not rebuilt or relaunched; the original native failure and incomplete full-product gate remain recorded.
