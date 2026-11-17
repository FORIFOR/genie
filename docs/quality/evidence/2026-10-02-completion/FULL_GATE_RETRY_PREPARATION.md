# Full-gate retry prerequisites and runner corrections

2026-10-02 JST. `/root/verification_audit` investigated existing evidence read-only, then implemented the expressly assigned runner and fixture-reader corrections. The latter are **implementation verification**, not independent approval. [Metadata, source hashes and fake-test logs](full-gate-retry-preparation.json) bind this checkpoint. No app, model, VM, stream or compiler was started by this investigation; fake CLI tests ran instead. Root owns later asset setup and real execution.

The previous [full gate](verify-all-current.log) remains **FAIL**. It reported three Rust ignored cases, unmeasured Apple STT fallback and T2 motion pacing (47 fps); recording stopped at an expired synthetic token. The [refreshed-token recording retry](macos-recording-refreshed-token.log) passed the reached agent flows, then failed light goldens, and also exposed local-translation and live-microphone omissions. Downstream checks not reached in that run are not presumed successful. The prior missing app permissions belonged to `com.astra.desktop`; [installed-app evidence](user-app-permissions.json) confirms existing microphone, Speech and AX authorization for `com.astra.mac`, without a new grant.

## Genuine omitted scopes

| Scope | Required execution, preserved boundary |
| --- | --- |
| Tauri real STT | `ASTRA_VERIFY_SHERPA_STT=1` plus Sherpa 1.13.6 dylibs, the fixed Japanese ReazonSpeech model and its public test WAVs. The three cases actually decode speech; assertions do not certify transcript accuracy or the printed 350-ms latency budget. A printed `OVER` observation must remain visible. |
| Local translation | `ASTRA_VERIFY_LOCAL_MODEL=1` runs the existing synthetic Friday/3-p.m. semantic fixture with **`.local` forced**. `ASTRA_LOCAL_LLM_MODEL=qwen2.5:7b` and a loopback Ollama `/v1` endpoint preserve the supported feature. External Codex success cannot replace it. This model is cached (4.7 GB on disk); that is not resident memory. Prior actual verification loaded about 6.4 GB, and keep-alive can leave it resident. Schedule it alone and have the workload owner clean up only that owned test model. |
| External translation | `ASTRA_VERIFY_CODEX_TRANSLATION=1`, an authenticated verified Codex CLI and `gpt-6-sol`. This separate synthetic semantic fixture must run on the current candidate; ordinary mocks and process-shutdown tests are different scopes. |
| Apple STT fallback | Launch the selected signed app through LaunchServices. Existing Speech authorization is necessary; at least one supported locale without an on-device asset is also necessary. All locales having assets still means `NOT_MEASURED`. Root separately corrected synthesis failure/empty WAV from masquerading as `file=nil`. |
| Motion | Quiet serial desktop slot, current signed app, no permission guide or unexpected window. T2's previous 47-fps sample is unmeasured under the unchanged 50-fps minimum, and the extra window independently fails continuity. No environment option legitimately turns either into PASS. A continuing failure needs timing/capture or product diagnosis, not tolerance relaxation or repeated runs until green. Human perceived continuity is a separate measurement. |
| Later recording scopes | Existing screen-capture and Input Monitoring conditions are not established by microphone/Speech/AX evidence. On-device locale assets and usable synthetic system voices also matter. Preserve each missing prerequisite/omission if encountered; do not request permissions as a hidden test step. |

## Runner changes

`scripts/app-selftest-runner.sh` extracts the existing Journey normal-exit receipt contract. Journey and privacy gates now use the explicitly selected `Genie` or `GenieMac` signed bundle, `open -n -W`, an isolated `ASTRA_DATA_ROOT`, explicit gateway/test-token-path forwarding, and cloud transcription disabled only in launch arguments. If no data root is supplied, the run uses temporary data. A crash, missing/malformed/failed receipt, launch error or unexpected egress result cannot produce runtime PASS. Missing application, `SELFTEST_SKIP` and `NOT_MEASURED` remain exit 2; assertions and abnormal exits remain exit 1. No OS permission is granted by the helper.

`scripts/verify-tauri-tests.sh` keeps real STT opt-in. With opt-in, it excludes exactly the three known real cases from ordinary tests and executes all three in a separate process with `--ignored --nocapture --test-threads=1`; exact three successful cases and no ignored cases are required there. Normal model/library lookup tests mutate environment variables, so combining real cases with them using `--include-ignored` would invalidate private asset overrides. Other ignored cases stay partial. Default execution still reports the omission; a missing/zero/wrong-count suite or failed asset load cannot pass. `verify-all.sh` only changes the Tauri command to this wrapper; its failure precedence, skip detection and thresholds are unchanged.

The public model's five WAVs are valid PCM16/mono/16 kHz with a 26-byte `LIST` chunk and data starting at byte 78. The old test reader blindly skipped 44 bytes. The fixture-only RIFF parser now validates container/chunk bounds, odd padding, PCM format, nonempty aligned audio, and missing/duplicate format/data before extracting samples. Four ordinary tests cover these boundaries; the real cases choose a sorted public fixture path. No original asset or recognition assertion was weakened, no dependency added, and no production audio decoder changed.

Fake-command regression results: **privacy 6 PASS, Tauri 6 PASS, Journey 4 PASS, existing resource/aggregation 21 PASS**, each exit 0. Bash syntax, rustfmt and owned-file diff checks pass. These exercise orchestration without LaunchServices, Cargo, models or native UI. The new Rust reader and actual STT/egress still require root's serial real run at this checkpoint.

## Isolated asset and execution handoff

The original installer uses fixed release URLs but does not verify archive hashes. Root therefore downloaded into `/private/tmp/genie-transactions-20261002/stt-assets`, preserving production asset directories. Official release metadata supplies the arm64 library SHA-256 `19b90f21925edb21ffbc003489316353b45d31712c6e88d93eaa13a72c31cb84` (19,950,341 compressed bytes). The model archive is 713,097,333 bytes with **no publisher digest**; root recorded its downloaded SHA `e0981d0d5d7b446d41010831b59091ebf57d2aa7b79980f67ca37af460b5842d`. The manifest is copied into the preparation JSON; this reviewer inspected metadata and paths, not a second full archive hash pass.

Root's scheduled command, **not run by this reviewer**:

```sh
ASTRA_VERIFY_SHERPA_STT=1 \
ASTRA_SHERPA_LIB_DIR=/private/tmp/genie-transactions-20261002/stt-assets/library/sherpa-onnx-v1.13.6-osx-arm64-shared/lib \
ASTRA_STT_MODEL_DIR=/private/tmp/genie-transactions-20261002/stt-assets/model \
CARGO_BUILD_JOBS=1 bash scripts/verify-tauri-tests.sh
```

`ASTRA_STT_MODEL_DIR` is the **parent** of the fixed Japanese model directory. The recognizer uses CPU inference with up to four threads independently of Cargo build jobs. Peak runtime memory is unmeasured; archive size is not a RAM estimate. Do not overlap this real model run with local-LLM inference, a native build, or Noa's streaming workload.

For the subsequent full gate, root must freeze the source and freshly signed installed `com.astra.mac` candidate after the pending Keychain fix; explicitly set `ASTRA_RECORD_BIN=/Applications/Genie.app/Contents/MacOS/Genie`; use unique app/shots/session/dock data directories and a selected isolated gateway. Prepare a fresh synthetic `@astra.local` agent token whose path begins `/tmp/` and whose validity covers the run, without logging it. Run `infra/db/with-test-db.sh` only against the dedicated disposable PostgreSQL instance because it drops the named DB and creates/removes shared roles; supply the wrapper's exported `TEST_DATABASE_URL` and identity DB variables to descendants. Keep native tests, DB suites and model runs serial. The token, signed identity, optional model flags and asset env must be explicit; previous passes do not replace current omitted cases. Current whole-gate results and final profile adoption remain pending.

## Subsequent root-owned real STT execution

After the checkpoint above, root executed the exact opt-in runner against the isolated assets. This reviewer read [the saved current log](tauri-real-stt-current.log): ordinary **71 PASS**, isolated real **3 PASS**, **0 ignored**, final `TAURI_TESTS_OK`; root reported exit 0 and pressure level 1 before/after. The four new RIFF unit cases are included in those 71. This establishes real decoding and the existing assertions on that candidate, not a new quality benchmark. Projected first partial was **1,529 ms against the printed 350-ms target: OVER**. The latency goal remains unmet, and the shorter-window observations are not authorization to lower answer quality. Apple egress, local translation, motion and full-gate validation remain separate.
