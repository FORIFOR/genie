# Independent local gate audit

Verifier: separate agent applying `independent-product-verification`; same AI model, not a human/novice evaluation. No product source or expected values changed by this verifier. Revision/environment/source hashes: `gates-environment.json`. Exact commands, durations and exit codes: `gates-commands.jsonl`; complete output is in each named log. This is a concurrent working tree; changed gates must be rerun after implementation fixes.

| ID | Method / expected | Observed | Status | Evidence |
|---|---|---|---|---|
| G1 | Disposable DB regenerated SQL and Kysely types match checked-in files; generators current | All comparisons match, exit 0. Separate `recovery_generated` DB in isolated `genie-recovery-db-20260919` container, dropped by checker; no shared DB touched | PASS | gates-check-generated.log |
| G2 | macOS permission usage/JIT and privacy static boundaries | Usage5/JIT pass. Privacy command passes with existing native binary; `sttNoFallback=NOT_MEASURED` is not verified | PASS for static boundaries; BLOCKED runtime STT fallback | gates-verify-usage-descriptions.log, gates-verify-permission-jit.log, gates-verify-privacy-egress.log |
| G3 | Release consistency, generated assets/tokens/fixture, type literals, C ABI declarations, native Tauri isolation | All match, exit0. Static consistency does not prove signed production installation | PASS | respective gates logs |
| G4 | UI taste no added unreviewed long paragraphs | 7 long Text literals >6; additional local-save warning in TaskHistoryView:108 | FAIL, sent root | gates-verify-ui-taste.log |
| G5 | Screen vocabulary consistent | `リリースノート` triggers ban on meeting `ノート`; lexical false positive needs scoped regression, not changed sample/expectations | FAIL, sent root | gates-lint-terms.log |
| G6 | Service owns accessed tables | conversation/service.ts queries tasks directly | FAIL, sent backend owner | gates-check-conventions.log |
| G7 | Python release gate regressions | 23 tests, exit0 | PASS | gates-python-regressions.log |
| G8 | Rust core lib tests, offline | Harness44 passed, but live gateway test exits early when ASTRA_GATEWAY_URL unset. 43 actual tests +1 live path not executed | PASS for local tests; BLOCKED live path | gates-rust-core.log |
| G9 | Tauri Rust tests offline | 67 passed;3 speech/model integration ignored | PASS67; BLOCKED3 ignored | gates-tauri-rust.log |
| G10 | Tauri JS regressions | 357 passed | PASS | gates-tauri-js.log |
| G11 | Windows static markup and cached C# logic compile | 5 XML files valid; Compile --no-restore exit0, zero warning/error | PASS for static/type contract | gates-check-xaml-wellformed.log, gates-csharp-logic.log |
| G12 | Run WinUI on Windows and app on minimum macOS14 | Host is macOS26.6.2 arm64. No prlctl/VBoxManage/qemu/tart found; no VM application observed in /Applications. .NET macOS compile does not establish OS behavior | BLOCKED | gates-environment.json |
| G13 | Full verify-all aggregate | Not executed. Its C ABI, C# bridge, and macOS recording paths access fixed localhost:3000; recording includes live mic/system/AX/Speech and account/provider paths. These are outside the isolated fixture remit. Root can separately cover safe native fixture gates | BLOCKED | inspected scripts in environment source hashes |

No threshold was relaxed, skipped check upgraded to PASS, shared service stopped, dependency installed, or external API invoked. `check-generated` previously lacked a DB; its actual prerequisite was resolved with a disposable DB, so that gate is now genuinely PASS.

## Follow-up after implementation corrections

The initial FAIL logs above are retained. Final source identity is `gates-final-source-hashes.json`; commands/exit codes are appended to `gates-commands.jsonl`.

| ID | Final observation | Status | Evidence |
|---|---|---|---|
| G4 | Warning copy shortened; count is6 against unchanged limit6 | PASS | gates-final-ui-taste.log |
| G5 | Checker excludes only the exact compound リリースノート. Five isolated fixture repos exercise the actual script: release-only accepted; standalone ノート, same-literal ノート, same-line different-literal ノート, and another banned term all rejected. No forbidden meeting vocabulary exemption | PASS | gates-final-terms.log, gates-terms-regression.py, gates-terms-regression.log |
| G6 | Current source passes service ownership checker after task-owner adapter change | PASS | gates-final-conventions.log |
| G14 | Offline UniFFI generation `--check` agrees with checked-in Swift/header/modulemap. Generator normalization strips trailing whitespace only; no type/signature checks relaxed | PASS | gates-final-bindings.log |

No broad passing suite was unnecessarily rerun. These resolutions do not change the remaining platform/live-provider/aggregate BLOCKED findings.
