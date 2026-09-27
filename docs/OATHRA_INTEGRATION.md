# Oathra integration

Oathra is a separately operated phone service. Genie can prepare a request, let a human review it, and read Oathra's evidence-backed outcome. This change does not install a carrier, share voice-provider keys, place a call, or deploy either service.

## Native macOS entry

Build the native app with the existing macOS build instructions. Open **Genie → Oathraと連携…**.

1. Enter the Gateway origin (for example, `http://127.0.0.1:4244` in local simulator mode) and that account's operator token. This is not the Arena URL or a Google/OpenAI API key. The token is saved in this Mac's Keychain, not in model context or preferences.
2. Enter the recipient, phone number, purpose and caller name. Choose from the Gateway's actual available engines and presets. Saving creates a draft only.
3. Alternatively, paste the `missionId` returned to another MCP client into **ほかのAI・MCPで作った依頼を開く**. The authenticated account must own the draft.
4. Choose **この下書きの内容・料金を確認**. Review the entire purpose, recipient, mode, cost/credit conditions and data notice. The separate final button submits Oathra's existing consent and one-time review grant. A simulator is visibly labelled and never presented as a real call.
5. The window reads the existing mission; it does not recreate it to check progress. Unknown execution stays unknown. A call ending is not a confirmed booking. Closing the window stops convenience polling, not the server's ongoing call.

There is no automatic voice substitution. Gateway does not offer Arena-only `character-tts`. Existing Oathra safety rules and evidence verdicts remain server-owned. The human window is not exposed as an approval tool to an LLM.

## MCP integration for the local Genie host

After the corresponding Oathra MCP change is installed and the packages are built:

```ts
import { connectOathra } from '@genie/mcp';

const oathra = await connectOathra({
  serverPath: '/absolute/path/to/oathra/apps/gateway/mcp.mjs',
  gatewayUrl: configuredGatewayOrigin,
  token: await readTokenFromLocalSecretStore(),
});
try {
  const capabilities = await oathra.capabilities();
  // Obtain the recipient/purpose from the user's request; do not guess a number.
  // `approved` is a host decision to forward the draft data, never an LLM argument.
  const draft = await oathra.draft(phoneRequest, { approved: userApprovedDataTransfer });
  // Display draft.missionId to the user. Human dialing is a separate native UI action.
  const result = await oathra.result(draft.missionId);
  // Keep canonical status, null evidence and simulator mode. Do not infer success from ended.
} finally {
  await oathra.close();
}
```

The client exposes only capabilities, draft, result and close. It never exposes start/approve/cancel/payment. Child-process environment is explicitly limited to the Gateway origin and account token. The notification following MCP initialization does not wait for a nonexistent response.

The TaskDock natural-language planner and automatic Work Graph/result insertion are **not wired by this increment**. Do not advertise voice-command-to-automatic-call behavior. The native menu and typed MCP adapter are the implemented entry points. Account installation and production deployment remain explicit operator work.

## Verification

```sh
pnpm --filter @genie/mcp... build
pnpm --filter @genie/mcp test
bash scripts/check-oathra-client.sh
```

The Foundation self-test compiles on macOS and Linux and makes only fixture-transport requests. MCP tests use Genie's real client/channel against a wire fixture; the Oathra repository tests its server against local HTTP fixtures. The dedicated macOS workflow type-checks the two native integration files against real AppKit/SwiftUI/Security without requiring the Rust app bundle. These checks are not a full native-app interaction test or real telephony test.

Not verified during implementation: signed app launch, Keychain prompts on a real Mac, VoiceOver/IME/zoom behavior, a deployed account's actual billing, or a real phone call. No API-key-bearing data is included in tests.
