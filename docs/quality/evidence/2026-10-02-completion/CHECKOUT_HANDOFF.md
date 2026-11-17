# Official checkout site handoff — limited integration

Implementation and verification by `/root/computer_correctness`, on the current uncommitted working tree. Source/log identities are in [checkout-handoff.json](checkout-handoff.json). This is an experimental public-site entry, **not a live checkout adapter or an order-completion PASS**.

## Integrated behavior

The conversation HTTP route recognizes strict whole requests for McDelivery or Domino's, creates `checkout.assist`, plans one local `checkout.open` step, and dispatches to `CheckoutAssistanceRuntime` registered in the production host. The host accepts only an enumerated service and invokes `/usr/bin/open -g -u` with its fixed official HTTPS URL. No caller URL, scheme, credentials, cart action, payment, submit flag, generic Computer Use fallback, or transaction receipt is accepted.

`open` success means only that the OS accepted an opening request. The structured result always retains `prepared=false`, `orderStatus=not_submitted`, `authentication/cart/receipt=not_checked`, and `automatedCheckout=unsupported`. Navigation may be `requested` or `request_unconfirmed`; neither asserts a visible browser or loaded page. The fixed artifact prominently says **未注文**, lists the remaining on-site checks, and leaves final action to the user. Reusing a task can repeat navigation only. Failure does not escalate into checkout or retry through generic screen automation.

Current Mac Home source has a separate local consumer preparation flow. A plain “マクドナルドを注文して” is intercepted there; it is not evidence that this new host path runs. “マクドナルドの注文画面を開いて” and “マクドナルドの注文サイトを開いて” are excluded by `ConsumerJourneyKind.notAPersonalRequest` and can reach the ordinary gateway path when connected. Domino's is not matched by that local interception. The separate `consumerPlanning` proposal route remains unchanged. **This is source tracing, not new Home UI or browser E2E evidence.**

Questions, negations, whole quotations and “という文を書いて” cases do not become merchant handoffs. A narrow quoted-request guard also prevents supported quoted examples from falling through into generic screen automation. This is a bounded phrase recognizer, not a claim of perfect natural-language intent detection.

Official sources checked during this implementation: [McDelivery entry](https://www.mcdonalds.co.jp/mcdelivery/), [McDelivery instructions](https://www.mcdonalds.co.jp/shop/mcdelivery/), and [Domino's order guide](https://www.dominos.jp/help/order), whose delivery link points to `https://internetorder.dominos.jp/delivery`. Dynamic prices, availability and payment conditions are not hardcoded.

## Executed checks

All checks were serial. No model, native app, browser, live merchant session, paid order or securities trade was started by these checks.

| Check | Result and scope |
| --- | --- |
| `pnpm -s build` | PASS, exit 0 on final production source. Empty success log retained. |
| Focused Vitest, `--maxWorkers=1 --fileParallelism=false` | 39/39 PASS: 29 request/routing cases and 10 plan/artifact cases. |
| Host Node tests, `--test-concurrency=1` | 7/7 PASS: real runtime with mocked OS process boundary; fixed executable/URL/flags, refusal, cancellation, failures, reuse, plan-to-artifact composition. This does not launch a browser. |
| PostgreSQL + HTTP | 20/20 PASS, including the 5 new handoff/recovery/quotation cases and 15 existing simulation-entry cases. Real disposable DB/RLS/HTTP with in-memory workflow dispatch; no host execution. |
| `pnpm exec tsc -p tsconfig.tests.json` | PASS, exit 0 after final test edits. |
| Owned diff whitespace check | PASS. |

DB tests used only root-provided disposable container `genie-checkout-gate-20261002`, identity `8400c49209d36132d817f2bc851aafcc4cf27a377c8e1f8975b7cdd7c9b9a0e9`, bound to `127.0.0.1:32768`. The wrapper created its PID-named test DB, applied migrations and cleaned test DB/roles. Container was left to root for cleanup. User databases were not used.

Reproduction after a build, against a **dedicated disposable PostgreSQL cluster** (the wrapper cleans cluster-wide test roles):

```sh
PATH="/opt/homebrew/opt/libpq/bin:$PATH" \
ASTRA_TEST_PGHOST=127.0.0.1 ASTRA_TEST_PGPORT=32768 \
ASTRA_TEST_PGUSER=astra ASTRA_TEST_PGPASSWORD=astra \
./infra/db/with-test-db.sh pnpm exec vitest run \
  services/api-gateway/test/conversations-transaction.integration.test.ts \
  --maxWorkers=1 --fileParallelism=false
```

## Preserved failures and limits

The first DB invocation exited 127 because `psql` was absent from PATH; no tests ran. The next invocation had 15 PASS / 5 FAIL. One exposed a real recovery defect: `ConversationService.requestStatus` overwrote saved disclosure with `notice:null` after task-dispatch acknowledgement loss. The final source preserves the prepared notice, and the injected-loss test passes. Two failures were an incorrect test lookup of the runtime map by task ID instead of workflow ID; two were an incorrect expectation that the chat HTTP path returns 200 rather than its asynchronous 202 contract. All initial logs remain alongside the final pass.

New Home UI/browser execution is NOT_RUN. Page load, user authentication, address availability, cart preparation and receipt inspection are unobserved; automated live checkout remains unsupported. Real merchant orders and real financial transactions were not requested or executed. The overall completion/fullgate status is tracked separately by root; these focused checks do not make it green. Independent source review was requested and is separate from this implementer verification.
