# Local demo: one useful document

Use [FIRST_RUN](../FIRST_RUN.md) with a source-matched Mac app and local Ollama. This is a reproducible local demo, not a published video or hosted service. Existing website videos predate this change.

1. Show Home and the model destination. Select **メモをチェックリストに**, point out that the sample is editable and has not been sent.
2. Submit the fictional notes once. Keep the working state visible; if shortening the wait in a recording, label the cut.
3. Open the actual result in Work. Check three tasks and unknown owners.
4. Choose **編集**, add a short Japanese note, and save locally. Explain that this does not call the model again.
5. Choose **保存…**, inspect the Markdown file including its title and original request.
6. Navigate Home→same task, then quit/reopen. Show the same saved edit.
7. Demonstrate an empty edit being rejected; Escape restores the saved version. Do not call acceptance, spinner, or fixture text a successful generated document.

Actual synthetic output and test evidence: [RESULTS](RESULTS.md). Do not show credentials, normal-user history or unrelated windows. No publication is authorized by this demo script.

## Response-loss recovery (current revision)

Open a saved unknown request in Work. The app queries its receipt and resumes observation of the existing task;「状況を確認」performs only reads. A resolved receipt without a task may instead restore a clarification or notice. Never describe receipt resolution as document completion. [Actual injected response-loss run](RECOVERY.md) used one POST, receipt GET, original task ID and identical saved output. Old receipt-less records and pre-dispatch crashes remain outside this success case.
