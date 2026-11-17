# Completion work — 2026-10-02 JST

User explicitly requested all outstanding work and GitHub publication as a goal. This record is an in-progress ledger, not a release certificate. Working tree remains based on `ee857a5b13482cbd2d986a1f9b466c8e49a149c3`; `git ls-remote` confirmed the same remote branch revision during this work. Nothing in this round has been committed or pushed.

## Native verification and test orchestration

`scripts/verify-swift-tests.sh` now runs ordinary tests, irreversible process shutdown, and the opt-in external semantic fixture in separate XCTest processes. The full gate invokes this wrapper. Missing external opt-in remains NOT_RUN/exit 2; a zero-match filter, wrong test count, process failure or missing success summary cannot count as a pass. Skips remain reported even alongside a failing test.

The first actual run found an incorrect shutdown class name: 285 ordinary tests included one skipped shutdown test, the dedicated shutdown filter matched zero, and the wrapper correctly failed. The complete initial output is preserved in `swift-suite-initial-filter-fail.log`. `swift test --skip-build list` identified `CodexTranslationProcessTests/testApplicationShutdownEntrypointCleansOwnedChildAndContext`; the filter was corrected.

The final actual run (`GENIE_SWIFT_BUILD_JOBS=1 ASTRA_VERIFY_CODEX_TRANSLATION=1 bash scripts/verify-swift-tests.sh`) exited 0: **284 ordinary tests + 1 isolated shutdown + 1 actual external semantic translation**, no skips. See `swift-suite.log`. This is not a whole-product pass or comprehensive translation-quality evaluation. The AppKit termination regression is also now part of `verify-all.sh`.

Recording selftests now use explicit `ASTRA_GATEWAY_URL`, defaulting to the existing loopback address, and forward it through LaunchServices. The C ABI roundtrip uses the same environment value; C# already supported it. Full-gate omission detection now includes `CS_SKIP`, `CABI_SKIP`, and `NOT_MEASURED` so unreachable or unmeasured checks cannot silently become a whole-product pass.

Root's orchestration regressions execute production shell scripts with fake external commands; no app/model is launched by those Python tests. The first Python run caught loss of skip reporting when a test also failed; that implementation was corrected without weakening the regression. The corrected focused set is 5 Swift-orchestration tests, 4 recording-environment tests, and 12 resource/aggregation tests. Actual test output and independent review are separate from these mocks.

`pnpm -s build` completed with exit 0; `typescript-build.log` is empty because the successful compiler emitted no diagnostics. The production macOS package was built sequentially with one build job and strict signature verification; see `MACOS_APP.md` and `macos-release-package.log`. The new isolated signed copy is `/private/tmp/genie-transactions-20261002/GenieCompletion.app`, with the existing preview bundle identity. Normal app startup/shutdown and full-product gates are still outstanding at this record's creation.

## Real merchant discovery (read-only; not Genie E2E)

Root inspected public official pages using the Codex in-app browser, not Genie's automation runtime. On [McDelivery](https://www.mcdonalds.co.jp/mcdelivery/), opening the order flow showed the email/password login dialog. No credentials were entered, no account was created and no order was submitted. The initial static link became a button after hydration; the page was re-read before interaction.

On [Domino's Japan](https://www.dominos.jp/), the official delivery link led to `https://internetorder.dominos.jp/delivery` and a delivery dialog requiring a postal code. No address, postal code or payment data was supplied and no order was submitted. This establishes only public entry points and user-input boundaries; it is not evidence of a completed checkout adapter or receipt validation.

The user has been asked to identify the intended pizza provider and broker, without sharing passwords/account numbers in chat. Domino's is the provisional pizza target while that answer is pending. A logged-in merchant test environment, explicit test order terms, and broker selection are still missing. Development work must not invent user account/order details or relabel the existing fictional provider as live support.

## Remaining release work

- Real merchant adapters and authenticated checkout/receipt validation; broker-specific integration and separate paper-trading evidence.
- Current native background-operation coverage, main-app launch/quit on the new candidate, and full-product verification.
- UI taste review and actual macOS 27 golden/geometry investigation; do not replace baselines just to clear failures.
- Noa long-duration coexistence and causal memory investigation. Its warning also recurred after Genie was stopped; do not attribute all warnings to Genie or claim that an idle sample proves streaming stability.
- Commit/push only with the applicable repository gate satisfied and evidence accurately scoped.

## Actual main-app shutdown and database consistency

The signed Completion main app was started twice by the managed launcher with external gpt-6-sol and the production background helper (`unattendedTest=false`). Managed stop delivered SIGTERM to app PID 30218; the second run used the actual Genie menu Quit on PID 30626. Both supervisor processes exited 0, the exact app PID disappeared, the dedicated Docker context had no running containers, and status became stopped. No forced kill or cleanup error was reported. See `main-app-shutdown-final.json` and the three preview logs. These are idle-app shutdown checks, not an active translation/transaction shutdown test. The initial normal-Quit supervisor error remains recorded separately.

Transaction regression ran against a separate disposable pgvector PostgreSQL database and exited 0 (`transaction-regression.log`). One conditional fixture-generation case was skipped; this is not proof that every possible integration ran. No real merchant, payment or securities account was used. The exact owned test container was removed after database cleanup.

The generated SQL schema was stale: transaction authorization migrations and their generated types were not reflected in `infra/db/schema.sql`. A second disposable database received current migrations; the normal schema dump and Kysely generation commands updated the artifacts. `scripts/check-generated.sh` then exited 0, checking SQL, TypeScript schema, dock geometry, CRM entities and shortcuts (`schema-generate.log`, `schema-check.log`). This second owned container was removed too.

The earlier full Python regression output is `python-regression.log` (49 tests at that source state). Later launcher/UI-lint changes have their separate current outputs and require final aggregation.

## Final test reporting corrections

Full-gate aggregation now also recognizes positive skipped counts reported by Vitest, Node and Python, and ignored Rust cases. The desktop test wrapper preserves complete output and cannot report an all-skipped or zero-test run as success. Rust wrappers retain every test-summary line. The mocked production-runner regression passed 14 tests; actual desktop regression passed 357 tests. See `test-orchestration-final.json`.

The previous-revision Temporal history generator was a mutating, opt-in helper registered as a skipped test in the ordinary acceptance run. It now has an explicitly selected capture config and a `.capture.ts` tool file. Its 60-second Vitest deadline, historical revision and synthetic activity assertions are retained; nested cleanup now runs environment teardown and directory cleanup even when a worker rejects. The two normal replay acceptance tests have unchanged bodies and passed with zero skips. All three checked-in fixture JSON files remain byte-for-byte unchanged from HEAD. Negative tool invocations confirmed that missing explicit opt-in or missing cached executable path refuses generation before a workspace/server is created. Generation was not performed.

Strict test typechecking initially found TS7022 in the extracted helper; adding the explicit `WorkflowHandle` type fixed it and the final typecheck exited 0. Both outputs remain saved. The testing changes do not establish a whole-product pass.

After all managed containers were stopped, the owned `genie-transactions-20261002` Colima profile was stopped as well (`idle-vm-stop.log`). Native-only verification does not need an idle VM consuming memory. No other Docker context or running user app was stopped.

## External screen permission and current production preview

Inspection found that the managed launcher's conversation cloud opt-in also enabled computer-vision screen egress. This was an overbroad permission coupling, not a missing model connection. The launcher now requires a separate `--allow-external-screen` choice, stores it only for the exact provider/model in the selected state directory, invalidates it on a provider/model change, and supports `--no-external-screen`. It does not add confirmation for every input. The native target-window consent still applies. The model remains gpt-6-sol; no smaller model or answer-length reduction was introduced.

`computer-use.mjs check` previously probed a hardcoded build path even when the running host used an explicitly selected helper. It now reads the authenticated launcher's `/computer/status`, which probes the actual helper afresh with bounded output/time. It displays the actual recipient and separately reports screen-egress permission. It never executes a helper path returned by HTTP. Unknown, test-only, mismatched, foreground-only or failed helper status cannot count as ready. CLI regression passed 9 tests. The complete background/model/device/budget/CLI set passed **118 tests, zero skips**, and the complete Python runner regression passed **52 tests** (`computer-host-gate-final.log`, `python-regression-final.log`). Launcher regression passed 38 tests; see `EXTERNAL_SCREEN.md`.

The managed preview was restarted with the explicit external-screen choice, gpt-6-sol and the signed production Final helper. The actual readiness result confirms background mode, normal consent, both existing permissions and the new capabilities (`safari-runtime-readiness.json`). A public Safari navigation task reached the normal target picker, but the picker did not list the owned private Safari window despite independent AX/window-screenshot visibility. Window Raise, selecting that window from Safari's Window menu, and refreshing the picker did not resolve it. The test was cancelled at the picker. The durable stop record is `user_cancelled` with an empty audit, the task is FAILED, and there was no model vision call or target input. This is **not** a successful Safari/model E2E or an order test; see `safari-public-verification.json`.

Source review shows that the helper requires the target in ScreenCaptureKit's on-screen collection and rechecks CoreGraphics on-screen window presence at capture. Private browsing is not explicitly excluded. Hidden windows/another Space are plausible causes, not established facts. Broadening the picker alone would not fix the downstream capture boundary. No new OS permissions were granted.

The current full gate ran against the latest canonical signed app, the isolated synthetic gateway identity and a separate disposable PostgreSQL instance. Its complete output is `verify-all-current.log`, exit **1**. The local-model opt-in remains off to avoid loading a multi-GiB model alongside streaming; this omission cannot be called a full pass. The remote branch was rechecked and remains at the original `ee857a5b13482cbd2d986a1f9b466c8e49a149c3`; no commit or push has occurred.

## Full-gate result and exact remaining work

Swift verification passed **291 ordinary tests + 1 isolated shutdown + 1 actual external translation**, with no skips. The four AppKit termination scenarios passed. The gate also correctly reported the three ignored Rust tests and unmeasured speech/motion scopes instead of promoting them to a complete pass.

The first recording path stopped on an expired synthetic test token that had been prepared before the gate. Refreshing that owned test identity and rerunning the recording path fixed that specific preparation failure: AI action, voice ask, backend cancellation, recovery, connector fixtures and interaction-state differences passed. The rerun is recorded separately in `macos-recording-refreshed-token.log`; it does not overwrite the first failure.

That rerun then reported microphone-dependent paths as skipped and failed the existing light golden comparison (three HUD dimension differences plus seven image differences). The known macOS 27 profile is not accepted without actual element geometry. JA and motion also did not enter the intended Listening state; source investigation ties the extra 312 × 189 pt FloatingPanel to the permission explanation path, not the later confirmation card. Main-bundle permission status and shell-process status differ. No guide panel was hidden, window-count exception added or baseline weakened to clear these results. Permission-specific diagnosis remains separate from a successful journey.

The structured current result is `COMPLETION_STATUS.json`. Main-app Accessibility approval, intended live providers/test environment, and the Noa streaming state remain awaiting user answers. Real merchant/broker integration and long-duration coexistence are unfinished. This is not a service completion or release declaration.

After the checks, the managed supervisor stopped cleanly, no owned selftest process remained, and the separately identified disposable PostgreSQL container was removed. The owned idle Colima profile stopped with exit 0; no other context or user process was stopped. The kernel memory-pressure level was 1 after cleanup. The owned Safari window received a close action, but the subsequent accessibility read timed out, so its closure is not asserted as verified.


## Follow-up: on-screen eligibility, current Noa state, and setup docs

At 05:12 JST a separate, read-only diagnostic found Safari regular and not hidden, but both CoreGraphics and ScreenCaptureKit returned zero on-screen windows. Their all-window collections agreed on eight off-screen window IDs. No title, URL, image, AX tree or other-app window details were retained. This establishes the later system classification and why that set is excluded by the current picker; it does not establish the exact state of the earlier private window or distinguish other Spaces, minimization and other causes. See `safari-window-metadata/manifest.json`. No OS permission, Space, app foreground or window was changed.

Noa's read-only current check found its engine stopped and no owned OBS stream. Saved events add a 04:05:50 OS pressure-level-2 warning and a 04:06:20 protective stop request after 30 seconds, followed by normal pressure at 04:08:45. Noa's internal `critical` label here denotes sustained warning; it is not OS pressure level 4. The current normal-pressure sample and zero resident Ollama models do not prove long-stream coexistence or establish a crash cause. See `noa-current-readonly-20261002-0510.json`.

Eight setup documents now lead with the explicit existing Codex/gpt-6-sol route, identify local inference as an option and distinguish conversation from automatic screen-image authorization. Seventeen published launcher examples passed pure `parseOptions`/`modelConfiguration` checks (`documentation-startup-check.json`). The unconfigured local default, runtime source, selected model and answer limits were not changed. This documentation check is not an application or full-gate pass.

Main-app AX approval, live provider/test-environment details and Noa streaming context remain pending. The actual full-gate recording path also requires first-use microphone/speech permissions; that additional OS-prompt request has been presented separately. No grant has been applied or assumed. GitHub remains unpublished because the required full gate is still failing.

The follow-up time comparison (`noa-genie-temporal-overlap-20261002.json`) places normal Genie app/service shutdown roughly 41 seconds before the 04:05:50 warning. Native development checks and the still-running owned VM overlap that warning interval; the VM was stopped later. Those log timestamps support possible development-load contribution, but do not measure process/GPU allocation at the pressure peak. They do not establish ordinary Genie runtime as the cause. No warning threshold was weakened and no Noa/OBS configuration changed.


## Bounded synthetic offscreen experiment and documentation review

Two small, sequential `swiftc -j 1` PoC runs created only their own synthetic window, with existing screen-capture preflight and normal OS memory pressure before and after. The second run separated the first run's ambiguous metadata failure: window geometry was outside all display rectangles, while both CG and SC still classified it on-screen. Both retained the required OS-offscreen guard and exited before calling capture. There are zero screenshots; fresh A-to-B rendering, actual other-Space capture and end-to-end background input are NOT_RUN. See `offscreen-capture-poc/manifest.json`. The private fixture closed its own window and process. No production boundary was broadened on this evidence.

Independent documentation review found that the two computer-use examples omitted `--app`, which would revert to `/Applications/Genie.app` rather than the same-checkout build used in the setup guide. Both examples now name `apps/genie-macos/build/Genie.app`; the 17-example pure argument/configuration check was rerun successfully and now records its exact source/doc hashes and verification code. No runtime default changed. `git diff --check` passed.

The remote branch was checked again and still resolves to `ee857a5b13482cbd2d986a1f9b466c8e49a149c3`. No commit or push has been performed. The independent reviewer confirmed the narrow documentation correction, all 10 recorded source/doc hashes and the exact 17 current argument examples. This was a read-only review, not a repeated application run. Whole-product acceptance remains FAIL.


## Actual installed app and standard workspace correction (05:41–06:01 JST)

The earlier latest-app and external-model checks used a private preview. Inspection found that both `/Applications/Genie.app` and `apps/genie-macos/build/Genie.app` were still the September 30 app, and the standard managed state still selected local qwen3.5:9b. These were not user-facing completion evidence.

Both actual app locations now contain the latest canonical code and resources, re-signed while preserving the original com.astra.mac identity, Genie executable name, LSUIElement, certificate and designated requirement. Exact old copies are backed up in the user's Genie/update-backups directory. Independent strict signature, code-byte/resource manifest and installed-hash checks passed. A real LaunchServices permissions selftest confirmed existing AX/microphone/speech access. No OS grants changed; earlier .desktop permission requests do not apply to this installed identity.

The standard runtime configuration now saves codex/gpt-6-sol using the production configuration helpers, retaining all credentials, project and ports. External automatic screen authorization remains null. The old configuration is backed up privately. The final signed production helper was installed under the user's Genie/helpers directory; it reports background, ready and unattendedTest=false.

The existing default Colima profile was started with its unchanged 2CPU/4GiB configuration because it holds the standard project's existing PostgreSQL/Redis volumes. Its per-child Docker context was explicitly pinned; the global context remains default. Normal managed startup reached ready and the Home UI showed the external recipient and prior tasks. However, a synthetic text request was rejected before transmission because backend credentials were pending: process sampling shows GatewaySession waiting in SecItemCopyMatching. Opening settings then blocked the main thread on a Gemini keychain read. SecurityAgent inspection was rejected by the computer-use tool; no alternate inspection or permission bypass was attempted. The supervisor stopped all owned services and verified the exact hung app before forced termination. This attempt is FAIL for normal answer completion, not a successful external inference test.

Actual installed-app AX capture yielded six states/all 43 required control and text elements, plus 32 light/dark screenshots. Independent visual review found no concrete clipping or overlap and supports proceeding with a macOS 27 candidate profile. New capture-to-baseline native comparison and shape/occupation remain required. Old root baselines differ for documented safety-area and accepted UI changes as well as native chrome; differences are not all attributed to OS alone.

Build resource limits now cover seven additional entrypoints. Recording and journey launchers accept both official Genie/GenieMac executable names and still reject unknown binaries. Fake-command Python regression passed 62 tests; these are orchestration tests, not native/model runs. See separate manifests and full logs. Full gate, live checkout, Noa coexistence and GitHub publication remain incomplete.


## Follow-up execution and discovered connection requirements (06:08–06:25 JST)

The selected external route was confirmed to be managed-launch-only: an ordinary bare app launch does not yet read the saved managed selection and still uses legacy defaults. A non-secret, strictly validated standard-workspace connection descriptor is being implemented; invalid saved data must not silently select the local model. This is in progress, not installed success.

The Keychain change has a focused 47-test result and independent source review. The review caught a first-sign-in/save-denial reauthentication loop and inability to turn off an inaccessible selected Gemini key; both were corrected. Actual Keychain recovery and normal installed UI remain pending.

To close real STT omissions without changing the user's speech engine, fixed official Sherpa library/model assets were fetched into private test storage only. Library SHA matches publisher metadata; the older model has no published API digest, so the retrieved SHA is recorded without claiming publisher checksum validation. Test WAV RIFF chunks are now parsed correctly instead of assuming a 44-byte header. The new separated runner completed 71 ordinary Rust tests and all three real STT tests with no ignored cases. The measured first-partial time was 1529ms, exceeding the separate 350ms target. No live microphone data was involved. Whole Python orchestration regression passed 74 tests.

New official-site handoff routing has 39 focused tests, seven mocked local-host tests and 20 PostgreSQL/HTTP cases. HTTP fault injection found that prepared-response recovery discarded its no-order notice; the implementation now preserves it. Root then used the isolated synthetic gateway tenant to exercise the real conversation/task-worker/local-host path for 'マクドナルドの注文画面を開いて'. It progressed PENDING → RUNNING → COMPLETED and produced a readable Markdown artifact that explicitly says cart preparation, ordering and payment were not performed. This proves only the OS navigation request and artifact path; browser rendering, authentication, cart and receipt remain unverified. It is not an actual live checkout adapter or native Home E2E.

Noa remains stopped in the latest read-only health observation. An isolated generation-load harness is being prepared with the same model/voice parameters, no stream/playback/Jev request and immediate memory-pressure abort. It has not run and cannot establish real streaming stability.

## 実用アプリ更新・通常起動と75秒観察（2026-10-02 07時台）

`/Applications/Genie.app` と通常配布用 `apps/genie-macos/build/Genie.app` を SHA256 `5a27e3f39e06c0bb43c2a343dee478c7b6922e5df36d9b8a5f28aa4d90a6ad1a` に更新した。既存 com.astra.mac / Genie / LSUIElement と署名要件を維持し、独立した実Mach-O・Resources・Frameworks照合はPASS。直前版は `~/Library/Application Support/Genie/update-backups/20261002-064457` に保持。現在は、その後の撮影起動修正・Keychain復帰導線がまだ未反映である。

新binaryで6状態geometryは候補と2pt以内。light撮影は4つのMainWindow面が撮影不可でFAIL、他12面は保存できた。起動完了通知中の同期撮影とMainWindowの非同期activationの組合せが疑われ、通常操作ではHomeが表示できることを別に確認した。旧FAIL・新FAILを保持し、golden/profileはまだ採用していない。

通常起動の最初の観測では保存設定が反映されずFAILを記録した。descriptorが存在し、既存app processが0であることを先に記録した次の新規起動では、HomeにOpenAI / Codex gpt-6-solの送信先と既存標準workspaceの履歴が表示された。前の不一致の原因は未確定であり、再起動で通った事実と分ける。Foundation/小型AppKitプローブではenvironment cache不整合を再現せず、根拠のないre-exec変更は加えていない。

設定画面は実操作で応答し、表示の欠けは観測しなかった。Homeから合成文章作成を依頼すると、Keychainアクセス拒否の案内が直ちに出て入力を保持した。フリーズは再現せず、実回答はBLOCKED。確認用入力を消してappを通常終了した。KeychainのACL・保存値・OS権限を変更せず、明示した本人操作で既存接続情報を確認する復帰導線を追加中である。

Noaと同じローカルモデル・音声設定の3回合成生成と、その後のモデル常駐観察を含む75.382秒の試験はPASS。この間の155件のOSメモリ圧はすべてnormal、free最低46%。Genieの外部gpt-6-solによる合成文章作成と12.190秒重なり、入力の6事実を保った成果物を取得した。生成自体は15.965秒で終了し、残りは常駐観察である。専用Ollama/runnerの終了・資産不変を確認、共有サービスは停止していない。配信・OBS・Jev・再生は行っておらず、長時間配信の安定性・クラッシュ原因特定・回答品質全般の合格ではない。詳細は [NOA_COEXISTENCE.md](NOA_COEXISTENCE.md) と [75秒の集計](noa-resident-75s-coexistence.json)。

現時点の全体判定はFAILのまま。通常userサービス43123と私用検証gateway43180、専用test PostgreSQLを次のgate用に保持している。GitHub branchは読み取り再確認でも元revisionのまま、commit/pushは未実施。

## Installed recovery candidate and full gate — 07:25–07:36 JST

Installed a01378c under the same .mac identity/signing requirement; backup072506. Fresh32shots,20nativegoldens,6geometry and shape/occupation/density passed at existing thresholds. Adopted new macOS27 profile only after independent artifact/source/hash review. Previous profiles and failures were preserved.

Fresh full gate finished exit1 after6m18s.375 memory samples were normal; no memory-guard abort. micrelease failed because conversation input never remained running through inherited Gemini key-check / remote prepaid-credit refusal; all recorded after-close values were false, so this run does not demonstrate a microphone leak. Actual Gemini connection attempts cannot be excluded. Non-Gemini dictation/meeting capture paths did start and close. This exposes missing test-fixture isolation. aistop skipped with gateway-unreachable; a429 warning near that time is a hypothesis, not route-level proof. T0 motion captured45.67fps and marked NOT_MEASURED; continuity success is not60fps evidence. Real STT assertions passed, first partial1533ms still over350ms target. Further narrow source fixes and independent review are pending; nothing committed or pushed.
