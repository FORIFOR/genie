# Isolated managed preview — infrastructure validation

2026-10-02 JST. These are implementation checks by the author of the preview launcher changes, not independent approval of that code. Transaction behavior, main app operation, human concurrent input, and actual merchant/broker compatibility are **not established** by these results.

Environment: macOS 27.0.1 (26A434), arm64, Node v26.5.0, Colima 0.10.3, dedicated Docker engine 29.5.2. Base commit `ee857a5b13482cbd2d986a1f9b466c8e49a149c3`, uncommitted working tree; infra source hashes are in [preview-preflight.json](preview-preflight.json).

| ID | Method / expected | Observed / status | Evidence |
| --- | --- | --- | --- |
| INF-0 | Read existing Docker/Colima state without changing it | Existing context `colima`, default profile stopped, missing default Docker socket; Docker.app absent. Initial managed-preview prerequisite was unavailable. BLOCKED before recovery | Initial tool observation; no credential files read |
| INF-1 | Start a new dedicated Colima profile without activating it or changing SSH configuration | PASS. `genie-transactions-20261002` starts in about 21 seconds with 4 CPU, 4 GiB RAM, 20 GiB disk; cached VM base image reused | [colima-start.log](colima-start.log), exit 0 |
| INF-2 | Explicit context must pin only child operations and reject remote/relative/missing endpoints on each start | PASS. 17 tests, including explicit simulation opt-in, executable checks, legacy config migration, non-inheritance and process isolation | [preview-context-tests.log](preview-context-tests.log), exit 0 |
| INF-3 | New project only; separate DB/Redis/Temporal, loopback published ports | PASS. Three containers healthy under `genie-preview-f68d0fef8411`; default context remains `colima` and default profile remains stopped | [infrastructure-preflight.log](infrastructure-preflight.log), exit 0; [preview-preflight.json](preview-preflight.json) |
| INF-4 | Start managed services from source | Initial FAIL during concurrently edited transaction task code: `services/task/src/plan.ts(600,52): TS2304 Cannot find name 'transactionApproval'`. Launcher exited 1 (build exited 2), before containers. After the implementing agent completed that function, repeated startup reached ready | [preview-launcher.log](preview-launcher.log); the original build error was read directly before the launcher reused build.log |
| INF-5 | Managed launcher must report ready only after DB, worker and Host are registered | PASS. `GENIE_PREVIEW_READY`, `/readyz` HTTP 200 with DB/Redis `ok`, selected local model `qwen3.5:9b`. Live supervisor remains running for subsequent tests | [preview-launcher-2.log](preview-launcher-2.log), [preview-preflight.json](preview-preflight.json) |
| INF-6 | Explicit simulation-enabled managed service startup | PASS for startup only. The same owned preview stopped with exit 0 and restarted using `--computer-use --transaction-simulation --no-open`. Ready reports `computerUse=true`, `transactionSimulation=true`, `computerDelivery=background`, `computerHelperUnattendedTest=false` | [preview-launcher-simulation.log](preview-launcher-simulation.log) |
| INF-7 | Main app, native transaction execution and provider receipt | BLOCKED pending integrated execution. No main app or checkout was opened by this infrastructure preflight | Subsequent product verification required |

Commands:

```sh
colima start genie-transactions-20261002 --activate=false --ssh-config=false --template=false --cpus 4 --memory 4 --disk 20 --mount /Users/shuhei/Projects/genie
node --test scripts/tests/managed-local-preview.test.mjs
node scripts/start-local-preview.mjs --docker-context colima-genie-transactions-20261002 --state-dir /private/tmp/genie-transactions-20261002/preview --port 43180 --model qwen3.5:9b --no-open
node scripts/start-local-preview.mjs status --state-dir /private/tmp/genie-transactions-20261002/preview
```

Between the two launcher attempts, the identical `composeConfig` was written to the private dedicated state directory and `docker --context colima-genie-transactions-20261002 compose --env-file /dev/null -p genie-preview-f68d0fef8411 -f /private/tmp/genie-transactions-20261002/preview/compose.json up -d --wait --wait-timeout 180 postgres redis temporal` completed with exit 0. The random DB password was supplied only in the child environment and is not stored in this evidence.

The dedicated state contains private runtime credentials and must not be committed. Existing `.env`, Keychain, TCC, default Docker context, default Colima profile, and unrelated running task worker were not changed. No fixture checkout was opened and no model generation or real transaction was triggered by this preflight.

To stop only this owned managed preview when its subsequent verification is complete:

```sh
node scripts/start-local-preview.mjs stop --state-dir /private/tmp/genie-transactions-20261002/preview
```

The isolated Colima VM is separately owned by this verification. Keep it for follow-up tests until the parent task finishes; stopping that profile must not be confused with stopping the user's default profile.

## Later resource reduction

The initial 4 CPU / 4 GiB settings above describe the original run. Root later changed only this dedicated profile to 2 CPU / 2 GiB while addressing memory pressure. See [the later attributed observations](MEMORY_PRESSURE.md). The initial startup timings and results were not remeasured under the smaller profile.
