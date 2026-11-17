# External model preview — implementation verification

Date: 2026-10-02 JST. This author implemented the launcher change; these checks are implementation verification, not an independent product/release verdict. Existing transaction, pointer and full-product gate limitations still apply.

## Scope and result

The user's request to prefer an external model is supported by an explicit, persisted preview choice:

```sh
node scripts/start-local-preview.mjs --model-provider codex --allow-cloud --model gpt-6-sol
```

The selected existing Codex connection was signed in with ChatGPT. An actual `CodexCli({ model: 'gpt-6-sol', timeoutMs: 30000 })` request returned `{"ok":true}` with exit 0. The sole prompt was `Return only this JSON object: {"ok":true}. Do not access any files, tools, apps, websites or other context.` It used the existing adapter's empty working directory, ephemeral run, ignored user configuration, read-only sandbox and disabled tools. No user conversation, screenshot or document was supplied. This was a direct provider smoke, not a main-app task or computer-use verification.

Read-only connection discovery checked credential presence and provider/model information without printing or copying credentials. The repo's existing Gemini credential was present; a harmless fixed-text request to `gemini-2.5-flash` returned 404 `NOT_FOUND`, while authenticated model listing was HTTP 200. No Gemini credential was added to the preview. Claude Code also reported an existing account; it was not selected or exercised. Existing Ollama models were local Qwen/Llama models; no cloud model was installed or account created.

The launcher passes the selected model to its host, reports OpenAI external text/image egress to the native app, and enables that selected provider for computer-vision images. Native target consent and transaction authorization gates remain unchanged. Model failure does not fall back to Qwen. No API key is imported from `.env`, no CLI credential is copied, and no new API billing setting is enabled. Use still consumes the existing account's allowance.

## Verification

- `node --test scripts/tests/managed-local-preview.test.mjs`: **24 passed, 0 failed, 0 skipped**. Complete output: [external-model-launcher-tests.log](external-model-launcher-tests.log).
- Covered: explicit external opt-in, legacy local configuration, persisted restart, switching back to local, invalid saved permissions, provider/model environment isolation, external image disclosure, safe CLI readiness failures, an omitted Codex model name displayed as `Codex標準モデル`, and rejection of Ollama cloud names or remote-model metadata.
- Formatting and `git diff --check` passed. Source hashes and selected-provider smoke metadata: [external-model-verification.json](external-model-verification.json).
- Startup readiness invokes only CLI version/login checks, not a model generation. The separate harmless smoke above was intentionally authorized for connection verification.

## Main-app follow-up and remaining limits

Root restarted the dedicated preview with these flags and observed Home naming OpenAI `gpt-6-sol`. An actual app → Gateway → host fictional memo request completed and displayed all three checklist items. Follow-up read-only API, artifact, registered-provider and live process-scope checks corroborated that route. Details and binary/source provenance are in [MAIN_APP_BOUNDED_REUSE.md](MAIN_APP_BOUNDED_REUSE.md). This was a text request, not an external screenshot-model test; per-generation upstream model receipts are not exposed by the current task API.

This change supports the existing Codex adapter; it does not add an Ollama cloud adapter. Standard Ollama `/v1` on port 11434 receives `/api/show` locality validation, including renamed remote aliases; arbitrary custom loopback proxies are outside that metadata validation. A loopback URL alone is not evidence that their inference is local.

Native translation routing follow-up (source implemented; runtime verification pending): selecting Codex now also selects Codex for meeting translation, preserving the selected `ASTRA_CODEX_MODEL` and using `gpt-6-sol` when no translation model was specified. The launcher passes the absolute Codex executable it verified to the scoped app instance. Explicit local/API translation choices remain available. Codex translation sends quoted transcript chunks through a dedicated ephemeral, read-only CLI invocation with tools/apps/plugins/web access disabled; it never falls back to Qwen. The existing translation prompt, complete utterance chunking and successful-chunk cache remain unchanged. A shared permit allows one Codex translation process, with bounded output, cancellation/timeout termination and private temporary-directory cleanup. Added tests use a stub runner, not real inference. No translation quality, process-lifecycle runtime, or new UI visual pass is claimed by this source update.

No commit, push, production release, real order, or real trade was performed.


## Separate screen authorization correction (2026-10-02 completion follow-up)

The earlier launcher made `--allow-cloud` also set `ASTRA_COMPUTER_VISION_EXTERNAL=on`. That behavior was overly broad: consent for conversation and user-attached material did not separately express consent to automatic computer-use screenshots. The completion follow-up removes that implication. Current managed launches require `--computer-use --allow-external-screen` with the explicitly selected Codex model, persist the screen choice only for the exact provider/model in the same state directory, and invalidate it when that selection changes. `--no-external-screen` clears the saved screen choice. Old runtime configurations with only `allowCloud` remain conversation-only. Per-run target consent is unchanged.

The earlier 24-test evidence and observed environment above remain historical; they do not establish this corrected screen boundary. Current source, regression and live-probe scope are recorded in [the completion evidence](../2026-10-02-completion/EXTERNAL_SCREEN.md). No claim that the Codex subscription is free follows from the local budget policy's `free` label.
