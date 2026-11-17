# Verification without implicit model loading

Verification scripts default to two concurrent Swift/Cargo build jobs. This changes build scheduling only: packaging still uses `swift build -c release`, the full normal Swift unit suite remains enabled, and application model selection, inference settings, and answer quality are unchanged.

Override the positive integer limits explicitly when the machine has capacity:

```sh
GENIE_SWIFT_BUILD_JOBS=4 CARGO_BUILD_JOBS=4 bash scripts/verify-all.sh
```

## Stopping before the machine gets tight

`scripts/memguard.py` runs a command unchanged and samples memory once per second. It refuses to start below 55% free memory and stops the whole process group when free memory falls below 40%, swap grows by more than 512 MB, or the OS pressure level leaves normal. The kernel pressure level alone changes late; the earlier limits are what protect another application running at the same time.

```sh
python3 scripts/memguard.py --log gate.log --report gate-memory.json -- \
  bash infra/db/with-test-db.sh bash scripts/verify-all.sh
```

A stop by the guard exits 75 and is an interrupted run: unfinished gates are unverified, never passed. Otherwise the command's own exit status is returned. The report records the lowest free memory and highest swap per `== gate ==` stage, so the gate that costs the most memory is named by measurement. The guard skips no gate and loosens no threshold; `scripts/tests/test_memguard.py` covers pass-through, group stop and refused start with harmless shell commands only.

The real local translation semantic fixture can load several GiB into the local model server. It is excluded from implicit recording verification. The default emits `NOT_RUN: local_translation_model`; recording verification returns 2 after its other checks. `verify-all.sh` collects reported `SELFTEST_SKIP`, namespaced skips such as `CS_SKIP`/`CABI_SKIP`, `SKIP`, `NOT_RUN`, `NOT_MEASURED`, and `AUTOMATION_MISSING` scopes and prints their count and details. Nonzero omitted-case counts from Vitest, Node and Python summaries, plus Rust `ignored` cases, are also included; zero omitted cases are not. The desktop wrapper preserves the full runner output and rejects empty or zero-executed summaries. Exit codes are:

- `0`: all gates returned success and no omitted scopes were reported.
- `1`: a failure was reported, including a nonzero exit without a documented omission.
- `2`: partial verification; omitted scopes are not passes.
- `130` / `143`: interrupted / terminated, with unfinished gates explicitly unverified.

`scripts/verify-swift-tests.sh`, invoked by the full gate, runs three sequential XCTest processes:

1. The ordinary suite excludes only the two tests assigned to the following processes.
2. The irreversible application-shutdown test runs alone with `ASTRA_VERIFY_CODEX_SHUTDOWN=1`. It starts and cleans up its own synthetic child; it does not load a model.
3. The real external translation fixture runs alone only with `ASTRA_VERIFY_CODEX_TRANSLATION=1`. Without that explicit opt-in it is reported as `NOT_RUN`, and the wrapper returns 2.

The wrapper requires a nonzero test count, exactly one test in each isolated process, a zero process exit, and a zero-failure summary. Any remaining XCTest skip is reported as `NOT_RUN`, including its name. Failure takes precedence over omissions. A wrong or stale filter matching zero tests cannot pass. This orchestrator accounts for the two deliberately separated tests within one run; unrelated historical opt-in results cannot fill omissions in a new run.

The external semantic fixture uses the authenticated Codex CLI and explicitly selects `gpt-6-sol` for reproducibility:

```sh
GENIE_SWIFT_BUILD_JOBS=1 ASTRA_VERIFY_CODEX_TRANSLATION=1 \
  bash scripts/verify-swift-tests.sh
```

This sends the fixture's harmless translation text to the external model. It does not validate local translation or actual app Quit/SIGTERM integration.

Stub-based `MeetingTranslationTests` remain in the ordinary Swift unit suite. They verify translation control flow and fixture behavior; they do not prove real-model semantic quality. The unchanged real-model fixture checks that translation preserves Friday and 3 pm. Run it only when sufficient resources are available:

```sh
ASTRA_VERIFY_LOCAL_MODEL=1 ASTRA_RECORD_BIN=/path/to/Genie.app/Contents/MacOS/GenieMac \
  bash scripts/verify-local-translation.sh
```

The same opt-in can be supplied to recording verification or `verify-all.sh`. The dedicated script does not build an app, install/download a model, change the configured model, or unload a model another application may be using. A skipped fixture, missing output, model error, or process crash cannot count as its successful semantic result.

Harness changes were checked with `scripts/tests/test_verification_resources.py`, which replaces builds, native apps, LaunchServices, and model execution with inert shell commands. This is orchestration evidence only. No full build, actual model load, recording session, or whole-product validation is established by these shell-mock tests. The interrupted earlier full gate remains incomplete.

The earlier [XCTest omission regression record](evidence/2026-10-02-resource-harness/resource-harness-xctskip.json) preserves **14 passing shell-mock tests** and the read-only independent review. Its historical focused suite recorded 74 executed tests including 2 skips and 0 failures; those original omissions remain in that record.

The later [completion run](evidence/2026-10-02-completion/swift-suite.log), using the three-process orchestrator, passed **284 ordinary tests + 1 isolated shutdown + 1 real external semantic translation**, with no skips and exit 0. The [initial wrong-filter failure](evidence/2026-10-02-completion/swift-suite-initial-filter-fail.log) remains preserved: the wrapper rejected a zero-test shutdown process. [Independent evidence review](evidence/2026-10-02-completion/RELEASE_AUDIT.md) distinguishes this bounded PASS from the still-incomplete whole-product gate.

The previous-history fixture generator is an explicit maintenance tool under `services/task/scripts/replay-history.capture.ts` with its own Vitest configuration, 60-second deadline and prerequisite guards. It is outside normal `*.test.ts` discovery. The two saved-history replay acceptance tests and fixture hashes remain unchanged; this separation does not permit regenerating histories to make a failing replay pass. [Independent extraction and runner review](evidence/2026-10-02-completion/replay-runner-final-independent-review.json).
