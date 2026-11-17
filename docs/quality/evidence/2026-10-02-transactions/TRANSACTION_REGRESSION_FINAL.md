# Current transaction regression

2026-10-02 JST. Root executed `bash scripts/verify-transactions.sh` with the dedicated disposable PostgreSQL test environment and reported **exit 0**. The saved complete [log](transactions-final.log) contains `TRANSACTION_REGRESSION_OK` and **181 passed, 1 skipped** across the script's suites. `/root/verification_audit` copied and reviewed the completed log; it did not rerun the tests. This is code-level regression evidence, not an independent full-product run.

Counts within this one run: Node 26, contracts 3, conversation 29, task 30, worker proof 4, host loop/transport 21, task DB 14, host bridge DB 19, Gateway HTTP 35. The one skip is opt-in generation of previous-revision Temporal history fixtures. Checked-in replay tests ran. Do not add the separately recorded cancellation unit/DB tests to this total; those runs overlap.

The log's SHA-256, executor attribution, source hashes collected at documentation time and limitations are in [transactions-final-run.json](transactions-final-run.json). This run includes the current production code, whereas the [main-app bounded reuse](MAIN_APP_BOUNDED_REUSE.md) occurred before the in-flight cancellation correction. The latter correction requires its own native UI retest and replay evidence.

Root's later `verify-all.sh` was interrupted with exit 143 to reduce memory pressure, after UI taste and light golden failures. See [the interruption record](MEMORY_PRESSURE.md); no completed result covers the final candidate. No final whole-product PASS, distribution approval, commit or push is asserted here. Human parallel input/IME and real merchant/broker coverage remain outside this code regression.
