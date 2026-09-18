# Try Genie and shape the next release

[日本語](TESTING.ja.md) · [Report a first test](https://github.com/FORIFOR/genie/issues/new?template=tester_feedback.yml)

We are looking for Mac users who can run a developer setup and tell us whether one real task becomes easier. The most valuable report is the first confusing step, even if you never reach the result. You do not need to contribute code or join a waitlist.

Genie was previously named Astra. For this preview, look for **Genie.app** and the `FORIFOR/genie` repository.

## Choose how to try it

| Path                 | What you can do                                                                                                                                                                                                       | Setup                                                                                |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| See the result first | [Watch three real workflows](https://reachmade.com/en/products/genie/demos/#prototype) or [explore the orbital HTML sample](https://reachmade.com/media/originals/genie/orbit.html). Share what you would want to use it for. | Browser only. This is a demonstration, not a hosted Genie session or a Mac app test. |
| Test the Mac preview | Give a goal, review the result, reopen it in Work, and save Markdown.                                                                                                                                                 | macOS 14+, local services and a model; follow the steps below.                       |

The exercise takes about 10 minutes **after setup**; downloads and developer setup take additional time. No Google/Microsoft account, microphone permission, or real customer data is needed for this exercise.

## 1. Use the matching app and source

Use **v0.1.4** for this first-test path. Do not mix this app with the current `main` backend.

- [Download Genie-0.1.4.dmg](https://github.com/FORIFOR/genie/releases/download/v0.1.4/Genie-0.1.4.dmg)
- [Release notes, checksums, and known limits](https://github.com/FORIFOR/genie/releases/tag/v0.1.4)
- Matching source: tag `v0.1.4`.

```sh
git clone --branch v0.1.4 --depth 1 https://github.com/FORIFOR/genie.git genie-preview
cd genie-preview
```

Follow the [setup guide at v0.1.4](https://github.com/FORIFOR/genie/blob/v0.1.4/docs/LOCAL_PREVIEW.md). You have already cloned the repository: start its first command block at `pnpm install`. Keep using the `genie-preview` directory in each terminal.

You will need Node 22+, pnpm 10.12.2, Docker Compose, `dbmate`, `psql`, Xcode command-line tools, and a model that fits your Mac. The app alone is not sufficient: keep the gateway, task worker, and agent host running. The guide uses local Ollama; its verified example is `qwen3.5:9b`. Model downloads and memory requirements are additional. Full Xcode and Rust are needed if you build the native app from source instead of using the DMG.

For a single-page Japanese walkthrough, including a separate read-only diagnostic that also works with the v0.1.4 checkout, see [the first-start guide](LOCAL_PREVIEW.ja.md). It reports missing prerequisites without starting services or generating a model response; passing its checks does not prove that the worker or a complete task works.

Already running a working setup? Keep your data and configuration. Record the app/source version in your feedback. Developers using current `main` should [build the Mac app from the same checkout](LOCAL_PREVIEW.md).

## 2. Check readiness, then try one useful task

After opening Home once with the gateway running, run this in the checkout:

```sh
node --env-file=.env scripts/start-local-host.mjs --check
```

This checks the gateway, selected local model, and desktop identity without running an AI request. Then start the host as described in the setup guide. If a check fails, report the error without tokens or your `.env`; you do not need to keep retrying.

Choose **one** prompt, or use your own non-sensitive example:

| Task              | Paste into Home                                                                                                                                                                              | A useful result should…                                                |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Make a plan       | “Turn these notes into a checklist with next actions and owners: test the app, record a demo, write release notes. Keep unknown owners unassigned.”                                          | Cover all three tasks without inventing owners.                        |
| Improve a message | “For a fictional small design studio, improve this headline: We make websites. Give three clearer alternatives, one call to action, and explain your choice. Do not invent customer claims.” | Offer usable alternatives and reasons without fabricated evidence.     |
| Prioritize        | “Fictional weekly signups fell from 120 to 84 while visits stayed at 2,000. Propose three checks to investigate. Separate observed facts from hypotheses.”                                   | Calculate the change correctly and avoid claiming an unverified cause. |

## 3. Take the result into your next task

- [ ] The request accepts text and starts successfully.
- [ ] The answer is relevant and useful, or you can explain what is missing.
- [ ] Leave the task, then reopen the same result in Work.
- [ ] Copy the result or save it as Markdown and check its contents.

Optional: attach a screenshot of synthetic data and ask a specific question. This requires a vision-capable model; `llama3.2` alone is text-only. Screenshot detection does not send an AI request.

## 4. Tell us where it helped—or got in the way

**[Send a short tester report →](https://github.com/FORIFOR/genie/issues/new?template=tester_feedback.yml)**

Report completed tests, setup failures, or demo-only impressions using the same form. Three required answers: how far you got, your task, and the result or first blocker. Version/model details help when available. Japanese and English are welcome. One report per distinct test is enough; no email address is required.

Reports are public. Use fictional examples; omit customer data, tokens, `.env`, and private meeting content. You can describe a problem without uploading logs or screenshots. A useful test report is not conditional on starring the repository.

Have a team use case? [Describe the workflow and the useful outcome](https://github.com/FORIFOR/genie/issues/new?template=workflow.yml), without confidential information.

## Known boundaries

- This is an early developer preview, not a one-click hosted service. Setup friction is part of what we need to learn.
- Live transcription and connected services require separate providers and permissions. They are not required for this first test; production acceptance is [tracked separately](https://github.com/FORIFOR/genie/issues/1).
- An explicitly selected local route does not silently switch to a paid provider. External providers receive submitted content and may charge; model quality and latency vary.
- Generated HTML must be reviewed and opened outside the app. Automatic publishing, autonomous SNS promotion, and business returns are not demonstrated by this test.
- There is no project-wide open-source license yet. Public source availability is not a broad license grant.

Stop the host, worker, and gateway with Ctrl+C when finished. `pnpm dev:infra:down` stops the development containers and retains volumes. Do not remove volumes if you want to keep your local work.
