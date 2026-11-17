-- migrate:up
-- Claude Code の承認の継続許可（services/api-gateway/src/agent-approval-policy.ts・agent-approvals.ts）。
-- 本人が LINE で「このセッションで同種を許可」「このプロジェクトで同種を常に許可」を選んだときのルール。
-- 継続許可にできるのは、操作の種類が安全側のもの（秘密・外への送信・本番・壊す・権限・決済・プロジェクトの外は不可）。
-- 実行の直前に毎回評価し直す。自動で許可した操作も agent_approvals に残す（監査）。

CREATE TABLE agent_approval_rules (
  id              uuid PRIMARY KEY,
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  user_id         uuid NOT NULL REFERENCES users(id),
  connection_id   uuid NOT NULL REFERENCES agent_connections(id) ON DELETE CASCADE,
  scope           text NOT NULL CHECK (scope IN ('session', 'project')),
  -- プロジェクトの根（git の根のパス。この Mac の中の場所）
  project_root    text NOT NULL CHECK (length(project_root) BETWEEN 1 AND 4096),
  -- session のルールだけ。そのセッションが終われば使わない
  session_id      text CHECK (session_id IS NULL OR length(session_id) BETWEEN 1 AND 128),
  tool_name       text NOT NULL CHECK (length(tool_name) BETWEEN 1 AND 80),
  operation       text NOT NULL CHECK (length(operation) BETWEEN 1 AND 40),
  -- 種類の中でさらに一致を求める値（同じコマンドの文・ホスト名・道具の名前）。null は種類だけ
  match_value     text CHECK (match_value IS NULL OR length(match_value) <= 300),
  -- 本人に見せる説明（「プロジェクト内にファイルを作成」など）
  label           text NOT NULL CHECK (length(label) BETWEEN 1 AND 200),
  -- どの承認から作ったか
  from_approval_id uuid,
  use_count       integer NOT NULL DEFAULT 0,
  last_used_at    timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  revoked_at      timestamptz,
  CHECK ((scope = 'session') = (session_id IS NOT NULL))
);
CREATE INDEX agent_approval_rules_active ON agent_approval_rules (tenant_id, connection_id)
  WHERE revoked_at IS NULL;
ALTER TABLE agent_approval_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_approval_rules FORCE ROW LEVEL SECURITY;
CREATE POLICY agent_approval_rules_tenant_isolation ON agent_approval_rules
  USING (tenant_id = astra_current_tenant()) WITH CHECK (tenant_id = astra_current_tenant());

-- 承認の 1 件ごとの経過: 受け付けた（decided_at）→ Claude Code に渡した（delivered_at）→ 実行を確かめた（result）
ALTER TABLE agent_approvals DROP CONSTRAINT agent_approvals_state_check;
ALTER TABLE agent_approvals ADD CONSTRAINT agent_approvals_state_check
  CHECK (state IN ('pending', 'allowed', 'denied', 'auto_allowed', 'answered_on_mac', 'expired', 'ended'));
ALTER TABLE agent_approvals
  ADD COLUMN operation    text CHECK (operation IS NULL OR length(operation) <= 40),
  ADD COLUMN risk         text CHECK (risk IS NULL OR risk IN ('low', 'medium', 'high')),
  ADD COLUMN rule_id      uuid REFERENCES agent_approval_rules(id) ON DELETE SET NULL,
  -- Claude Code の頼みの ID（同じ頼みの中の問いを見分ける）
  ADD COLUMN prompt_id    text CHECK (prompt_id IS NULL OR length(prompt_id) <= 128),
  ADD COLUMN delivered_at timestamptz,
  ADD COLUMN result       text CHECK (result IS NULL OR result IN ('executed', 'failed')),
  ADD COLUMN result_at    timestamptz;

-- migrate:down
ALTER TABLE agent_approvals
  DROP COLUMN result_at, DROP COLUMN result, DROP COLUMN delivered_at, DROP COLUMN prompt_id,
  DROP COLUMN rule_id, DROP COLUMN risk, DROP COLUMN operation;
ALTER TABLE agent_approvals DROP CONSTRAINT agent_approvals_state_check;
ALTER TABLE agent_approvals ADD CONSTRAINT agent_approvals_state_check
  CHECK (state IN ('pending', 'allowed', 'denied', 'answered_on_mac', 'expired', 'ended'));
DROP TABLE IF EXISTS agent_approval_rules;
