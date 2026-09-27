# Background AX independent review

Separate agent/session from implementation. Same model family, not a human evaluation. Applied independent-product-verification skill and evidence contract. This review inspects code and test oracle; it does not claim to have executed desktop actions. Revision/environment/source hashes: independent-manifest.json. Source reads through exec_command exited 0. No external transmission of repository content, installation, target input, or implementation edits.

| ID | Method / expected | Observed | Status |
|---|---|---|---|
| B1 | Static: no foreground input fallback | Background path uses AXPress or empty-field AXValue only. Target activation, shared CGEvent dispatch, clipboard mutation and focused-element writes are absent. Initial consent UI activates itself explicitly. Common legacy code remains linked but not invoked for fallback. | PASS |
| B2 | Static: observation-bound exact target | Snapshot includes element path, role/subrole/title/id/value hash/geometry, process kernel start time and window/frame identity. Unique window geometry and one matching candidate required. Current element equality checked before dispatch. | PASS |
| B3 | Static: no destructive text append mismatch | Only initially empty text values can be written; settable and post-dispatch readback required; nonempty inputs fail rather than overwrite. | PASS |
| B4 | Static: uncertain dispatch cannot replay | Exclusive per-snapshot .used marker written before AX dispatch. AX errors return unknown and runtime only replans definite pre-input stale_frame. | PASS |
| B5 | Static: persistent takeover is fail closed | interrupted() suppresses marker-write errors while watcher heartbeat continues. If marker write fails and target ceases to be frontmost, subsequent operations can miss takeover. | FAIL |
| B6 | Static: target mouse input checked at event location | Global monitor currently samples current pointer location at callback time instead of recorded event location. Callback delay plus pointer motion can miss input to target window. | FAIL |
| B7 | Native test oracle | Tests independently read disposable target/sentinel text and click counts; count activations, compare pointer/clipboard, test replay/nonempty/keys/takeover. Foreground typing is automated PID-routed fixture input, not human keyboard/IME evaluation. | PASS (oracle review only) |
| B8 | Actual native end-to-end noninterference | Not run by this reviewer; parent live execution results must supply this evidence. | BLOCKED |

Required corrections:

1. If a sticky interruption record cannot be written, invalidate monitor availability immediately rather than continuing a healthy heartbeat. Otherwise disk/permission failures become fail-open for takeover.
2. Use the actual event's captured screen coordinates for mouse/scroll classification. Do not substitute a fresh pointer sample. Handle missing/unusable event coordinates conservatively.

Remaining limits to describe honestly: AX calls may cause an application itself to activate or write clipboard; helper detects some effects after dispatch and cannot undo them safely. A 100ms postcheck does not guarantee no later application effect. No universal arbitrary-app noninterference claim is justified. Native fixture PASS establishes only its tested OS/apps/actions. Target frontmost refusal is per process, so another window of the same application also stops the session. Dedicated agent cursor is separate and not present in this reviewed file. AX value readback demonstrates target value, not a saved document or external outcome.

## Follow-up review

B5 and B6 are resolved in source: interruption-marker and heartbeat-write failures now exit the watcher, and mouse classification uses event.cgEvent.location with conservative interruption when unavailable. Static review PASS for both corrected defects; no forced disk-failure test was executed by reviewer.

Read parent evidence native-background-unfocused.log: target click count 1 and exact Japanese/emoji AXValue readback, sentinel concurrent fixture input, unchanged pointer/clipboard/foreground, and replay/nonempty/key/takeover rejection all report PASS. This is actual native adapter evidence before the indicator addition, executed by implementation session, not an independent reviewer execution or human evaluation. It does not automatically validate the later indicator revision.

New indicator interaction finding, pending verification/fix: the nonactivating input-transparent NSPanel is ordered above the target. Its window can still participate in CGWindowList ordering. The separate watch process calls Helper.topmost, which excludes only its own PID and returns false when the first layer-0 window at the event point is not the target. Therefore an input passing through the indicator can evade target takeover classification if the indicator is the top CG window. Explicitly exclude only authenticated owned indicator window IDs, or keep the indicator off the controlled surface; verify target scroll/click under a visible indicator stops the run. `ignoresMouseEvents` alone does not establish correctness of CGWindowList-based hit classification.

The indicator is a visual label, not a second OS pointer. Its visibility when the target point is covered is intentionally disabled. Broad claims of an independent cursor or arbitrary-app interference prevention remain unsupported.

## Final marker mitigation review

Read final BackgroundAX.swift: indicator now sets NSPanel.level=.floating before ordering, while Helper.topmost filters layer 0. This addresses the previously identified normal-layer marker collision by design. B5/B6 remain fixed. No additional dispatch/authorization defect found in this bounded final source review.

The new fixture assertion checks marker.level.rawValue != 0 and topmost(target), but the test creates the marker in the same process that calls Helper.topmost. That function excludes its own PID, so this particular topmost assertion alone cannot reproduce the production separate-watcher case. For complete runtime proof, query the marker's actual CGWindow layer and run the target hit-test from a different PID (or assert independently that no level-0 marker exists). Current full fixture stopped at sentinel_not_frontmost before exercising this final change; retain that safe refusal as unexecuted coverage rather than PASS. Earlier full native PASS predates marker; passive PASS predates floating.

Status: marker collision source mitigation PASS (static); final floating-marker native conflict behavior BLOCKED (no executed final oracle). There is no claim of universal product parity or arbitrary-app noninterference.

Minor presentation limit: checking only the marker anchor against target visibility does not prove its entire label rectangle avoids another window, especially at window edges; a floating panel can overlay ordinary windows while visible. The claim should remain a short-lived nonactivating, input-transparent action indicator rather than an always non-overlapping dedicated OS cursor.
