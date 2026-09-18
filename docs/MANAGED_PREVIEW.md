# Start the local preview together

The managed launcher prepares the database and runs the gateway, task worker and agent host in one terminal. It needs **Node 22+, Docker Desktop, an installed Ollama model, and Genie.app**. You no longer need to install `psql`, `dbmate`, or pnpm manually, run SQL commands, or manage three terminals.

This launcher was added after the v0.1.4 distribution and is not inside that DMG. Run it from current source with a Mac app bearing the same version number; the launcher checks this before setup. The existing [manual setup](LOCAL_PREVIEW.md) remains available.

## Start

Install the Mac app in Applications and finish Docker Desktop's initial setup. From this source checkout, open **`Start Genie.command`**, or run:

If Genie is already running on its own, quit it from its menu first. The launcher detects an existing app process and asks you to close it instead of creating a confusing second workspace window.

```sh
node scripts/start-local-preview.mjs --model qwen3.5:9b
```

To enable the local Mac computer-use runtime, add `--computer-use`. It remains off by default. The launcher builds the local input helper and mutating actions still require approval:

```sh
node scripts/start-local-preview.mjs --model qwen3.5:9b --computer-use
```

See [Computer use](COMPUTER_USE.md) for the execution and verification boundary.

Use `--model llama3.2` if that is the text model you already have. Image requests require a vision model. Without a model argument, an interactive terminal offers a choice if multiple models are installed. The choice persists. No model is downloaded automatically and no paid provider is selected as a fallback.

The first run downloads a pinned pnpm, workspace dependencies, and container images, then applies migrations and creates the restricted application roles. Progress and actionable errors are displayed in Japanese. It opens the real Home when the gateway, Temporal pollers and local host have been checked. Keep that terminal open while using Genie.

Ask Home to write a checklist for testing the app, capturing a demo and writing release notes. Keep unknown owners unassigned. Open the result in Work, save Markdown, navigate away and reopen it.

## Stop and reopen

Ctrl+C stops only the app and services owned by this launcher. It retains results, configuration and database volumes. Run the same launcher to resume. You can also use another terminal:

```sh
node scripts/start-local-preview.mjs status
node scripts/start-local-preview.mjs stop
```

An interrupted setup can be rerun. Duplicate starts fail without replacing the active process. A failed service stops the managed group and reports the relevant log; requests are not automatically resubmitted. Startup and readiness checks perform no model generation.

## Data and isolation

The default state directory is `~/Library/Application Support/Genie/local-preview`. Database and Redis data are in named volumes belonging to its dedicated Docker project. The app's history and files use the state directory. The gateway uses `127.0.0.1:43123`; other published ports also bind only to loopback.

Existing `.env` files, manually running services, database volumes and normal app history are not changed or imported. Work created with this launcher should be opened with the same launcher; opening the app by itself does not connect it to this workspace. Periodic external-service sync is disabled.

To create another isolated preview, choose an empty directory and a free port on its first run:

```sh
node scripts/start-local-preview.mjs --state-dir "$HOME/Library/Application Support/Genie/second-preview" --port 43124 --model llama3.2
```

Use that same `--state-dir` with subsequent start, status and stop commands. Logs live in `logs` under the state directory. Configuration contains local credentials and logs can contain request content: report the stage and a redacted error summary, not entire files. Do not delete volumes as a recovery step.

This remains a developer preview, not a consumer installer bundling Node, Docker and a model. Recording and external service connections need their own setup and permissions. See [the detailed Japanese guide](MANAGED_PREVIEW.ja.md) and `node scripts/start-local-preview.mjs --help` for options.
