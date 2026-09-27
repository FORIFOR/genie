# Run the Mac developer preview locally

Current source also provides a [managed launcher](MANAGED_PREVIEW.md) that prepares the database and starts the local services together. The steps below describe the manual path.

This is a developer setup, not a one-click consumer installation. It runs a gateway, database, durable worker, and model on your Mac. Do not expose the development authentication endpoint or the supplied database credentials to a network.

## Requirements

- macOS 14+, Xcode command-line tools; full Xcode and Rust for a native source build.
- Node 22+, pnpm 10.12.2, Docker with Compose, `dbmate`, and `psql`.
- Ollama running with a model that fits your machine. Image questions require a vision-capable model. The verified local example is `qwen3.5:9b`; model downloads and memory use are additional to Genie.

## 1. Prepare the checkout and local services

Run these commands from the repository root. If you already have a working setup, preserve your `.env` and existing services instead of replacing them.

```sh
git clone https://github.com/FORIFOR/genie.git
cd genie
pnpm install
cp .env.example .env
pnpm dev:infra
```

Wait for PostgreSQL and Temporal to be ready (`docker compose -f infra/docker-compose.dev.yml ps`). Apply migrations with the local development administrator, then grant the application roles:

```sh
dbmate --url 'postgres://astra:astra@127.0.0.1:5433/astra_dev?sslmode=disable' --migrations-dir infra/db/migrations --no-dump-schema up
psql 'postgres://astra:astra@127.0.0.1:5433/astra_dev?sslmode=disable' -v ON_ERROR_STOP=1 -f infra/db/bootstrap.sql
pnpm build
```

The application uses restricted database roles in `.env`, not the migration administrator. Compose binds development ports to loopback, and `.env.example` binds the gateway to `127.0.0.1`.

## 2. Start the gateway and task worker

Leave each command running in its own terminal, both at the repository root so they share the same local object store:

```sh
node --env-file=.env --import tsx services/api-gateway/src/server.ts
```

```sh
node --env-file=.env --import tsx workers/task-worker/src/worker-main.ts
```

Check `http://127.0.0.1:3000/healthz`. Temporal's local UI is at `http://127.0.0.1:8233`.

## 3. Open the Mac app and connect the local model

Install the Mac build from the release matching this checkout, or build with `pnpm build:macos-app` and open `apps/genie-macos/build/Genie.app`. The build script prepares the Rust archive for macOS 14 and bundles Sparkle. If the pinned Sparkle runtime is missing, first run `bash scripts/fetch-sparkle.sh`; a full Xcode and Rust toolchain are still prerequisites. Open Home once while the gateway is running; this establishes the desktop's local development identity.

In another terminal:

```sh
ollama pull qwen3.5:9b
node --env-file=.env scripts/start-local-host.mjs --check
node --env-file=.env scripts/start-local-host.mjs
```

The helper uses the Mac app's identity, installs its general task capability, and starts an agent host with Ollama selected explicitly. You do not copy authentication tokens. It only accepts local HTTP endpoints, disables periodic background work sync, and does not choose a paid fallback. Keep the host terminal open; Ctrl+C stops that host.

For another installed model, set `ASTRA_LOCAL_LLM_MODEL` to its exact model name when starting the helper. Use a vision-capable model for screenshots. `llama3.2` by itself is a text model; installing it does not add image understanding.

## 4. Try the complete workflow

1. In Home, ask: “Turn these notes into a checklist: test the app, capture a demo, write release notes.”
2. Wait for the result, open it in Work, then copy or save it as Markdown.
3. Take a screenshot of a non-sensitive example with macOS. Choose Genie's offer to ask about it, enter your question, and send.

The screenshot is not automatically submitted just because you captured it. Mac permissions are requested for the feature that needs them; text requests do not require microphone access.

## If something is missing

| Symptom                                             | Check                                                                                               |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| “Open Genie once”                                   | Gateway is reachable; Home has been opened using this Mac app and gateway address.                  |
| Model not found                                     | `ollama list` contains the exact model named in `ASTRA_LOCAL_LLM_MODEL`.                            |
| Request cannot find an agent                        | Gateway, task worker, and the local host are running; the helper was started after opening the app. |
| Image cannot be understood                          | The selected model supports vision and the screenshot is attached.                                  |
| Authentication stopped after a gateway restart      | Development keys may be ephemeral. Restart the app/host; do not paste tokens into an issue.         |
| Live transcription or external services unavailable | These need their own provider and permissions; they are separate from the local text/image setup.   |

Stop the host, worker, and gateway with Ctrl+C. `pnpm dev:infra:down` stops development containers while retaining their volumes. Do not remove volumes if you want to keep local data.
