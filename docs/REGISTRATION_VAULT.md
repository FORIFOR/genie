# Native registration password storage (experimental)

`RegistrationVault.generateAndStore(origin:email:)` is a native primitive for the registration helper. It creates a 32-character password with `SecRandomCopyBytes`, saves it before returning it to the native field writer, and returns an independent opaque UUID reference. No password is accepted from or returned to the model, helper protocol, command arguments, environment or clipboard. `Stored` is not Codable and redacts descriptions and reflection. Swift string copies mean buffer wiping is best effort, not guaranteed memory erasure.

The exact canonical HTTPS origin and email form the Keychain account identity. Only `SecItemAdd` is used: an existing item causes refusal, never overwrite or delete/recreate. Items remain local to this device and require an unlocked Keychain. The newly signed helper is the sole trusted application in the item's ACL; neither `/usr/bin/security` nor the Node host is added. A locked or denied Keychain fails without prompting. Stored items are labeled with their origin and email and initially marked `generated_not_submitted`. Failure after storage preserves the item. There is no export, read-secret, delete or automatic replacement command.

For manual recovery, the user can open macOS Keychain Access, select the default/login keychain, find the password item labeled `Genie — <origin> — <email>`, and use its Show password control with macOS authentication. The origin, email and opaque reference remain Keychain metadata; the helper does not return the account metadata record. This generic Keychain item is not a Safari Passwords/autofill entry. This feature prepares a registration form only; it does not implement automatic sign-in or future credential retrieval. Account verification, form submission and recovery must not be claimed complete merely because the item was saved.

The normal unsigned/ad-hoc helper build remains available for non-secret computer use. Registration refuses that build. To enable the native registration capability, build with an explicit certificate identity and its public 10-character team identifier:

```sh
GENIE_COMPUTER_SIGN_IDENTITY='Apple Development: <your signing identity>' \
GENIE_COMPUTER_TEAM_ID='<TEAM_ID>' \
GENIE_COMPUTER_BUILD_DIR='/absolute/path/to/candidate-build' \
  bash scripts/build-computer-helper.sh
```

The optional build directory keeps a candidate separate from `.build/computer`; validate it before replacing the helper used by a running host. The helper uses stable identifier `com.astra.computer.registration`. Its expected team is compiled in, not taken from a runtime request. Every password creation verifies its own valid Apple-anchored certificate signature, identifier and team; ad-hoc/unsigned/wrong-team code is rejected. The build also verifies the resulting signature. A signing failure never grants registration capability. The unattended test build cannot generate registration secrets.

Add `GENIE_COMPUTER_APP_BUNDLE=1` to the same signed build command to also produce `Genie Computer.app` inside the build directory. This optional bundle gives native dialogs a stable application name, the existing Genie application icon and a bundle URL while preserving the signing identifier and certificate. It requires explicit signing; ordinary non-secret builds remain unchanged. The app uses `LSUIElement` and adds no microphone, camera, calendar or automation scopes. The host still invokes its embedded command-line executable:

```sh
node scripts/start-local-preview.mjs --computer-use \
  --computer-helper '/absolute/path/to/candidate-build/Genie Computer.app/Contents/MacOS/genie-computer-background'
```

Preserve the other preview/model options required by your environment. The builder verifies both the bundle and embedded executable but does not launch dialogs, grant permissions or change the running host. Use the embedded executable's `--status` and `--privacy-status` for read-only readiness checks before selecting it. A successful bundle build alone does not prove dialog accessibility or a completed registration.

Checks without production accounts:

```sh
bash scripts/test-registration-vault.sh
GENIE_REGISTRATION_ISOLATED_KEYCHAIN_TEST=1 .build/computer/registration-vault-tests
```

The second command creates and removes a temporary isolated Keychain, with UI interaction disabled. It verifies a real add/readback and preservation on duplicate add; it does not access or unlock the user's Keychain. These tests establish storage and refusal behavior, not registration with a merchant. The implementation uses macOS legacy Keychain ACL APIs, which produce deprecation warnings. Production signing, browser-specific field delivery, capture exclusion, account submission, verification email/OTP and recovery UX need their own integrated evidence. A generated/stored password alone is never evidence that an account was created.

## Native form preparation

`registration_prepare` is a separate experimental native helper operation. Its input is the previously authorized `scope`, private `referencePath`, `allowedOrigins` and `authorizationExpiresAt`. The first rollout accepts only `https://www.mcdonalds.co.jp` independently of host/model validation. It checks the helper signature before requesting an email, validates the snapshot, process/window generation, run epoch, deadline and native document origin, and rejects exposed nested/opaque frames. AX evidence is conservative browser metadata, not a general DOM security attestation.

For an origin-constrained task using local vision, the helper resolves an already open on-screen service window without a picker. Every candidate must be a supported browser with an allowed native document origin. Among verified service windows, it prefers the foreground browser process and then WindowServer front-to-back order. It fixes the resulting window ID for the run and rechecks the origin before saving or reusing a grant. A missing verified target returns an unavailable result; it does not select an unrelated app, use a title guess or change tabs. An external pixel recipient is refused with `origin_provider_consent_required` before capture; it cannot use this automatic path. The task approval, credential consent, process/window identity, native origin checks and input policies still apply. Generic `computer.run` retains its selection flow when no origin constraint is supplied, unless a still-valid grant for the same target and recipient can be reused.

The direct-distribution helper can bind AX windows to their WindowServer ID through the isolated private SPI bridge. This also supports Safari's main/focused window when its AX window list is empty. The owner PID and exact rectangle must still match; keys require the focused window's exact ID too. There is no inferred coordinate translation. Without the ID API, supplementary main/focused candidates are not used, and the existing unique exact-geometry policy for the AX window list remains.

The adapter requires exactly one visible, empty, enabled, settable email field with an exact standard AX label and one empty secure password field. Native hit testing excludes hidden/covered background form fields. Standard `AXEmailField` and ordinary text-field subroles are supported for the email; the password requires `AXSecureTextField`. If form ancestry is exposed, both fields must share it; otherwise the pair must be unique across the entire top-level document. Missing, ambiguous, nonempty, moved or unsupported fields are refused. Native identity/origin checks run after consent and immediately before each write. Delivery uses direct AX value assignment only, with no coordinates, synthetic keys, clipboard or generic model text verification. Password confirmation reads only the secure role and character count; unavailable confirmation returns `registration_input_unconfirmed` and does not retry.

The native dialog follows the existing macOS `NSAlert` helper pattern, with system typography/buttons and no new product styling/tokens. It shows the exact origin and email field name, lets the person enter their email locally, and explains generation, Keychain storage, input and the remaining registration/verification steps. Cancel is the safe default; saving requires the explicit button or Command-Return. This preserves the existing design guidance for deliberate external actions without redesigning the app's confirmation surface. Cancellation precedes password generation, storage and page writes. The dialog's live visual/keyboard behavior still requires an independent UI review.

Successful saving and confirmed field delivery return only `{ "status": "awaiting_user_registration", "credentialRef": "<opaque UUID>" }`. No account-created outcome, email, password or screenshot is returned. Terms, submit, verification codes and CAPTCHA remain user steps. If saving succeeds but later input cannot be confirmed, the item remains available for manual recovery and the operation must not be automatically retried.

Before any page value is written, the native helper creates an owner-only, empty marker in `~/.genie-computer-privacy`, keyed by SHA-256 of `pid:kernelStartSeconds:kernelStartMicroseconds`. Capture is denied before and after screenshot acquisition, and background generic action/preview dispatch is denied for every window of that browser process. The marker survives helper processes, sessions, tab movement into another window and a password's change into ordinary visible text. It is deliberately not cleared on field disappearance, form completion, navigation or a new consent. Finish registration, quit the browser and launch it again to use image-based automation again. Closing one or every window does not clear the barrier while the browser process remains alive. Only markers from a previous process generation stop matching a new target. No marker contains an origin, email, password, field value or credential reference.

Both helpers expose read-only `--privacy-status`, returning exactly `{ "blocked": true|false }`. It reads marker permissions and current running-application/process metadata only (including applications with zero windows); malformed markers or unavailable metadata fail closed. Kernel metadata checks are limited to the exact browser bundle set accepted by the native origin gate, so unrelated protected system agents cannot disable capture permanently. Terminated browsers are skipped; a supported running browser with unreadable metadata remains blocked. Other image/AX consumers must enforce this shared barrier too: a per-helper capture check alone does not protect a separate app screen-capture path. The native helper does not delete markers or inspect page contents to decide that a secret has disappeared.

```sh
bash scripts/test-registration-assist.sh
GENIE_REGISTRATION_METADATA_TEST=1 bash scripts/test-registration-assist.sh
```

This compiles the production native adapter and capture paths, then tests exact-field selection, fail-fast fill ordering, a real private filesystem barrier across helper processes, active/stale process marker matching and tab movement between windows and the opaque receipt. It does not display the consent dialog, insert a production credential, access the user's Keychain or submit a registration. Real browser delivery and merchant registration remain separate, blocked acceptance checks until explicitly exercised with the person present.

The optional metadata run requires Safari or Chrome to be running. It exercises the real `NSWorkspace` and kernel process-start enumerator against temporary fixture markers: an inactive marker stays clear, and a running browser's marker blocks regardless of target window ID. It reads no window titles, AX content or pixels, outputs no process IDs, never creates the production privacy directory, and removes its temporary directory afterward.
