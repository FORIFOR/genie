<p align="center"><img src="apps/desktop/src-tauri/icons/128x128@2x.png" width="88" alt="Genie"></p>

# Genie

**Ask about the work in front of you, then keep the answer where you work.**

Genie is a native Mac app for a small, repeatable loop: bring up TaskDock, optionally attach the screen you are looking at, ask one specific question, and copy the answer without leaving the current work. Run it with Ollama or another model endpoint you choose.

Previously Astra. The app, downloads, and source are now named Genie. Existing settings and accounts are retained.

[Enterprise introduction: measured workflows, limits, and L1/L2/L3 gates](docs/ENTERPRISE_READINESS.md).

**Using Ollama on a Mac? Help test the preview.** Try the loop below with a fictional screen or note, then tell us the first place you get stuck. Setup feedback counts, too. No waitlist or separate signup; a GitHub account is only needed to post feedback.

**[Watch the first workflow →](https://genie-forifor.forifor.chatgpt.site/#demo)** · [Start a first test](docs/TESTING.md) · [Download the Mac preview](https://github.com/FORIFOR/genie/releases/tag/v0.1.4) · [Report your experience](https://github.com/FORIFOR/genie/issues/new?template=tester_feedback.yml)

[Website & demos](https://genie-forifor.forifor.chatgpt.site) · [日本語](docs/README.ja.md) · [Mac preview v0.1.4](https://github.com/FORIFOR/genie/releases/tag/v0.1.4)

## One workflow to try first

1. Open the app or page you are working on. Add a screenshot only when it helps explain the question.
2. Bring up TaskDock and ask: “What are the three problems on this screen and the next checks I should make?”
3. Read the answer in TaskDock, without opening a separate work window.
4. Copy the useful part, or reopen the saved request in Work.

This is the product’s first proof point: less context switching, a clear local or external model route, and a result that can be used immediately. The screenshot is optional; taking one does not send it anywhere until you submit a question.

## More workflows

| Real workflow             | Watch / explore                                                                                                                                          | What the demonstration shows                                                         |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Build a small prototype   | [33-second demo](https://genie-forifor.forifor.chatgpt.site/#demo) · [Try the orbital playground](https://genie-forifor.forifor.chatgpt.site/orbit.html) | Generate HTML, save the result, then open the extracted HTML in an external browser. |
| Improve a website message | [30-second demo](https://genie-forifor.forifor.chatgpt.site/#proposal)                                                                                   | A local model turns a fictional website into a copy proposal.                        |
| Decide what to do next    | [42-second demo](https://genie-forifor.forifor.chatgpt.site/#priorities)                                                                                 | Ask about a fictional dashboard, review a recommendation, and save it.               |

Real app captures; waiting is condensed. Model speed and quality vary. These examples do not demonstrate automatic deployment, SNS posting, or a guaranteed business result.

## Start with a goal

1. In Home, describe what you need and what a useful result looks like.
2. Short questions appear in TaskDock; longer requests continue as work you can reopen in Work.
3. Review the answer or result, copy it, or save Markdown for the next task.

Try: “Turn these launch notes into a checklist with an owner and a next action: test the app, record a demo, write release notes. Mark unknown owners as unassigned.”

A screenshot can add context when you need it; it is optional. Capturing one makes no AI request. The selected image is included only when you send a question.

## Bring your model

| Route | What you need                                                   |
| ----- | --------------------------------------------------------------- |
| Local | Ollama with a vision-capable model for image questions          |
| API   | A supported OpenAI-compatible endpoint and your own credentials |
| CLI   | A configured Codex or Claude Code installation                  |

An explicitly selected route is not silently replaced by a paid provider. Local vision keeps the selected image at the local model endpoint. External providers receive the submitted content and may charge for usage; speed and quality vary by model.

## Quick start

**Developer preview — setup is required.** The Mac app currently needs a local gateway, task worker, agent host, and model. The app download alone is not a hosted service.

**New in source: [start the local services together](docs/MANAGED_PREVIEW.md).** With Node, Docker Desktop and an Ollama model installed, open `Start Genie.command` to prepare the database, start the services and open Home. The launcher keeps a separate preview workspace and stops its services with Ctrl+C. It is not included in the v0.1.4 DMG.

- macOS 14 or later; native SwiftUI app, Apple silicon and Intel builds.
- [Start the tester guide](docs/TESTING.md) for a matching app and source, a first task, and troubleshooting.
- [Build current source](docs/LOCAL_PREVIEW.md) if you want to work on the latest code.
- [Mac builds](https://github.com/FORIFOR/genie/releases): use the build and source version named together in its release notes.
- [See the actual interface and demo](https://genie-forifor.forifor.chatgpt.site/#demo).

The preview includes recording, live transcription, service connections, guided Mac permissions, and an opt-in [screenshot-grounded computer use](docs/COMPUTER_VISION.md). Computer control is off by default, requires explicit local enablement and per-action approval, and is not a prerequisite for the local text workflow. Production-wide release acceptance is still tracked separately from this developer preview.

## Help shape Genie

If this fits how you work, a star helps other people find it. The most useful feedback is a real workflow: what you tried, what you expected, and where Genie got in the way.

- [Share a first test or setup blocker](https://github.com/FORIFOR/genie/issues/new?template=tester_feedback.yml).
- [Report a reproducible problem](https://github.com/FORIFOR/genie/issues/new?template=bug_report.yml).
- [Suggest a workflow or team pilot](https://github.com/FORIFOR/genie/issues/new?template=workflow.yml).
- Read [contribution guidance](CONTRIBUTING.md) before making a change.

Issues are public. Use synthetic examples and remove credentials and personal information. This repository currently has no project-wide open-source license; public visibility is not a license grant. Third-party components retain their own licenses.

## Inside the project

| Directory             | Purpose                                               |
| --------------------- | ----------------------------------------------------- |
| `apps/genie-macos`    | Native SwiftUI Mac app and interaction tests          |
| `apps/windows`        | Native Windows client work                            |
| `core`                | Shared Rust core and native bindings                  |
| `services`            | Gateway, identity, tasks, artifacts, and integrations |
| `workers/agent-host`  | Device-side models and tools                          |
| `workers/task-worker` | Durable task execution                                |
| `packages/contracts`  | Shared Zod contracts                                  |
| `shared/design`       | Design rules and generated tokens                     |
| `docs/evidence`       | Verification records and known limitations            |

The older Tauri client remains under `apps/desktop`; the current Mac interface is `apps/genie-macos`.

```sh
pnpm install
pnpm build
pnpm test
pnpm check:conventions
```

Native and end-to-end checks require additional local dependencies. See [setup](docs/LOCAL_PREVIEW.md), [design rules](shared/design/DESIGN.md), and [`scripts/verify-all.sh`](scripts/verify-all.sh). Product specifications and architecture decisions are indexed in [docs](docs/README.md).
