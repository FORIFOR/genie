-- migrate:up
-- 会話の目的（仕様 v1.0 ⑯ Goal Manager）。「新橋でいい店ある？」→「今日18時」→「2人」→「予約したい」は 1 つの目的。
-- 会話に 1 つ。集めた条件（slots）と、出した候補（results）を持つ。6 時間で切れる。
--
-- 外の検索の回数（Google Places など）は、月ごとに数える（本人の月の上限を守る）。
CREATE TABLE conversation_goals (
  tenant_id        uuid NOT NULL REFERENCES tenants(id),
  conversation_id  uuid NOT NULL REFERENCES conversations(id),
  kind             text NOT NULL CHECK (kind IN ('restaurant')),
  status           text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'done', 'cancelled')),
  slots            jsonb NOT NULL DEFAULT '{}'::jsonb,
  results          jsonb NOT NULL DEFAULT '[]'::jsonb,
  expires_at       timestamptz NOT NULL,
  updated_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, conversation_id)
);
ALTER TABLE conversation_goals ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversation_goals FORCE ROW LEVEL SECURITY;
CREATE POLICY conversation_goals_tenant_isolation ON conversation_goals
  USING (tenant_id = astra_current_tenant()) WITH CHECK (tenant_id = astra_current_tenant());

CREATE TABLE usage_counters (
  tenant_id  uuid NOT NULL REFERENCES tenants(id),
  kind       text NOT NULL CHECK (length(kind) BETWEEN 1 AND 40),
  month      text NOT NULL CHECK (month ~ '^\d{4}-\d{2}$'),
  count      integer NOT NULL DEFAULT 0 CHECK (count >= 0),
  PRIMARY KEY (tenant_id, kind, month)
);
ALTER TABLE usage_counters ENABLE ROW LEVEL SECURITY;
ALTER TABLE usage_counters FORCE ROW LEVEL SECURITY;
CREATE POLICY usage_counters_tenant_isolation ON usage_counters
  USING (tenant_id = astra_current_tenant()) WITH CHECK (tenant_id = astra_current_tenant());

-- migrate:down
DROP TABLE IF EXISTS usage_counters;
DROP TABLE IF EXISTS conversation_goals;
