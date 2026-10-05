/**
 * @genie/contracts
 *
 * 境界を越えるものの一次ソース。Zod スキーマが正本で、TypeScript の型は z.infer で導出する。
 * 手書きの interface を並置しない（実装仕様 §3.1）。
 *
 * 正本:     docs/spec/new_ai_platform_design_spec_v0.1.md
 * 実装仕様: docs/spec/phase-0-implementation-spec.md §3
 */
export * from './version.js';
export * from './uuid.js';
export * from './ids.js';
export * from './primitives.js';
export * from './codec.js';
export * from './canonical.js';
export * from './errors.js';
export * from './agent-host.js';
export * from './approval.js';
export * from './artifact.js';
export * from './context.js';
export * from './share.js';
export * from './meeting.js';
export * from './task.js';
export * from './events.js';
export * from './escalation.js';
export * from './evidence.js';
export * from './surface.js';
export * from './plugin.js';
export * from './dashboard.js';
export * from './language-model.js';
export * from './mcp.js';
export * from './domain.js';
export * from './world.js';
export * from './work.js';
export * from './conversation.js';
export * from './onboarding.js';
export * from './workflow.js';
export * from './policy-doc.js';
export * from './slo.js';
export * from './speaker.js';
export * from './standin.js';
export * from './identity.js';
export * from './host.js';
export * from './api.js';
export * from './voice.js';
export * from './task-ledger.js';
export * from './transaction.js';
export * from './transaction-authorization.js';
export * from './transaction-simulation.js';
export * from './research.js';
export * from './office.js';
export * from './trading-guard.js';
export * from './browser-open.js';
export * from './checkout-assistance.js';
