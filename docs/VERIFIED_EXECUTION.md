# TaskDock → routed execution → verified result

The existing TaskDock/Home request field now accepts a deliberately small set of explicit action requests. A new `execution.run` task connects the conversation entrance, device-side intent preparation, read-only capability probes, the existing full-preview approval card, single-attempt execution and a typed evidence receipt. This is source-level developer-preview functionality, not a new packaged DMG or a claim that arbitrary applications can be automated.

## Try a bounded task

Use matching current Mac app and backend source. Connect the relevant Gmail/Google Calendar **actions** account in Connections; a read-only connection is not sufficient. The selected model prepares a proposal but never grants permission.

Examples for the existing request field:

- `Gmailに a@example.com 宛て、件名「日程確認」、本文「明日お願いします」の下書きを保存して。`
- `Googleカレンダーに、予定名「確認」、開始2026-10-01T10:00:00+09:00、終了2026-10-01T11:00:00+09:00で予定を登録して。`
- `入力欄に「こんにちは🌸」を入力して。`
- `アプリ画面の設定を開いて。`

The draft preview explicitly states **draft, not sent**. A request with a negation such as `送信しない` conservatively remains non-executing; no draft can be sent by this execution route. Questions, negations, quoted instructions and ordinary “write a draft” composition requests do not enter execution. Ambiguous references retain the existing clarification flow.

The user sees the prepared destination, exact content/dates and verification method **before** approval. To change that content, cancel and submit a new request; the confirmed plan is immutable. Native field/screen routes then obtain separate local target/input consent. Nothing is sent or modified during capability probing.

## Actually supported routes

| Goal                                          | Available implementation                                                | Evidence required                                                                    |
| --------------------------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Save one Gmail draft                          | Connected Gmail API; otherwise an explicitly mapped trusted MCP adapter | Separate draft readback, ID/recipients/subject/body match, still a draft             |
| Create one own-calendar event without invites | Connected Google Calendar API; otherwise explicitly mapped MCP          | Separate event readback, ID/title/start/end match, no attendees                      |
| Insert supplied single-line text              | Native macOS Accessibility helper                                       | The pinned non-secure field's full expected value matches after insertion            |
| A small selected-app screen goal              | Existing screenshot-grounded ComputerVisionRuntime                      | Its separate fresh-image visual verification; **not** durable-save or delivery proof |

Candidates are ranked API → mapped MCP → Accessibility → Vision only when they implement the **same operation and the required evidence level**. A visual route cannot replace a missing saved-data readback route. Missing credentials, permission refusals, missing helpers/tools or incompatible evidence produce an unavailable/needs-input result, never a fabricated completion. No Browser DOM adapter is advertised. There is no arbitrary MCP-tool selection, universal app chain, invoice/PDF-to-expense workflow, email sending, invite sending, recurring event support, or unattended desktop operation.

The Vision probe verifies configured helper/model eligibility; its native permission, target selection and screen-recording checks still happen immediately before capture. A successful prepare is not a guarantee that a later OS permission check will succeed.

## Native setup

The existing launcher flag builds the field helper alongside the screenshot helper:

```sh
node scripts/start-local-preview.mjs --model <installed-vision-model> --computer-use
```

Manual host setup can set `ASTRA_EXECUTION_AX_HELPER` to an absolute path produced by `bash scripts/build-execution-helper.sh`. The field helper uses Accessibility without screenshots. Vision retains its existing `ASTRA_COMPUTER_USE`, helper and external-image consent boundaries. These are setup flags, not commands required in everyday TaskDock use. TCC permissions are never bypassed. This change preserves Dock geometry/styles rather than redesigning them.

## Optional mapped MCP route

Set **on the Agent Host** `ASTRA_EXECUTION_MCP_CONFIG=/absolute/user-owned/config.json`. The file must be owned by the current user and not writable by others. Setting `trusted: true` is an explicit local trust decision about the server, not a model or server-provided flag. Do not trust arbitrary servers just because they claim their tools are read-only.

```json
{
  "trusted": true,
  "label": "My draft integration",
  "server": {
    "id": "my-drafts",
    "transport": "http",
    "url": "http://127.0.0.1:9000/mcp",
    "surface": "local",
    "tool_risks": {
      "create_draft": "EXTERNAL_COMMIT",
      "read_draft": "READ"
    }
  },
  "bindings": [{ "operation": "mail.draft", "writeTool": "create_draft", "readTool": "read_draft" }]
}
```

The existing MCP client/protocol is used. A write tool accepts canonical `{to,subject,body}` or `{title,start,end}` and returns `structuredContent: {id}`. A distinct read tool accepts `{id}` and returns `{id,to,subject,body,draft:true}` or `{id,title,start,end,attendees:[],cancelled:false}`. Free-text success and a write response's `verified:true` are not evidence. HTTPS is required outside loopback. Stdio is also supported with an absolute executable and no inherited environment. Automatic OAuth onboarding or arbitrary argument remapping is not included.

## Approval, cancellation and replay

`execution.prepare` is a metered, single-attempt model call followed by read-only probes. Its private immutable plan expires after 15 minutes. `execution.apply` binds that exact plan to the task approval, pins it to the preparing host, reprobes the same adapter/fingerprint, and requires a matching unexpired proof. A different connection/plan is not silently substituted. A local exclusive start journal prevents repeating an ambiguous write after restart. Never remove start journals to resume a task whose side effects are uncertain.

TaskDock's stop sends the real task cancellation endpoint. The host checks status before starting and approximately every second while running; HTTP/CLI/native operations receive cancellation. A lost authorization/status response stops rather than continuing blindly. Network and native-operation latency can delay stopping; already applied changes are **not undone**. Work can refresh the same task without resubmitting it. The monitor does not approve two jobs simultaneously.

## Receipt and privacy

A typed receipt is interpreted only for an authenticated `execution.run` task, never from ordinary model-written prose. The UI uses distinct labels:

- `保存内容を照合済み`: independent API/mapped-MCP readback.
- `入力欄を照合済み`: a field value, with save/send explicitly unverified.
- `画面表示を確認済み`: visible evidence only, with save/send explicitly unverified.

Insufficient evidence never receives a verified badge. This is application verification against returned data, not a cryptographic attestation that a remote provider can never lie. Prepared plans and cloud approval details necessarily contain the text/recipients the user must review. The local plan files have owner-only permissions; they are retained for diagnosis (expiry blocks execution, not deletion). Start journals contain timestamps and hashed IDs. Receipt artifacts contain route/evidence level, a fixed summary and an evidence hash, not OAuth tokens, captured pixels or copied field contents. Existing screenshot cleanup/retention remains unchanged.

## Validation

Regression tests cover lane selection, preparation without writes, immutable approval binding including JSONB key order, route changes, no fallback/replay after writes, real connector request/response wiring with separate account-bound readback, mapped MCP calls, cancellation, and strict receipt decoding. The native helper self-tests UTF-16 Japanese/emoji insertion and refuses invalid ranges. The dedicated macOS workflow additionally compiles the real Mac app and helper. Passing automated tests is not evidence of real OAuth credentials, interactive TCC/GUI operation or model success rates; those remain explicit interactive acceptance checks. Database-dependent tests are run by the repository's normal CI, not counted as locally passed when skipped.
