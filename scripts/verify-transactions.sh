#!/usr/bin/env bash
# Transaction regression without UI actions, orders, payments or external providers.
# Optional real PostgreSQL/RLS checks use the caller's isolated TEST_*_DATABASE_URL values.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
pnpm exec tsc -b services/api-gateway workers/task-worker workers/agent-host
pnpm exec tsc -p tsconfig.tests.json --noEmit
node --test workers/agent-host/test/checkout-assistance.node.mjs workers/agent-host/test/transaction-runtime.node.mjs workers/agent-host/test/simulation-orders.node.mjs workers/agent-host/test/simulation-native-session.node.mjs scripts/tests/transaction-use.test.mjs
pnpm --filter @genie/contracts exec vitest run test/transaction-authorization.test.ts
pnpm --filter @genie/service-conversation exec vitest run test/lane.test.ts test/checkout-request.test.ts test/transaction-request.test.ts
pnpm --filter @genie/service-task exec vitest run test/checkout-assistance.test.ts test/transaction-plan.test.ts test/transaction-workflow.test.ts test/transaction-artifact.test.ts test/replay-history.test.ts
pnpm --filter @genie/worker-task exec vitest run test/approval-proof.test.ts
pnpm --filter @genie/worker-agent-host exec vitest run test/step-loop.test.ts test/step-transport.test.ts
if [[ -n "${TEST_DATABASE_URL:-}" ]]; then
  pnpm --filter @genie/service-task exec vitest run test/transaction-approval.db.test.ts test/transaction-authorization-ledger.db.test.ts
  pnpm --filter @genie/service-agent-host exec vitest run test/bridge.db.test.ts
  pnpm --filter @genie/service-api-gateway exec vitest run test/conversations-transaction.integration.test.ts test/transaction-authorizations.integration.test.ts test/host-bridge.test.ts
else
  echo 'NOT_RUN: transaction_database (provide isolated TEST_DATABASE_URL and TEST_IDENTITY_DATABASE_URL)'
  echo 'TRANSACTION_REGRESSION_PARTIAL: code checks completed; database/RLS checks not run.'
  exit 2
fi
echo 'TRANSACTION_REGRESSION_OK: code-level checks only; native/main-app and live-provider evidence are separate.'
