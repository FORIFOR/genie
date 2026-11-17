# Computer use pointer — 2026-10-01

reference : Apple [pointer accessibility](https://support.apple.com/en-gb/guide/mac-help/mchlp2920/26/mac/26) — size and separate outline/fill make a pointer easier to find; Apple [Motion](https://developer.apple.com/design/human-interface-guidelines/motion?changes=l_9_3) — brief purposeful feedback must be optional and must not delay interaction (retrieved 2026-10-01). User request: background operation must have a conspicuous visible mouse.
hypothesis: Give Genie a distinct blue 48 pt arrow whose tip is the exact action point, with a readable app/state badge, to distinguish automated background activity from the person's mouse without taking focus or intercepting clicks.
measured  : Current Marker path spans 40.8 pt vertically, its tip is 22.1 pt above the action point, hard-coded purple (#5B4CF0 / #8A7DFF) differs from current blue tokens, and 14 × 25 ms synchronous movement delays dispatch; the badge only names the app and is positioned against the primary screen.
candidates: A = current 40.8 pt purple arrow / single-line app badge / 350 ms blocking movement; B = 48 pt blue arrow / app plus state in two lines / exact tip / 180 ms nonblocking movement (immediate with Reduce Motion) / screen-local badge; C = B with 64 pt arrow. B is the implementation candidate; C is larger than needed to fix the observed tip, state and visibility failures. Dimensions are Genie-specific hypotheses, not copied Apple values.
gate      : 1. Native fixture checks exact tip, monitor-edge badge containment, overlay click-through/nonactivation, system-pointer and foreground preservation, repeated update reuse, and no blocking travel; token freshness and helper compilation. 2. Open light/dark/covered/paused fixture PNGs and obtain independent inspection. 3. Save reviewed PNGs under docs/golden-screenshots/computer-pointer and geometry JSON; full verify-all is required before any commit.

The frozen Dock and main app surfaces are unchanged. This round concerns the user-requested background pointer and its status meaning. No shadows, gradients, progress percentages or permanent oscillation are introduced.

## Verification

Implementation based on `ee857a5b13482cbd2d986a1f9b466c8e49a149c3` plus the current uncommitted computer-use changes; macOS 27.0.1 (26A434), 2026-10-01. The generated `PointerMetrics` subset uses the same token source as the main app. Stop control size 88 × 32 pt is generated for the watcher-owned control; it is separate from the pointer's fully passive input area.

| Check | Result | Evidence |
| --- | --- | --- |
| Token freshness | PASS | `pnpm -s gen:design-tokens --check`, exit 0 |
| Helper frontend compilation/self-test | PASS | `scripts/build-computer-helper.sh` frontend phase: `GENIE_COMPUTER_SELF_TEST_OK`; full background integration is verified by the root task |
| Pure geometry across four simulated displays/eight points | PASS | [`geometry.json`](../../../golden-screenshots/computer-pointer/geometry.json): tip error 0 pt, height 48 pt, badges entirely on target display, left/above/right/below/edge positions |
| Generated-color contrast | PASS | Arrow fill versus white outline 5.48:1; badge text versus background 15.82:1. Fixture gate requires at least 3:1 / 4.5:1 respectively. |
| Passive native overlay | PASS | `bash scripts/test-computer-pointer.sh docs/golden-screenshots/computer-pointer --native`, exit 0: non-key/non-main, ignoresMouseEvents and nil hitTest, same panel reused, system pointer and foreground preserved, nonblocking update, animation arrives at exact target |
| Visual self-review | PASS | Opened [`light.png`](../../../golden-screenshots/computer-pointer/light.png), [`dark.png`](../../../golden-screenshots/computer-pointer/dark.png), [`covered.png`](../../../golden-screenshots/computer-pointer/covered.png), [`paused.png`](../../../golden-screenshots/computer-pointer/paused.png): arrow has visible blue/white/dark boundaries, readable two-line app/state badge, no clipped text, no target outline over the unrelated foreground app |
| Independent visual review | PASS for rendered fixtures | Separate verification agent opened all four PNGs and observed legible two-line app/state, clear blue/white/dark pointer edges, no clipping, and covered/paused target ring suppression with explicit 背面 wording. No motion, action-delivery, physical-display or human-usability claim follows from that review. |
| OS Reduce Motion preference | IMPLEMENTED; live setting toggle not tested | `NSWorkspace.shared.accessibilityDisplayShouldReduceMotion` makes placement immediate. Native test exercised explicit animation-off placement; it did not change the user's system preference. |
| Physical multiple monitors / human usability | NOT TESTED | Geometry cases simulate display layouts; native overlay ran on the available desktop. No human panel has evaluated it. |

Rendered fixtures are synthetic visual states, not evidence of successful external application work. The native click-through evidence is configuration and view hit-testing, not an injected click into the user's current app. Full `verify-all.sh` remains the parent task's integration gate before any commit; this agent made no commit or push.
