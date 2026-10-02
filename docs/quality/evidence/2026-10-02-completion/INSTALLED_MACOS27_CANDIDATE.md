# Installed macOS 27 candidate — capture and baseline decision packet

2026-10-02 05:45–05:47 JST. Capture owner: `/root/pointer_ui`; independent review requested from `/root/verification_audit`. **Profile not adopted.** Product source, user defaults, OS grants and existing golden references were not changed by this capture/review round.

## Candidate and isolation

The actual installed `/Applications/Genie.app` (`com.astra.mac`, executable `Genie`, SHA-256 `2880bc06f89e4a468d8c9c2981fc2916b87265ee0868cedce86fe1348fa3d74e`) was launched through LaunchServices. Each of geometry, light and dark had a distinct empty `ASTRA_DATA_ROOT`; cloud STT was disabled in the argument domain and again by `SelfTest.run`. Selftest dispatch precedes ordinary app startup. Settings fixtures use an unconfigured suite and do not read provider keys. The recording views use synthetic state and the shots recording uses `captureMic: false, transcribe: false, requestPermissions: false`. The existing screenshot path filters to the app's own PID/window. No production meeting or connected-provider data was used.

[The evidence directory](installed-macos27-candidate/manifest.json) retains all **32 original PNGs**, six raw AX snapshots, capture-layout, stdout/stderr, exact invocation, exit receipts and source/image hashes. The launcher wrapper is retained there too. All three LaunchServices calls returned 0, all app receipts returned 0, and each post-exit check found no `Genie`/`GenieMac` process. The test app self-exited; no forced cleanup was needed. The native slot was then returned to root.

Unlike the rejected in-process public-getter experiment, the installed identity's existing AX permission allowed the production system AX traversal to retrieve real controls and text. No new permission was granted. Raw snapshots include system/menu identifiers; these are retained but do not count toward required content coverage.

## Six-state geometry and unchanged tolerance

[Coverage](installed-macos27-candidate/geometry/coverage.json) names **43 required occurrences** across six states: containers, controls and static text, all present with positive measured width/height. This is a named coverage set, not a claim that all 43 are buttons or every possible control has been tested. The snapshot's `recordingWorkspace` identifier resolves to its 34×14pt title; the separate native window key supplies the real 1080×680pt window size. AX content frames do not establish the entire mouse hit area or enabled/action behavior.

| State | Raw keys | Required occurrences | Examples |
| --- | ---: | ---: | --- |
| Idle | 66 | 4/4 | `dockOpenActions`, `dockStartRecording` |
| Listening | 68 | 6/6 | input field, submit, mute, `esc` text |
| Agent task | 75 | 8/8 | stop/open workspace, three steps, task title |
| Meeting | 70 | 8/8 | notes/captions/ask, pause/stop, Google Meet text |
| Meeting notes | 82 | 8/8 | note body, detach, four section labels |
| Workspace | 100 | 9/9 | original/translation, four note labels, transcript text |

The [comparison with the accepted 26.6.2 safe-top-32 profile](installed-macos27-candidate/geometry/baseline-comparison.json) uses the existing **max absolute x/y/w/h delta ≤2pt** rule without coordinate normalization. Of 43 required occurrences, 37 exist in that older reference: 30 are within 2pt, seven exceed it, and six are new identifiers. Missing old keys are not counted as matches.

The seven changed required occurrences have concrete source explanations:

- `dockOpenActions` grows from 62×19pt at (21,44.5) to 66×44pt at (20,32). Current `IdleDock` deliberately gives the label infinite available height and a rectangular content shape. The idle native window stays 220×76pt and record button remains 48×32pt. This is a source/accessibility-frame change, not an OS-only claim; acceptance should explicitly preserve the expanded action area.
- Agent `voiceHUD`, three step indicators, stop and open-workspace shift/contract by 35pt. The native agent window is 720×294pt versus 720×329pt. `agentProgress` and `text:PLAN` disappear. [Presence-mark round 2](../../../ux-benchmark/compare/presence-mark/ROUND.md) records removal of progress/PLAN, and [continuous-surface](../../../ux-benchmark/compare/continuous-surface/ROUND.md) already records this exact 35pt reduction. The remaining required labels and button sizes agree.
- The six added identifiers are `dockIdle`, `dockListening`, `dockListeningInputField`, `dockSubmitInput`, `dockToggleMute`, `dockAgent`. Listening's former static partial text is now an input field. These are explicitly reported as new coverage, not silently dropped reference checks.

The current candidate was measured once. Recording it is capture success, **not** a separate later geometry-comparison PASS. A repeat against the proposed candidate at the same 2pt threshold is still needed before adoption.

## Image candidate list and differences

The current native golden contract compares ten stable images per appearance: `01-voice-hud-idle`, `02-voice-hud-listening`, `02b-voice-hud-preparing`, `03-recording-workspace`, `04-recording-transcript`, `05-recording-rag`, `08-meeting-detail`, `09-permission-denied`, `10-agent-timeline`, `11-meeting-canvas`. These **20 images** are the proposed profile set. The other 12 fresh images cover paused, Home, Apps, recording-now and two additional failure states as supporting evidence; they do not silently expand or weaken the golden contract.

| HUD | Old root | Accepted safe-top 32 | Fresh installed candidate |
| --- | --- | --- | --- |
| Idle | 220×44 | 220×76 | 220×76 |
| Listening | 600×53 | 600×100 | 600×100 |
| Preparing | 600×53 | 600×100 | 600×100 |

All three fresh layouts record `topInsetPx=32`, at 1 captured pixel per logical point. Their heights agree with the accepted notch profile. Current mark/placeholder/input controls differ from the older profile, so matching dimensions do not mean pixel identity. Read-only Pillow diagnostics against the old safe-top images give sampled luminance changes of 3.541%, 4.210%, 3.455% respectively. The obsolete root dimensions are not a valid size match for this screen environment.

The seven larger light images have unchanged overall dimensions. The following diagnostic percentages use Pillow RGB decoding, the production sample strides and ≥16/255 luminance threshold. They are **not native AppKit golden results** because color conversion can differ; full RGB-channel diagnostic ratios and all hashes are also retained in the manifest. The native gate tolerance remains 0.5%.

| Light surface | Size | vs root diagnostic | vs safe-top 26.6.2 diagnostic | Interpretation |
| --- | --- | ---: | ---: | --- |
| Recording workspace | 1080×680 | 1.089% | 0.000% | Old safe-top already has two tabs; remaining visible accent shifts purple to blue. Full RGB change 0.237% |
| Transcript | 1080×680 | 1.530% | 0.000% | Same content/columns; accent change. Full RGB 0.349% |
| RAG | 1080×680 | 1.756% | 0.000% | Same panels/content; accent change. Full RGB 0.196% |
| Meeting detail | 1240×820 | 4.826% | 4.685% | Sidebar boundary 268→260px, content shifts 8px, native chrome/row styling and accent change. Not merely rasterization |
| Permission denied | 1080×680 | 1.054% | 0.067% | Same warning/action and geometry as safe-top; blue action/link and minor rendering. Full RGB 0.283% |
| Agent timeline | 1080×680 | 1.124% | 0.000% | Same panel geometry; accent change. Full RGB 0.247% |
| Meeting canvas | 1080×680 | 2.421% | 0.112% | Four sections retained; blue text/link indicators and minor text/divider differences. Full RGB 0.575% |

Global blue is documented in presence-mark round 2; two transcript modes are documented in [transcript-modes](../../../ux-benchmark/compare/transcript-modes/ROUND.md). The safe-top profile already incorporates some changes that root references lack. Therefore the full mismatch must not be labelled an OS-only change. Meeting-detail sidebar/native styling has not been isolated with identical-source cross-OS execution; its primary content is readable in the actual paired images, but cause remains mixed. Six-state geometry does not include Main/meeting-detail control layout, so it cannot certify that 8px change.

Compared to the previously independently reviewed macOS 27 candidate, 16/20 golden candidates are byte-identical. Four differ; all four are below 0.158% in this sampled-luminance diagnostic. This supports consistency with the prior visual review but does not replace the fresh independent 32-image review.

## Proposed update to the existing five-line round — not adoption

Keep the original failed/blocked history in [macos-27-profile/ROUND.md](../../../ux-benchmark/compare/macos-27-profile/ROUND.md). Append the following measured follow-up rather than pretending the earlier AX SKIP passed:

```text
reference : Existing DS-01/notch-safe-area, presence-mark round 2, continuous-surface and transcript-modes decisions; compare root, approved 26.6.2 safe-top-32 and fresh installed 27.0.1 artifacts.
hypothesis: A separate 27.0.1-2x-safe-top-32 profile can represent the documented current UI while preserving 0.5% pixels / 2pt geometry / 1.5pp density; no new product shape or tolerance change.
measured  : Installed com.astra.mac SHA2880bc…: 32 own-window shots, AX six states / 43 named occurrences, all positive. HUD 220×76/600×100/600×100, task dock 720×294, workspace1080×680; old common37 keys=30 within2pt and7 source-explained changes. Main detail8px sidebar shift remains mixed native/source and is not covered by those six states.
candidates: A=retain old-profile FAIL; B=add only the20 listed images plus6 measured geometry states with explicit provenance, after independent review and repeat gates; C=loosen thresholds or overwrite old references (rejected).
gate      : Fresh independent32-image/geometry review → resolve remaining Main-detail geometry/occupation concerns → root-owned shape/occupation and repeat geometry → exact native golden/density at unchanged thresholds → provenance-bound adoption. Preserve historical failures and complete verify-all before commit.
```

No new profile files have been installed. Outstanding acceptance work is the independent review, any additional Main-detail measurement needed to accept the native sidebar change, current-candidate shape/occupation, repeated 2pt geometry comparison, and native golden/density evaluation under the unchanged thresholds. These visual captures do not claim actual microphone recording, screen recording permission, arbitrary app input, or completion of the full release gate.
