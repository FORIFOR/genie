# Genie first run

The first goal is not to prove every integration works. It is to answer **what is missing, what is already ready, and exactly what to do next** without changing the machine.

## 1. Diagnose before starting services

```bash
pnpm doctor
```

This is read-only. It does not create auth tokens, run a model, change files, pull a model, or start external synchronization. It checks only the local-preview prerequisites and prints an exact next action for each failed check.

Machine-readable output:

```bash
pnpm doctor:json
```

Exit codes from the underlying doctor are:

- `0`: the checks in scope passed; Worker/Agent Host/first task are still unverified.
- `1`: one or more prerequisites need attention.
- `2`: the diagnostic itself could not safely complete.

## 2. Start the isolated local preview

```bash
pnpm preview
```

The preview owns its state directory and local services instead of reusing normal application history. It does not automatically switch to a paid API, pull an AI model, submit an AI task, or synchronize an external service.

If startup fails, run `pnpm doctor` again after applying the printed next action. Do not treat a green doctor as proof that a task completed: the doctor intentionally does not claim model quality, Worker execution, Agent Host connectivity, or end-to-end task completion.

## First-proof contract

A new contributor should be able to distinguish these states without reading source code:

1. **Prerequisite missing** — named check + exact next action.
2. **Local services ready** — readiness only, not task success.
3. **First task executed** — must be evidenced by the product's own run/task record, not inferred from readiness.
4. **External integration** — remains separate and opt-in.

This separation is intentional: setup success is not product success, and a product success should not be inferred from a process merely being alive.
