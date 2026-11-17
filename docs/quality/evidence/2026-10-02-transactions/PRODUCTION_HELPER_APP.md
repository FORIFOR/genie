# Production helper in an identifiable app bundle

2026-10-02 JST. This is packaging and status verification, not a change to native input or consent behavior.

The current `.build/computer/genie-computer-background` executable was copied into `/private/tmp/genie-transactions-20261002/GenieComputerHelperPreview.app/Contents/MacOS/GenieComputerHelper`, bundle ID `com.genie.computer-helper-preview`. The app's identifying metadata and existing Apple Development signature make the consent window identifiable to native computer-use tools. No unattended flag or consent bypass was introduced.

The copied executable's whole SHA-256 matched before signing; all Mach-O code/data sections matched after signing. The signed executable's whole SHA changes because its signature changes. `codesign --verify --deep --strict` passed. Both original and candidate `--status` exited 0 and reported `ready=true`, `accessibility=true`, `screenRecording=true`, `deliveryMode=background`, `unattendedTest=false`. This read-only status did not capture a screen, send input, or request/change OS permission. Evidence: [production-helper-app-candidate.json](production-helper-app-candidate.json).

To select this candidate in the managed preview, pass:

```sh
--computer-helper /private/tmp/genie-transactions-20261002/GenieComputerHelperPreview.app/Contents/MacOS/GenieComputerHelper
```

The helper remains a stdin/stdout command protocol inside the bundle. Inspect/select its app identity while a real `begin` request is displaying consent. Launching it without a request gives no useful persistent app UI. This packaging result alone does not establish that computer-use app selection succeeds; that remains a native E2E observation.

## Completed first pizza session

Read-only independent inspection found one local simulated provider receipt with status `accepted`, order ID `SIM-064994d3-c097-44d0-b4ae-ff4056139016`, JPY 1500 and the intended demo pizza, destination, payment and time. An independently computed canonical JSON SHA-256 matched the quote hash, and all structured known terms matched the receipt. The simulator's window record reports one click and zero activations. Evidence: [pizza-provider-evidence.json](pizza-provider-evidence.json). This is simulated acceptance, not delivery or a real purchase; the parent separately checks task/API/artifact correspondence and documents how approval occurred.

The remaining raw helper PID 32796 was `--watch` for that completed session's dedicated grant. Its `.activity` file was absent, so it was the implementation's reusable-consent watcher, not a stuck consent dialog or an active pointer. After verifying its exact executable, PID and dedicated session path, the verifier removed only that completed grant. The watcher exited itself and removed its heartbeat sidecar. Evidence: [completed-pizza-watcher-cleanup.json](completed-pizza-watcher-cleanup.json). No unrelated helper, installed app, Codex process, default profile or permission was touched.

The owned preview stage log records `alert-returned-1000-popup-1`, then the simulated app selection and an `ax_press` route. Production source accepts that result only after the normal consent modal returns its first button with a selected target; the unattended branch did not produce these messages. This establishes that the consent path was traversed. It does **not** identify who supplied the input, so it cannot establish that a human personally selected or clicked. Evidence with source/log hashes: [pizza-native-consent-evidence.json](pizza-native-consent-evidence.json).
