# Start the local preview together

The managed launcher prepares the database and runs the gateway, task worker and agent host in one terminal. It needs **Node 22+, Docker, Genie.app, and either a signed-in Codex CLI or an installed Ollama model**. You no longer need to install `psql`, `dbmate`, or pnpm manually, run SQL commands, or manage three terminals.

This launcher was added after the v0.1.4 distribution and is not inside that DMG. Build the Mac app from the same source revision. The launcher checks the display version before setup, but that check alone cannot distinguish different revisions sharing version 0.1.4. The existing [manual setup](LOCAL_PREVIEW.md) remains available.

## Start with the existing external connection

Build the app from this checkout with `pnpm build:macos-app`, using Xcode, its command-line tools, Rust and the [native build prerequisites](LOCAL_PREVIEW.md#requirements). This produces `apps/genie-macos/build/Genie.app`. Ollama, `dbmate` and `psql` from the manual setup are not requirements for the external model route. Finish Docker's initial setup and sign in to your existing Codex CLI before starting.

From the repository root:

```sh
node scripts/start-local-preview.mjs --app apps/genie-macos/build/Genie.app \
  --model-provider codex --allow-cloud --model gpt-6-sol
```

This uses the signed-in Codex CLI itself and avoids loading an Ollama model. The launcher does not read or copy its credentials or import API keys from `.env`. The model and conversation/attachment external-send choice persist in this preview's configuration. Home names OpenAI and the selected model. Submitted text and attachments use the account's existing allowance; this is not a guarantee of free usage. No extra API billing setting is enabled. Startup checks CLI availability/login without generating a prompt. If the connection is unavailable, startup or the request fails without falling back to Qwen. Docker and the local services still run on the Mac.

The launcher opens a separate app instance through LaunchServices with this preview's data directory and model disclosure. A normally running Genie instance stays open; use the preview's own Home for this workspace. On later starts, reuse the same command, or copy the matching app to Applications and open **`Start Genie.command`** to reuse the saved model choice. After the standard workspace reaches ready, directly opening the matching Genie.app also retains that connection, model and workspace. Direct app launch does not start stopped services; restart the launcher when the connection is unavailable. The unconfigured launcher default remains local; first launch never chooses an external provider for you.

## Claude Code or the Gemini API instead of Codex

Two more external providers avoid loading an Ollama model. Each needs the same explicit `--allow-cloud`, is saved only for that provider, and never falls back to another provider or to a local model.

```sh
# The signed-in Claude Code CLI (checked with `claude auth status`; its credentials are not read)
node scripts/start-local-preview.mjs --app apps/genie-macos/build/Genie.app \
  --model-provider claude_code --allow-cloud

# The Gemini API, using a key stored in the macOS Keychain
node scripts/start-local-preview.mjs --app apps/genie-macos/build/Genie.app \
  --model-provider gemini_api --allow-cloud
```

Defaults are `claude-sonnet-5-5` and `gemini-2.5-flash`; `--model` selects another. Submitted text goes to Anthropic or Google respectively and uses that account's quota. The Gemini key is never passed as an argument, read from `.env`, or written to the preview's files: the launcher only checks that the Keychain item exists and, when it does not, prints the `security add-generic-password … -w` command that prompts for it. This is a separate Keychain item from the one the Mac app uses for Gemini Live voice. Screen-image egress (`--allow-external-screen`) remains limited to the Codex connection.

Verified on 2026-10-02 with Claude Code: the real meeting-summary selftest returned an answer and the stop selftest reached terminal `CANCELLED`. The Gemini path was verified only up to the missing-key instruction; no request was sent to Google.

## Local inference as an option

To explicitly use a model installed in Ollama:

```sh
node scripts/start-local-preview.mjs --app apps/genie-macos/build/Genie.app \
  --model-provider local --model qwen3.5:9b
```

Use `--model llama3.2` instead if that is the text model you already have. Image requests require a vision-capable model. Without a model argument, local mode offers an interactive choice when multiple models are installed. The choice persists. No model is downloaded automatically and no paid provider is selected as a fallback. Local model memory requirements are additional to those of the app and services.

## Optional background computer use

Computer use is off by default. It is not needed for ordinary text requests. To use the selected external model for automatic screen images, explicitly add both flags:

```sh
node scripts/start-local-preview.mjs --app apps/genie-macos/build/Genie.app \
  --model-provider codex --allow-cloud --model gpt-6-sol \
  --computer-use --allow-external-screen
```

`--allow-cloud` alone does not authorize automatic screen images, and adding only `--computer-use` does not grant external egress. The separate screen choice is saved in this state directory as `externalScreenAuthorization` for the exact provider and model. Restarting that same selection reuses it; a model/provider change invalidates it. Local mode cannot accept `--allow-external-screen`. The runtime capability `--computer-use` is still required on each start. Clear the saved screen choice on the next start with `--no-external-screen`; this retains the conversation connection.

The launcher builds or uses the selected native helper. Its OS permissions, task approval and native target-window/recipient consent remain required. These flags do not grant them or authorize a transaction. `node scripts/computer-use.mjs check` reads the running supervisor's actual helper status, including the current permissions, capabilities, selected recipient and effective external-screen permission; it does not capture or send a screen. For local computer use, add only `--computer-use` to the explicit local example above. See [computer use setup and limits](COMPUTER_VISION.md).

Ollama cloud names and remote-model metadata are refused in local mode: a loopback URL alone does not establish that inference stays on the Mac. This launcher currently supports external Codex and local inference, not an Ollama cloud adapter.

The first run downloads a pinned pnpm, workspace dependencies, and container images, then applies migrations and creates the restricted application roles. Progress and actionable errors are displayed in Japanese. It opens the real Home when the gateway, Temporal pollers and local host have been checked. Keep that terminal open while using Genie.

Ask Home to write a checklist for testing the app, capturing a demo and writing release notes. Keep unknown owners unassigned. Open the result in Work, use Edit to correct the text locally, save Markdown, navigate away and reopen it. Markdown contains the title, edited text and original request; original generated text remains stored. No model request is made by editing, saving or reopening.

## Stop and reopen

Ctrl+C stops only the app and services owned by this launcher. It retains results, configuration and database volumes. Run the same launcher to resume. You can also use another terminal:

```sh
node scripts/start-local-preview.mjs status
node scripts/start-local-preview.mjs stop
```

An interrupted setup can be rerun. Duplicate starts fail without replacing the active process. A failed service stops the managed group and reports the relevant log; requests are not automatically resubmitted. Startup and readiness checks perform no model generation.

## Data and isolation

The default state directory is `~/Library/Application Support/Genie/local-preview`. Database and Redis data are in named volumes belonging to its dedicated Docker project. The app's history and files use the state directory. The gateway uses `127.0.0.1:43123`; other published ports also bind only to loopback.

Existing `.env` files, manually running services, database volumes and prior app history are not changed or imported. Only the standard state directory saves a private, non-secret `desktop-connection.json` after successful readiness. A normal direct app launch reads that selected connection, desktop identifier and workspace; custom preview directories, explicit launch environments and selftests retain their isolation. This file contains no tokens, signing key, readiness assertion or new screen permission. Changing the saved selection first invalidates the previous direct-launch choice; it becomes usable again only after the new selection reaches ready. Missing setup keeps the unconfigured behavior; an existing but invalid or inaccessible descriptor blocks model requests and translation instead of falling back to a local model. Repair the launcher configuration and start it again. Periodic external-service sync is disabled.

To create another isolated preview, choose an empty directory and a free port on its first run:

```sh
node scripts/start-local-preview.mjs --app apps/genie-macos/build/Genie.app \
  --state-dir "$HOME/Library/Application Support/Genie/second-preview" --port 43124 \
  --model-provider codex --allow-cloud --model gpt-6-sol
```

Use that same `--state-dir` with subsequent start, status and stop commands. Logs live in `logs` under the state directory. Configuration contains local credentials and logs can contain request content: report the stage and a redacted error summary, not entire files. Do not delete volumes as a recovery step.

This remains a developer preview, not a consumer installer bundling Node, Docker and a model. Recording and external service connections need their own setup and permissions. See [the detailed Japanese guide](MANAGED_PREVIEW.ja.md) and `node scripts/start-local-preview.mjs --help` for options.
