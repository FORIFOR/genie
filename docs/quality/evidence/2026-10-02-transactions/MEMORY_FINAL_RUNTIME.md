# Final memory-candidate runtime check

**Subsequent shutdown result:** these successful request/startup observations are historical. The app later hung on managed SIGTERM (**FAIL / P1**) and root stopped the verified owned process after a bounded recovery attempt. The current preview is stopped; see [the actual native failure](TERMINATION_HANG.md).

2026-10-02 JST. `/root` operated the dedicated native app and read its scoped task/artifact API. `/root/verification_audit` reviewed the saved records and compared the reported visible output with artifact metadata, without operating the UI or making another model request. This is attributed runtime evidence plus independent evidence review; it is not an independent rerun. Full records and hashes are in [memory-final-runtime.json](memory-final-runtime.json).

| ID | Method / expected | Observed | Status and boundary |
| --- | --- | --- | --- |
| MFR-1 | Start the final release candidate in the isolated preview | [Launch log](preview-memory-final-launch.log) reports READY with app PID 85691, gateway 43180, `codex` / `gpt-6-sol`, external model true, background computer delivery, and unattended-test false. Root reports the current Blue helper and dedicated 2 CPU / 2 GiB Colima profile | PASS, limited startup; candidate hashes are in [release record](memory-release-candidate.json) |
| MFR-2 | Confirm the native app discloses its selected external destination | Root observed OpenAI / gpt-6-sol on Home | PASS, attributed native AX observation; not a per-request upstream model attestation |
| MFR-3 | Submit a harmless fictional checklist through the main UI and verify completion | Task `01a0f896-2c25-7000-915d-c68314af40b6` ran from 17:49:46 to 17:49:53 UTC and is COMPLETED with no error. Root saw all three requested items in the app; [saved GET result](memory-final-external-task.json) links the matching artifact | PASS, limited main-app external-model flow |
| MFR-4 | Compare visible output with persisted artifact metadata | UTF-8 encoding of the exact reported visible text is 77 bytes and SHA-256 `ed744747545d05d76a8246abd2348a3b804311d3b4270ff1a81616621984db9b`, exactly matching the artifact metadata. Source task and result artifact IDs also match | PASS for metadata/hash consistency. Reviewer did not independently download the artifact body |
| MFR-5 | Observe resource use without disturbing the separate Noa workload | Around 17:50 UTC root reported pressure 1, free memory 61%, swap 2607.94 MiB, app RSS 163952 KiB, and healthy PostgreSQL/Redis/Temporal containers | PASS, limited observation; not a controlled memory or streaming benchmark |

Reported visible output, with no trailing newline:

```markdown
- [ ] 映像を確認する
- [ ] 音声を確認する
- [ ] 休憩を取る
```

Root returned the app to Home with empty input after the check. Container observations were Temporal 248.4 MiB, Redis 13.45 MiB, and PostgreSQL 157.6 MiB; these are inside the dedicated VM and must not be added a second time to the VM's memory.

The surrounding memory observations are time-specific. Around 17:46 UTC, free memory was 43%, pressure was 1, and Ollama showed the separate Noa model `noa-qwen35-9b-text:verified` at 5.2 GB. Genie’s verification model `qwen2.5:7b` was absent. This task did not touch the Noa model. Ollama was empty in the later 17:50 observation; the separate workload may have ended, and that unload or the full free-memory delta is not attributed to Genie.

This check does not establish arbitrary website checkout, real purchases/trades, a solution to the reported streaming crash, or general translation quality. In-flight native transaction stop evidence is maintained separately. Actual main-app Quit/SIGTERM during translation has not been exercised, and the whole-product gate remains interrupted with known failures. No commit, push, distribution approval, or service-complete claim follows from this check.

At **17:54:12.949712 UTC**, root saved a fresh read-only [runtime snapshot](memory-final-runtime-observation.json). The main app and preview services remained running with configured `codex` / `gpt-6-sol`; all three containers had been healthy for eight minutes. It reports free memory 62%, pressure 1, swap 2607.94 MiB, and app PID 85691 at RSS 164624 KiB. Ollama's model list was empty at this instant. Root separately confirmed the owned checkout fixture and helper had exited. The reviewer copied the snapshot byte-for-byte; its hash is in [the evidence manifest](memory-final-runtime.json). This latest observation preserves the same unrelated-workload and non-causal limits.
