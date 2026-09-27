# First success: notes → a saved checklist

Use a Mac (macOS 14+), Node 22+, Docker Desktop and an installed Ollama text model. Build Genie.app from **the same checkout** as the services: [source setup](LOCAL_PREVIEW.md). An equal display version is not proof of equal source. The v0.1.4 DMG does not include the managed launcher or current document editing.

## 1. Start the managed workspace

```sh
node scripts/start-local-preview.mjs --app apps/genie-macos/build/Genie.app --model qwen3.5:9b
```

Use a model you already have (`ollama list`); no model is downloaded automatically. The launcher downloads dependencies/container images on first setup, prepares an isolated database, checks the services, then opens Home. Keep its terminal open. Failed startup names the next action and log location; fix that cause and rerun the same command. Read [managed preview](MANAGED_PREVIEW.md) for build paths, stop/status and storage.

**`pnpm doctor` diagnoses the older manual `.env` setup only.** It checks dbmate/psql and port 3000, not the managed workspace on port 43123. Do not install those extra tools or create `.env` just to make that diagnostic green for the managed route. For a manually configured setup, `pnpm doctor:json` returns schema_version 1, exits 0 for prerequisites checked, 1 for missing prerequisites, and 2 for an incomplete diagnostic. Neither route's readiness proves task success.

## 2. Make one useful document

In Home, choose **メモをチェックリストに**. This fills an editable example; it does not submit it. Review or replace the fictional input:

> 次のメモを、次の行動と担当者が分かるチェックリストにしてください。アプリをテストする、デモを録画する、リリースノートを書く。分からない担当者は「未定」とし、文章だけを作ってください。

Send it once. The managed route uses your selected loopback Ollama model; no paid-provider fallback, microphone, screen permission or external account is needed. Other configured model routes may send content externally and incur provider charges. Do not attach private data for the first test.

## 3. Verify, edit and keep the result

In Work, inspect the actual result: all three tasks, next actions, and no invented owners. Choose **編集**, change text, then **編集を保存**. This saves locally and keeps the original generated text. Closing the editor with **やめる** discards that unsaved edit. Choose **保存…** to export UTF-8 Markdown containing the title, edited text and original request. Check the saved file. Leave Work and reopen the same task: your edit must remain. Editing, copying, exporting and reopening do not generate again.

## If it stops

- **作成中 / 続行待ち**: no completed result yet. Check the existing task, not a new submission.
- **状況を確認してください** with a known task: use **状況を確認** to read the same job after restoring connectivity.
- Acceptance unknown: open the saved request in Work and use「状況を確認」. New requests keep a receipt ID before submission; lookup can recover the original task without sending the request again. Pending/not-found receipts remain unconfirmed. Older records without a receipt ID cannot use this path. Do not submit a replacement while an earlier outcome is unknown.
- Failed local save: keep the editor open, resolve disk/storage access, then save again. Export failure does not remove the stored task.
- Ctrl+C stops the managed services while retaining data. Restart with the same state directory. Never delete volumes to recover.

[Acceptance and evidence](quality/acceptance.md) distinguish real generation, native fixtures, and unverified release gates. Historical demos show older behavior and do not prove this checkout works.
