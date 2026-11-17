# First fixture exit before the second bounded order

2026-10-02 JST. `/root/computer_correctness` independently inspected only the owned simulation files, source, and macOS log restricted to PID **48254**. This investigation performed no UI action, new desktop capture, test order, or implementation edit.

The first task `01a0f857-29c3-7000-bd13-143f94e5499c` has a simulated accepted receipt at **01:44:04.841 JST**. Its saved window state at **01:44:06.097 JST** reports PID **48254**, session `c13c7082-ea50-4a19-8d47-45180f560e72`, one click, and the five-minute idle message. The shared agent-host PID 46016 had remained running since 01:38:05 JST; `main.ts` constructs its confirmation closure once.

The [owned-process log excerpt](fixture-session-exit-excerpt.log) then records:

- **01:44:36.660** — `trackMouse send action on mouseUp`.
- **01:44:36.663** — AppKit `terminate:`.
- **01:44:36.667** — normal termination completed.

The second task `01a0f85a-cce7-7000-9cab-3bff760fb025`, created around 01:44:55 JST, therefore started another fixture: PID **49129**, session `1f44b54b-da6b-447d-91f7-610259c673e9`, window state written at 01:44:58.900 JST. Its pending native consent is consistent with the requirement to select and authorize a new process/window.

The first exit occurred about 30 seconds into idle, not after the configured 300-second idle timeout. AppKit's mouse-up/normal-termination sequence is consistent with `windowWillClose` calling `NSApp.terminate`. It does **not** identify the exact control, coordinates, or actor. Root reports no intentional fixture close; this evidence does not assign one. No crash or host restart was observed in this interval, and no consent bypass or implementation change is indicated by this result.

Root's explicit cancellation of the **second** task at approximately **01:48:33 JST** is a separate test action. It must not be used to explain the earlier PID 48254 exit. The main-app same-window reuse check remains a separate follow-up; the present observation is not a successful reuse result.

Structured times, task/PID/session identity, original owned-log hash, window-file hashes, and the read-only log command are in [fixture-session-exit.json](fixture-session-exit.json).

## Separate second-order stop result

Root stopped the second task through the main-app UI around 01:48:33 JST while its new native consent was still pending. Root observed the helper dialog and fixture close. This agent subsequently checked that PID 49129 was absent, the owned second-order `receipt.json` did not exist, and its last saved window state recorded zero clicks. **Stopping future native input: PASS in this run.** No assertion of external order cancellation is made.

Root's later actual API read found the task **FAILED**, with `task.step_failed` and the message that the order result is unconfirmed and should be reconciled without resubmission. The immediate UI had said “止めました / 仕事を取り消しました”. **Persisted final CANCELLED state: FAIL in this run.** The API result is attributed to root's report; this agent did not make another authenticated API read or overwrite the task.

Static inspection identifies a cancellation race: the workflow's step-error handler only calls `finishCancelled` for the special pre-dispatch `TransactionDispatchCancelled` exception. An aborted in-flight host step instead returns an error and reaches `failWith`. The `failTask` database update permits `CANCELLING` and can replace it with `FAILED`, including when the authoritative DB stop precedes delivery of the workflow cancellation signal. A prospective fix must address both the workflow branch and persistence precedence, retain the unknown host result/business identity, and preserve replay compatibility. This investigation did not change either implementation. The result must not be recorded as an entirely successful cancellation journey.

## Later, separate reuse run

The [main-app bounded-consent rerun](MAIN_APP_BOUNDED_REUSE.md) subsequently accepted two orders with the same live PID/window/session and no second target dialog. A third request required normal approval and was declined before dispatch. These results resolve the missing main-app reuse observation for that later run. They do not erase the earlier fixture exit or verify the in-flight cancellation-race correction.

## Later, separate corrected Stop run

The later [main-app Stop run](MAIN_APP_STOP_UNKNOWN.md) persisted **CANCELLED** with the structured unknown lookup identity, zero saved fixture clicks, and no receipt. Root observed conservative warning text and disabled request reuse through read-only refresh. This scoped success does not erase the earlier failure or complete the interrupted full gate.
