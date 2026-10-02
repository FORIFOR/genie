# Background Computer Use completion work

2026-10-02 JST. Owner: `/root/computer_correctness`. Existing uncommitted work is preserved. At the start of this work, the main app and dedicated VM were stopped. Root coordinates subsequent runtime startup separately. This work does not execute live orders, payments, securities trades, or change the generic Computer Use confirmation boundary.

## Fixed scope and acceptance

| ID | Code-observed gap | Acceptance / verification |
| --- | --- | --- |
| CU-A | Background `type` only accepts an empty field; physical-key fallback has ASCII/IME limits | Explicit `textMode: append` preserves the entire current native value, adds only requested text, and remains bound to the captured value hash, actual field preview, authority, epoch and expiry. Omitted mode still refuses nonempty fields; unknown/foreground modes reject. Pure Swift value construction and host contract regressions; native application integration separately marked until executed |
| CU-B | Native snapshots retain all eligible elements, but only the first 60 are published. Coordinate preview can resolve an eligible field beyond that list, then host incorrectly rejects its identity | Native preview attests resolved text role; host validates source frame/hash, text role, element identity and requested point contained by the exact resolved crop. Unlisted canonical target is allowed only after read-only native grounding; named stale targets and nontext targets remain refused. Mock device/runtime tests; no real website claim |
| CU-C | Scroll and drag are explicitly unsupported | Investigate a bounded background scrolling route; do not enable it before delivery and interruption behavior can be verified on an owned native fixture. Real browser/site support remains unverified |

The existing 60-candidate context cap remains in place to bound model input. This is not a claim of unlimited accessibility-tree or website support. Model semantic verification remains probabilistic; native authority and identity checks remain mandatory. The former false-positive target-verification evidence is retained in the previous evidence directory.

## Execution status

The initial lightweight checkpoint below was recorded before native runs. Later results are appended separately; neither checkpoint establishes real-site support or a full product completion gate.

## Lightweight verification

- Isolated strict compilation of the three changed host modules: PASS. This does not build the full workspace.
- Model/device mock and background source-boundary checks: **82/82 PASS**, zero skips. The new regressions cover append mode through target verification and delivery, rejection of replacement/foreground mode, the 61st canonical native target without enlarging model context, and refusal of changed identity/nontext role/outside-crop proposals.
- Foundation-only production value policy: **11 cases PASS**. Existing Unicode/newlines are preserved, only new single-field text is appended, and default nonempty writes, replacement, control characters and UTF-16 size overflow reject. No AppKit application or input was started.
- At this initial checkpoint, native append integration and the production helper build were **NOT RUN**. Their subsequent execution is recorded below; the original manifest is retained unchanged.

[Commands, source hashes and limitations](computer-use-contracts.json), [host log](computer-completion-node.log), [native pure-policy log](computer-text-edit-pure.log). Fixture/mock success is not real website success.

## Initial scroll design investigation — before implementation

Apple documents [AXScrollArea](https://developer.apple.com/documentation/applicationservices/kaxscrollarearole) as the accessibility role for scroll-managed data and [AXVerticalScrollBar](https://developer.apple.com/documentation/applicationservices/kaxverticalscrollbarattribute) as a way to locate its vertical control. This supports a first choice of a native AX scroll-bar operation when the selected window exposes one. It does not establish that Chromium or any merchant site exposes or honors such an operation.

Apple also exposes a [pixel/line scroll event constructor](https://developer.apple.com/documentation/coregraphics/cgevent/init(scrollwheelevent2source:units:wheelcount:wheel1:wheel2:wheel3:)). A fallback would need a new explicitly scoped `PrivateSPI.postScroll` delivery route; event creation alone does not prove background delivery to the intended window. The existing mouse/key bridge cannot simply be relabeled as verified scrolling.

Proposed bounded contract: one visible, native-grounded scroll area, one axis, a distance capped to a fraction of its viewport per action; no inertia or gesture sequence, no global event-post fallback. Recheck target process/window generation, consent, display lease, epoch and expiry immediately before the single dispatch. Mark attempted scroll before observing; any post-dispatch error remains unknown, never an automatic alternate-route resend. Verify the actual target offset/content change and unchanged sentinel offset, foreground, shared pointer and clipboard in an owned native fixture before exposing the action to a model. Repeat on an owned browser fixture before claiming browser support. Actual merchant pages remain a separate, read-only/product-flow validation scope.

## Subsequent native and candidate verification

Implementation verification: the owned passive AX fixture passed twice with `GENIE_FIXTURE_PASSIVE=1 GENIE_NO_PRIVATE_SPI=1`. The final run appended ` + 追記` to the exact existing Unicode value, refused a stale replay, and preserved the sentinel text/click count, foreground app, system pointer and clipboard. Secure-field and read-only target-preview checks passed. The target and sentinel reported zero activations. These runs use the fixture's test-created grant; they do not establish production consent or browser delivery.

The final regression changes the field 150 ms after preview while the helper is in its 300 ms marker delay. Delivery returned `target_changed`, and native readback retained exactly `fixture concurrent edit preserved`. A further identity/value check now runs immediately before the AX setter. AX offers no atomic compare-and-set, so a concurrent change in the interval between that check and the write remains a limitation. Human takeover in this run uses an injected sticky marker, not live human typing.

The final isolated host compile and regressions passed **82/82**, zero skips. The production candidate was built with `-j 1 -O -D GENIE_BACKGROUND -D GENIE_PRIVATE_SPI`, signed as `com.genie.computer-helper-preview` with Apple Development, and passed strict signature verification. It lives at `/private/tmp/genie-transactions-20261002/GenieComputerHelperCompletion.app`; the existing Blue helper was not overwritten. Its own status reports ready, Accessibility and Screen Recording true, `deliveryMode: background`, `unattendedTest: false`, and `append_text_field`. This is build/status verification only. Root owns normal app/consent E2E separately.

[Later commands, exact hashes and limitations](computer-use-native.json), [native readback](computer-native-append-race-result.json), [native run log](computer-native-append-race.log), [final host log](computer-completion-node-final.log). The historical lightweight evidence and prior failed target-verification evidence remain preserved. No live transaction, browser/site/model append, scrolling or full workspace gate is claimed here.

Independent source review: `/root/verification_audit` re-read the final setter-adjacent comparison and race regression and reported no additional finding. The reviewer did not rerun tests or inspect a live target; execution results above remain implementation verification.

## CU-C implementation acceptance — vertical AX scroll (NOT RUN)

The next bounded action is background `scroll` with direction `up` or `down`, navigation risk only, one half-viewport at most. It requires a native-resolved visible AXScrollArea, its owned vertical scrollbar with a finite normalized value and writable AXValue, and exactly one stable full-content geometry. No wheel/private-SPI fallback is added. Horizontal/unknown/custom/virtualized geometry remains unsupported. The existing model target preview must approve the exact area before dispatch.

Acceptance: snapshot, post-marker and setter-adjacent checks bind area/content/bar identity, geometry and position; edge/no-op is refused before dispatch; native readback must show both the requested scrollbar value and the corresponding same-content origin movement, with viewport/horizontal position unchanged. Any failure after the setter is unknown and never retried. Existing consent, expiry, generation, human interruption, attempt-before-write, action budget and foreground/pointer/clipboard preservation remain required. Owned passive native fixtures must verify down/up, boundary refusal, stale/concurrent mutation refusal and unchanged sentinel. Browser evidence is separate. No native/Swift run has occurred for this extension yet.

### Scroll implementation checkpoints (not the final candidate)

- Host strict isolated compilation (including NativeVisionDevice): PASS; model/device contract regressions **86/86 PASS**, and real child-process fake-helper receipt tests **4/4 PASS**. These are mocks, not a model or native browser run.
- Foundation-only numeric scroll policy: **14/14 PASS**.
- Native round 1: FAIL with `stale_frame` in the existing append-race portion before any scroll dispatch. This was not reproduced in the next two runs; its cause remains unresolved and the log is retained. No stale-frame comparison was weakened.
- Native round 2: FAIL before scroll dispatch because standard AppKit NSScroller omits AXMinValue/AXMaxValue and reports a one-point outer decoration beyond the parent area. The implementation now accepts absent optional bounds only with finite normalized value plus document-offset equality; present bounds must still be 0/1. It allows at most 2pt of scrollbar decoration while preserving exact parent-child/PID/window ownership.
- Native round 3: PASS on owned passive fixtures, with private SPI disabled. Down moved exactly **95pt / 190pt viewport**, up returned to the initial offset, and endpoint/replay/concurrent-change attempts refused. A fixture change after actual dispatch returned `input_effect_unconfirmed` with the attempt record retained. Sentinel stayed at offset 0 with no text/click change; both apps had zero activations; foreground/system pointer/clipboard remained unchanged. This run precedes the later independent-review fix binding the exact held AX scrollbar/content objects, so it is not unconditional evidence for the final candidate.

[Round 1 failure](computer-scroll-native-round1.log), [round 2 diagnosed unsupported geometry](computer-scroll-native-round2.log), [round 3 log](computer-scroll-native-round3.log), [round 3 numeric/native readback](computer-scroll-native-round3-result.json). No production consent, Safari/browser or actual transaction was exercised. The replacement-object regression and later final evidence will be appended separately.

### Final scroll fixture candidate

The later independent review found that a retained AX scrollbar reference could outlive an identically described replacement. The setter now re-resolves the area and current vertical bar/direct children, checks exact AX object equality for area/bar/content, and sends only to that freshly checked bar. Readback repeats object identity checks. The fixture retains the detached old control and replaces it during the marker delay; input is refused while the current position stays at 0.6. Its attempt record proves the earlier structural/fingerprint comparison passed before the final exact-object guard refused dispatch. AX still has no atomic compare-and-set.

The final passive, no-private-SPI native regression **PASS** includes this replacement case and all prior append/scroll protections. Source review by `/root/verification_audit` confirmed the reported stale-reference fix; it did not independently execute the tests. [Final source/log hashes and limitations](computer-scroll.json), [native readback](computer-scroll-native-final-result.json), [final native log](computer-scroll-native-final.log).

This completes the bounded vertical AX fixture implementation, not general browser scrolling or production consent E2E. The earlier failures remain above. A new signed production scroll helper has not yet been built; the existing append Completion helper was not overwritten.

## CU-D bounded Safari link navigation acceptance (implementation, native NOT RUN)

The proposed native route supports Safari AXLink elements advertising AXPress, with enabled state, a captured HTTP(S) destination and a different current document URL of the same origin. Both URL hashes are bound to the snapshot. Before pressing, resolve the same AX element again and recheck identity, consent, epoch, expiry and source document. A post-dispatch failure is unknown with no mouse fallback/retry. The selected window must expose exactly one top-level WebArea, and its document URL must become the captured destination within a bounded read-only wait. Model goal verification remains separate. Cross-origin, unchanged-URL, iframe and non-HTTP links are outside this new route.

Apple explicitly states that [`accessibilityPerformPress`](https://developer.apple.com/documentation/appkit/nsaccessibilityprotocol/accessibilityperformpress%28%29) reports triggering, not successful completion; [`AXURL`](https://developer.apple.com/documentation/applicationservices/kaxurlattribute) provides the document location. These APIs support the proposed readback but do not establish Safari background behavior without an actual run.

The owned WebKit fixture uses a nonpersistent data store, a loopback-only server and two static pages, plus a passive sentinel. It must reject forbidden same-page/cross-origin links before dispatch, navigate the allowed link exactly once, show the second page URL/title, refuse replay and preserve foreground/cursor/clipboard/sentinel. A test-build-only fixture bundle exercises the same route; actual Safari production consent and public-site navigation will be performed separately by root. No login, address, shopping cart, payment or order action is included.

### WebKit fixture and combined final candidate verification

Implementation verification: the initial and final owned WebKit runs **PASS**. Both `/first` and `/second` received exactly one HTTP request. Cross-origin and unchanged-URL links refused before an attempt was recorded. The valid link used one `ax_web_link` press and the selected window reached the exact captured destination. Target and sentinel activations remained 0; sentinel text/click count, foreground app, real pointer and clipboard remained unchanged. Old-frame replay refused.

The final run adds a same-origin link whose navigation the fixture deliberately cancels after AXPress. The helper returned `input_effect_unconfirmed`, retained the attempt marker and refused a replay; the fixture observed exactly one blocked navigation. The test then captured a new frame and tested a different, valid link. That independent test action is not production retry behavior: the host runtime ends an unknown operation without automatic resend.

The production origin check concerns the captured href before pressing. It does **not** prevent server redirects or JavaScript side effects. URL equality confirms navigation only, not page load or order completion. `/root/verification_audit` independently read the native route and initial results and found no new P1; it did not execute the tests. Actual Safari with normal consent and a public page remains a separate root-owned check. Nested iframe and changed-href native negatives have not been executed.

Foundation URL policy **19/19 PASS** and strict isolated TypeScript compile **PASS**; host/device regressions **90/90 PASS**, zero skips. Latest combined Safari/scroll/append source also passed the complete passive AppKit regression, including bar replacement, concurrent-value refusal, post-dispatch unknown and sentinel protection. Earlier failures and candidate evidence remain preserved above.

The new signed production candidate is `/private/tmp/genie-transactions-20261002/GenieComputerHelperFinal.app`, with the same `com.genie.computer-helper-preview` identity and Apple Development certificate. Compilation used `-j 1 -O -D GENIE_BACKGROUND -D GENIE_PRIVATE_SPI`, with no test or unattended flags. Strict signature verification and its own status passed; status reports ready, Accessibility/Screen Recording true, background mode, `unattendedTest: false`, `vertical_ax_scroll` and `safari_same_origin_link`. The old Blue and append Completion bundles were preserved. Build/status is not a production input test.

[Exact commands, source/artifact hashes and limits](computer-web.json), [final WebKit readback](computer-web-native-final-result.json), [WebKit log](computer-web-native-final.log), [combined AppKit readback](computer-scroll-web-combined-result.json), [combined AppKit log](computer-scroll-web-combined-native.log), [host tests](computer-web-node-final.log), [candidate status](computer-final-helper-status.json). No real transaction or full workspace gate is claimed by this subtask.

### Later Safari availability diagnosis — metadata only

Root reported that the production picker listed no Safari window during the attempted public-page check. A later authorized read-only diagnostic sampled Safari at **2026-10-02 05:12:32 JST**. Its existing screen-capture preflight was true. Safari PID 662 was regular, not hidden, and not active. Both CoreGraphics and ScreenCaptureKit returned **0 onscreen Safari windows**; their all-window queries agreed on 8 Safari window IDs, each marked offscreen. The main-sized window was ID 92 at (0,33), 1728×1084. This supports the picker’s onscreen filter as the immediate exclusion at the sampled time; it does not identify another Space, minimization or a specific WindowServer cause.

The tiny separate CLI compiled with `-j 1` and ran once in under one second. It did not request OS permission, create or activate a window, change Space, use AX actions, capture pixels, or perform input. Persisted fields are limited to Safari numeric/boolean process/window metadata and diagnostic status. No title, URL, AX tree, image, other-app window metadata or runtime stderr was saved. If its preflight were false, source returns NOT_RUN before CG/SC enumeration; that negative path was not executed here.

This is a **different executable/caller and a later sample** than the signed Final picker. It does not prove the reported IDs include the earlier attempted private window. There is no new evidence of successful real Safari navigation, and production filters were not relaxed. [Diagnostic source, commands and hashes](safari-window-metadata/manifest.json), [minimal observed metadata](safari-window-metadata/result.json).

Follow-up UX candidates remain unimplemented: distinguish unavailable target windows from permission readiness, show refresh errors instead of silently retaining an old list, and guide the user to make a normal target window available on the current desktop. Such guidance must not automatically unhide applications, move Spaces, or broaden capture/input authority. Duplicate destination URLs are not generally rejected: target ambiguity is resolved by the captured element ID or exact point, while the selected window must have one top-level WebArea.

### Offscreen capture investigation — two pre-capture failures retained

Apple's [WWDC22 single-window capture explanation](https://developer.apple.com/videos/play/wwdc2022/10155/) describes full-content capture as independent of display and Space, including completely offscreen windows, while minimized windows pause stream output. This supports investigating an explicit offscreen capture contract; it does not establish our current single-shot screenshot path, input delivery, or app-specific behavior.

Root authorized a tiny owned synthetic-window PoC, with existing screen permission only, memory-pressure gating, serial `-j 1` compilation and a short process timeout. Both attempts **failed before capture**. Round 1 combined window-presence and `onScreen == false` in its guard. Round 2 added numeric/boolean metadata to distinguish those conditions without relaxing that guard. The generated 400×260 panel at AppKit (2728,150) was outside the single 1728×1117 display. NSWindow, CoreGraphics and ScreenCaptureKit geometry agreed, but CG `onScreen` and SC `isOnScreen` were both **true**. The window existed; the OS flag classified it differently from its geometric intersection.

Both failures remain failures. There were **zero capture calls and zero images**; A→B pixel freshness was not tested. Other-Space, minimized/hidden, production consent and real Safari behavior remain unverified. The earlier guards returned before the PoC's final foreground/cursor/clipboard comparisons, so those comparisons also did not run. Code contains no app-activation or global-input call, and its own temporary window closed before process exit. Memory pressure was normal (1) before and after each attempt. Production source/helper and personal windows were unchanged.

Sources remain in the private temporary directory as requested. [Source hashes, run classification and limits](offscreen-capture-poc/manifest.json), [initial failure](offscreen-capture-poc/result-round1.json), [classification metadata](offscreen-capture-poc/result-round2.json). A future test must explicitly distinguish geometric offscreen from OS-offscreen/another Space; these pre-capture failures do not prove capture is impossible.
