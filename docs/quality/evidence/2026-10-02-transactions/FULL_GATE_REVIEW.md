# Full-gate evidence review

2026-10-02 JST, read-only review. This is a review of the latest completed full-gate log, not a fresh run of the current transaction changes. No golden baseline, UI dimensions, permissions, or test threshold was changed by this reviewer.

The latest completed full gate available is `/tmp/genie-pointer-verify-all-latest.log` from 2026-10-01 22:39 JST. It ends `VERIFY_ALL_FAIL`. Its checked-in report is [VISIBLE_COMPUTER_POINTER.md](../../VISIBLE_COMPUTER_POINTER.md). The 255 Swift unit tests passed, while the following product-level checks failed:

| Gate | Exact evidence | Current implication |
| --- | --- | --- |
| Main UI golden comparison | Log lines 1795–1805: idle/listening/preparing HUD dimensions differ; workspace/transcript/RAG/meeting-detail/permission/timeline/canvas colors differ by roughly 1.05–4.86% | FAIL in that run. macOS 27.0.1 lacks a matching golden profile. No new baseline was accepted; current transaction changes have no fresh full-gate result |
| Journey JA | Lines 1823–1827: success=false, 2 errors; confirmation adds a window (2→3) and it remains. JB and JC succeed | FAIL in that run. Prior native evidence identifies the existing microphone permission guide; no permission action was performed to hide it |
| Surface continuity/motion | Lines 1829–1843: extra `FloatingPanel` 312×189 across transitions; `SURFACE_CONTINUITY_MOTION=FAIL` | FAIL. One T2 interval has 49 fps and is explicitly NOT_MEASURED for 60 fps; it must not be relabelled as a performance pass |

The log also contains deliberate negative-fixture `FAIL` messages from the vocabulary checker before `convention check passed`; these are not additional terminal full-gate failures. Compiler source excerpts containing `SELFTEST_FAIL` are likewise not executed failure results.

Older `docs/quality/RESULTS.md` lists turn-response recovery and cancellation races as failures. Their later correction is recorded in `docs/quality/RECOVERY.md`; those superseded findings must not be reintroduced as current blockers. The previous managed-preview Docker blocker is also superseded by this run's isolated, healthy managed preview. This run's main-app package version mismatch was corrected by the packaging owner; the second managed startup reached ready. Neither environment recovery establishes main-app E2E success by itself.

Outstanding release evidence includes a completed full gate for the final transaction revision, native integrated execution and results, and the human concurrent-input/IME checks specified in the transaction plan. Existing narrow tests or an old successful gate cannot establish these. Working-tree changes remain uncommitted/unpushed as of this review.

## Subsequent interrupted run

Root's later `bash scripts/verify-all.sh` on October 2 JST was interrupted to reduce memory pressure (reported exit 143). The saved [partial log](verify-all-interrupted-memory.log) ends at `initial profile native UI`; UI taste and light golden failures had already occurred. The gate also performed actual local `qwen2.5:7b` translation inference. See [the memory evidence](MEMORY_PRESSURE.md) for attributed measurements, cleanup, and limitations. This incomplete run does not replace the earlier completed FAIL with a PASS. The latest candidate still has no completed whole-product result.

Separately, [later main-app evidence](MAIN_APP_BOUNDED_REUSE.md) now establishes two fictional accepted pizza orders through bounded UI authorization, one native consent, a reused native window, and displayed receipts. It does not resolve the full gate, human concurrent input/IME, or latest in-flight cancellation retest.
