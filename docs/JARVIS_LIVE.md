# JARVIS Live Executive

Status: implementation direction for Genie. This document does not replace the existing
deterministic lane, Temporal, approval, audit, or native Computer Use boundaries.

## Goal

Genie should feel like one continuously available work partner:

1. The user speaks naturally from TaskDock.
2. Genie gives a very short acknowledgement when a task is clear.
3. The user can keep talking, interrupt, narrow, or cancel while work continues.
4. Durable work is delegated to Temporal and the local agent host.
5. GUI work uses Computer Use without making the voice model drive every click.
6. Results return to the same TaskDock / Work surface with provenance.

The product should not expose "modes". Voice, research, computer operation, meetings and
ordinary conversation remain capabilities behind one surface.

## Architecture

```
microphone / text
      |
      v
macOS TaskDock
  local activation + local end-of-turn VAD
      |
      +---- Gemini 3.8 Live session ----------------------------+
      |       speech-to-speech, barge-in, short dialogue        |
      |       NON_BLOCKING function calls                       |
      |                                                         |
      |              delegate_task(goal, successCriteria)        |
      |                         |                               |
      +-------------------------v-------------------------------+
                                |
                     Conversation Executive
                      D-48 hard rules first
                      Jev only for fallback
                                |
              +-----------------+------------------+
              |                 |                  |
             chat            research          computer.run
              |                 |                  |
          model answer       research task      Temporal task
                                                    |
                                               agent-host
                                                    |
                                      Screen/AX -> action -> verify
```

### Responsibility split

**Gemini 3.8 Live = conversation plane.** It owns spoken turn-taking, barge-in,
acknowledgements, natural clarification, and function calling. It does not own durable task
state and does not directly decide individual cursor coordinates.

**Jev = System-One decision plane.** It receives small structured state and returns typed
decisions. Use it only where the candidate set is known in code: route, choose one candidate,
score confidence, detect stuck/done from structured evidence, or decide whether to escalate.
It never writes user-facing prose.

**Temporal = durable work plane.** Long-running work, pause/recovery, approvals, retries and
receipts stay here.

**Computer Use = action plane.** It owns actual app/window scope, fresh capture, input,
verification and conflict handling. The voice session delegates a goal, not a click stream.

**LLM / Gemini Flash / local Qwen = System-Two plane.** Use a generative model when new text,
a multi-step plan, visual grounding, synthesis, or recovery reasoning is actually required.

## Live model

Use `gemini-3.8-live` as the default voice model. Keep Extended Thinking out of the hot
speech path. Escalate a background subtask to a stronger reasoning model only when a typed
decision or verification says the ordinary path is insufficient.

The macOS client should connect as directly as deployment security allows. For a hosted
deployment, issue an ephemeral Live token and let the client connect to Gemini rather than
proxying raw audio through the API gateway.

Audio contract:

- input: 16-bit PCM, 16 kHz, little endian
- output: 16-bit PCM, 24 kHz
- local VAD is used to finalize the end of the user's turn quickly
- server-side VAD remains enabled for start detection and fallback
- when a barge-in event arrives, audio playback stops immediately

Do **not** hold a cloud audio session open all day. Local activation (hotkey / wake / TaskDock
interaction) opens or resumes Live. Keep it warm for a short idle window, then close it after
persisting the conversation summary.

## Live function surface

Keep the Live tool surface intentionally small.

### `delegate_task`

```json
{
  "goal": "what the user wants accomplished",
  "successCriteria": "visible or structured evidence that means it is done",
  "preferredSurface": "auto | research | computer | compose"
}
```

The call is NON_BLOCKING. Genie can say a short acknowledgement and continue listening while
the task runs. The return value is a task id plus current state, not the final artifact.

### `cancel_task`

Takes a task id or "current". Cancellation propagates to Temporal and the local host.

### `task_status`

Read-only. Returns compact state suitable for a spoken update. Do not stream internal step
logs into the Live context.

### `inspect_current_work`

Read-only, minimal context only. Return the active app/window/selection references and known
artifact ids; do not automatically upload a screenshot. Computer Use captures pixels only
when execution actually needs them.

The Live model must never receive generic shell, raw SQL, unrestricted filesystem, arbitrary
HTTP, or direct send/payment/delete tools.

## Jev policy

D-48 deterministic rules remain first. Jev is called only when the hard router falls through
to chat and no special deterministic workflow (for example reply-in-context) already owns
the utterance.

The first implemented request uses one parallel System-One call:

- **Choice `route`**: chat / research / computer / clarify
- **Noul `goal_clear`**: is there a concrete goal without inventing a target?

Default thresholds:

- research: Choice confidence >= 0.72
- computer: Choice confidence >= 0.86
- goal_clear >= 0.62

A timeout, API error, low confidence, or unclear goal returns to the deterministic chat
fallback. Jev can upgrade a fallback into work; it cannot bypass an existing lane, approval,
risk category, or native safety refusal.

Next Computer Use optimization should expose an accessibility-derived candidate list such as:

```json
{
  "window": "Safari — Example",
  "candidates": [
    {"id":"ax-12","role":"button","label":"Continue"},
    {"id":"ax-13","role":"textField","label":"Email"}
  ],
  "lastAction":"type email",
  "goal":"finish sign-in"
}
```

Then one Jev call can ask in parallel:

- Choice: next candidate id / stop / use_visual_planner
- Noul: goal already satisfied
- Noul: state appears stuck
- Score: ambiguity

Only candidates supplied by the native layer are legal outputs. If confidence is low or the
needed control is absent, fall back to the existing screenshot + vision planner. Do not ask
Jev to invent coordinates or generated text.

## Computer Use execution policy

Prefer the cheapest reliable path in this order:

1. deterministic native action / connector API
2. Accessibility element + Jev candidate choice
3. screenshot + ordinary vision planner
4. stronger reasoning / user clarification

A screenshot is therefore an exception, not the default observation for every step.

Task-scoped authority should eventually replace repetitive confirmation for low-risk actions:
a user request grants a short-lived scope containing target apps/windows and allowed action
classes. However, the following remain explicit commit boundaries regardless of JEV
confidence:

- destructive operations
- financial operations
- regulated actions
- security / permission changes
- irreversible external send/publish/submit where no structured readback can prove recovery

Until that task-scoped native grant exists, keep the current per-action confirmation checks.
Do not weaken the helper first and "add safety later".

## Cost controls

1. **Activation gating.** No continuous cloud microphone stream while Genie is idle.
2. **Async delegation.** Live gets task id/state, not every screenshot and action trace.
3. **Compact spoken events.** Notify only on accepted, blocked, needs-input, failed, complete.
4. **Conversation compaction.** Persist a summary and recent turns; do not replay the full
   spoken history into every turn.
5. **Live context compression.** Configure a sliding window and keep durable task history
   outside Live.
6. **Jev speculative fan-out.** Ask route/clarity/ambiguity/escalation judgments together when
   they share state rather than making one request per judgment.
7. **AX-first Computer Use.** Avoid a vision-model call when code can enumerate safe candidates.
8. **No duplicate completion generation.** A verifier returns state; the conversation model
   speaks from the final artifact once.
9. **Model escalation is exceptional.** Live handles dialogue; Flash/local handles normal
   generation; extended reasoning is background-only.

## Conversation behavior

The assistant should sound like a capable colleague, not a workflow engine.

Good:

- User: "Safariで競合3社を見て、料金を比較して。"
- Genie: "了解。3社の料金を確認して比較にまとめる。"
- User, during work: "日本向け料金だけでいい。"
- Genie: "日本向けに絞る。"

Bad:

- reading internal lane names
- narrating every click
- repeatedly asking permission for harmless intermediate UI steps
- saying "processing step 4 of 12"
- blocking the voice conversation while a durable task runs

When blocked, ask exactly one concrete question: the missing target, credential, permission,
or irreversible choice.

## Implemented in this change

- optional Jev System-One refinement for D-48's `chat` fallback
- typed, confidence-gated `chat / research / computer / clarify` decision
- no Work Context, screenshots, artifacts, credentials, or prior turns sent to Jev
- `action` turns now create the existing `computer.run` durable task
- Jev failure/timeout falls back to deterministic routing
- reply-in-context bypasses generic Jev routing

Configuration:

```sh
ASTRA_JEV_API_KEY=...
ASTRA_JEV_MODEL=jev-latest              # optional
ASTRA_JEV_ENDPOINT=https://api.typesafe.ai/v1/systemone  # optional
```

## Remaining implementation sequence

1. Add the native Gemini 3.8 Live audio session and the four coarse functions above.
2. Map `delegate_task` onto the existing conversation/task route rather than creating a
   second executor.
3. Feed task state changes back into Live with SILENT / WHEN_IDLE scheduling.
4. Add AX candidate extraction and Jev-assisted candidate selection.
5. Add a task-scoped native approval lease only after adversarial and replay tests cover it.
6. Measure p50/p95 speech-to-first-audio, task-start latency, model calls/action, dollars/hour,
   intervention rate, false completion rate and successful task completion.
