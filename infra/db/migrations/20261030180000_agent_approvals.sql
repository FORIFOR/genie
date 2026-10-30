-- migrate:up
-- Claude Code の承認を LINE から（services/api-gateway/src/agent-approvals.ts、scripts/claude-code-permission.sh）。
-- Claude Code が許可を求めた（PermissionRequest）→ 本人の LINE にカード → 承認・拒否・指示を添えて拒否。
-- 答えは hooks の仕組みが取りに来て、Claude Code へそのまま返す（元のセッションが続く）。
-- Mac の画面でも同時に答えられる。先に答えたほうが通り、もう一方は取り下げる。
-- **コマンド・ファイル・差分の中身は残さない**（カードに載せるのは秘密を伏せた写し。gateway のメモリだけ）。
-- ここに残すのは、いつ・どの道具が・どう答えられたか（と、内容が変わっていないかを見るハッシュ）。

CREATE TABLE agent_approvals (
  id                  uuid PRIMARY KEY,
  tenant_id           uuid NOT NULL REFERENCES tenants(id),
  user_id             uuid NOT NULL REFERENCES users(id),
  connection_id       uuid NOT NULL REFERENCES agent_connections(id) ON DELETE CASCADE,
  external_session_id text NOT NULL CHECK (length(external_session_id) BETWEEN 1 AND 128),
  tool_name           text NOT NULL CHECK (length(tool_name) BETWEEN 1 AND 80),
  -- 求められた道具の入力（tool_input）のハッシュ。ボタンはこれに縛る（内容が変われば別の承認）
  input_hash          text NOT NULL CHECK (input_hash ~ '^[0-9a-f]{64}$'),
  state               text NOT NULL DEFAULT 'pending'
                        CHECK (state IN ('pending', 'allowed', 'denied', 'answered_on_mac', 'expired', 'ended')),
  -- 拒否に本人の指示を添えたか（指示の文は残さない）
  with_instruction    boolean NOT NULL DEFAULT false,
  expires_at          timestamptz NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  decided_at          timestamptz,
  CHECK ((state = 'pending') = (decided_at IS NULL))
);
CREATE INDEX agent_approvals_session ON agent_approvals (tenant_id, connection_id, external_session_id)
  WHERE state = 'pending';
CREATE INDEX agent_approvals_user ON agent_approvals (tenant_id, user_id, created_at DESC);
ALTER TABLE agent_approvals ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_approvals FORCE ROW LEVEL SECURITY;
CREATE POLICY agent_approvals_tenant_isolation ON agent_approvals
  USING (tenant_id = astra_current_tenant()) WITH CHECK (tenant_id = astra_current_tenant());

-- migrate:down
DROP TABLE IF EXISTS agent_approvals;
