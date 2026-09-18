# Computer use

Genie can optionally execute a small, explicit set of Mac input actions through the local Agent Host. Computer control is **off by default** and is separate from model access.

## Start

From current source on macOS:

```sh
node scripts/start-local-preview.mjs --model qwen3.5:9b --computer-use
```

The managed launcher builds the local `uxin` helper, starts the Agent Host with computer use enabled, and keeps the helper path inside the local process environment. Xcode Command Line Tools are required to build the helper.

Without `--computer-use`, computer actions are not advertised or executed.

## Execution boundary

The model does not receive unrestricted Mac control. Device steps pass through `ComputerRuntime`:

```text
request
  -> typed computer step
  -> device-side capability check
  -> approval proof check
  -> argument validation
  -> local helper
  -> re-observe UI state
  -> verification result
```

Supported steps:

- `computer.run`: a bounded observe → plan one action → act → re-observe loop. It requires explicit approval before the run starts, has a hard action limit, and stops when the planner reaches a new important boundary.

- `computer.observe`: read the active app/window/focused role and pointer position.
- `computer.click`: click a validated screen coordinate.
- `computer.type`: type bounded text.
- `computer.key`: send a validated key code with `opt`, `cmd`, or `shift`.

Every mutating step requires an approval proof. Connecting Codex, Claude Code, an API model, or Ollama does not grant computer control.

## Observe -> act -> verify

Before a mutating action, the host records a lightweight UI observation. After the action it observes again. The result includes `before`, `after`, and `changed`.

When a step sets `expectChange: true`, an unchanged observed state fails with `computer.verification_failed`. This prevents an action from being reported as complete merely because an input event was emitted.

The observation deliberately contains no screenshot pixels or text-field contents. Rich visual understanding continues to use Genie's existing screenshot/visual-context path and its egress rules.

## Route policy

Computer input is a fallback, not the default integration path. The Mac client keeps the execution preference:

1. Plugin / API
2. Application API / MCP
3. Browser DOM
4. Accessibility API
5. Vision/UI input

If a structured API can perform and verify the operation, use it instead of coordinate clicking.

## Safety invariants

- Off by default.
- Device-side opt-in is required.
- Mutating actions require approval.
- The host validates action arguments again even if the cloud already validated them.
- One host step runs at a time.
- Unsupported actions fail visibly.
- An expected UI change must be re-observed before success is reported.
- Codex remains in its read-only, computer-use-disabled route for ordinary language-model calls.

## Current scope

This provides a production-shaped execution boundary for local Mac input and verification. It does not claim that arbitrary websites or applications are safe to automate. Site-specific workflows should prefer APIs/DOM/Accessibility and define their own completion evidence rather than relying only on visible change.

## Autonomous planner

`computer.run` is the higher-level route for a small, explicit goal. Each turn obtains a fresh device observation, asks the selected local/BYOK model for exactly one constrained action, executes it through the same `ComputerRuntime`, then observes again. A verification failure is returned to the planner once as evidence for re-planning; other execution failures stop the run.

The planner can only emit `click`, `type`, `key`, `done`, or `stop`. It cannot emit shell commands, arbitrary tools, URLs, connector calls, or new permissions. The default hard limit is 12 mutating actions. Reaching the limit fails visibly instead of continuing in the background.

The planner prompt treats screen text as untrusted data. It must stop at newly encountered login, payment, send/publish, delete, or permission-change boundaries. A `done` decision is valid only when the latest observation supports completion.
