# Dedicated main-app candidate

2026-10-02 JST. Parent requested a distinct local application identity because its computer-use session could read `/Applications/Genie.app` but timed out twice against the current build's app path; selecting a bundle ID was ambiguous. A process sample showed the current app in its normal event loop. This candidate isolates identification without stopping the regular installed app or modifying permissions.

- Source: `/Users/shuhei/Projects/genie/apps/genie-macos/.build/Genie.app`
- Candidate: `/private/tmp/genie-transactions-20261002/GenieTransactionPreview.app`
- Only application metadata changes: `CFBundleIdentifier=com.genie.transaction-preview`, `CFBundleName=Genie Transaction Preview`, `CFBundleDisplayName=Genie Transaction Preview`.
- Version remains `0.1.4`. Source app and its executable were not modified. No source code, design token, visual geometry, OS permission, TCC record, or installed app was changed.

[dedicated-preview-candidate.json](dedicated-preview-candidate.json) records SHA-256 values and signing verification. The copied executable's full SHA-256 matched the source **before signing**. Re-signing correctly changes the embedded Mach-O signature, so the signed executable's overall SHA-256 is different; that difference must not be represented as byte identity. Every Mach-O code/data section, including its address, size, offset and content SHA-256, matched after signing. Bundle-wide byte comparison found changes only in `Contents/Info.plist` and the executable's embedded signature. All other resources and nested frameworks remained identical.

The candidate was signed using the existing `Apple Development` identity with its new identifier. `codesign --verify --deep --strict --verbose=2` exited 0. This is local development signing, not a claim of distribution notarization or production release approval.

The owned preview supervisor was stopped through `start-local-preview.mjs stop --state-dir /private/tmp/genie-transactions-20261002/preview` and exited 0; unrelated processes were not stopped. The candidate is then selected explicitly with `--app /private/tmp/genie-transactions-20261002/GenieTransactionPreview.app`. Native transaction completion remains a separate parent-run E2E check.

Managed startup reached `GENIE_PREVIEW_READY` with the dedicated app, Gateway `http://127.0.0.1:43180`, explicit transaction simulation, background delivery and the production helper (`unattendedTest=false`). See [preview-launcher-dedicated-app.log](preview-launcher-dedicated-app.log). The supervisor remains running for the parent agent's GUI verification.

## Correction: a service-ready log did not establish app survival

The parent later found that the app started directly by the launcher (PID 26594, parent Node PID 26219) had crashed under TCC. The crash report states that Speech Recognition usage information was missing from the responsible process, although the signed app's plist contains it. The raw executable launch did not provide the required LaunchServices responsibility. Extracted relevant diagnostic fields: [raw-launch-tcc-failure.json](raw-launch-tcc-failure.json).

A later computer-use app selection had opened a different dedicated-candidate instance (PID 27080, parent 1, no `--demo main`). The verifier confirmed `ASTRA_DATA_ROOT`, `ASTRA_GATEWAY_URL` and `ASTRA_MODEL_DISCLOSURE` were absent, then sent SIGTERM only after confirming that exact dedicated executable/PID. The parent made no request or authentication action in that unscoped app. No existing history was copied into evidence.

The previous `GENIE_PREVIEW_READY` therefore proves service startup only, not an isolated native-app session. The launcher has been corrected to use `/usr/bin/open -n -W -a <candidate> --env ... --args --demo main --preview-instance <random UUID>`, capture the actual native PID, and fail if its waited app launcher exits. The nonce is included in both the exact process query and argv verification. Shutdown validates the captured PID, start time and exact argv before terminating that instance; other app instances are permitted and not owned. The launcher CLI was verified to set `open:true`; a missing option was not the cause. Actual corrected startup and environment verification must be recorded separately before native E2E can proceed.

The revised launcher unit suite passes 19/19 with no skipped tests, including instance-only environment arguments and rejection of wrong nonce, wrong executable, missing/extra arguments. These are implementation tests; the parent also independently reviewed the lifecycle diff and requested the nonce correction. Full app lifecycle remains a native check.

## Corrected native scope verified

The LaunchServices startup reached ready on 2026-10-02 at 01:00 JST with native PID 31746, parent 1, and the complete `--demo main --preview-instance <UUID>` argument identity. The verifier inspected only four selected environment variables and confirmed the actual native process has the dedicated data root `/private/tmp/genie-transactions-20261002/preview/app`, Gateway `http://127.0.0.1:43180`, disclosure text naming local `qwen3.5:9b`, and `ASTRA_LOCAL_VISION=1`. No unrelated process environment was printed or saved. See [launchservices-native-scope.json](launchservices-native-scope.json), which also identifies the current launcher source hashes, and [preview-launcher-launchservices-2.log](preview-launcher-launchservices-2.log).

This corrects the earlier raw-process startup evidence. The parent can now verify the same PID and model disclosure in the real UI before submitting the fictional order. The verifier has not operated that UI or declared checkout completion, and native stop/ownership behavior still needs observation when the parent closes this session.
