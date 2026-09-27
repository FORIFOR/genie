-- 動いている仕事への追加指示（「あと、テストも追加して」）。
-- 受け取った（RECEIVED）と、実際に反映した（APPLIED / どの段で）を分けて残す。
-- 反映する前に仕事が終わったものは NOT_APPLIED（勝手に「追加しました」と言わない）。
-- migrate:up
CREATE TABLE task_instructions (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  task_id uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  request_id uuid NOT NULL,
  created_by uuid NOT NULL REFERENCES users(id),
  text text NOT NULL CHECK (char_length(text) BETWEEN 1 AND 2000),
  status text NOT NULL DEFAULT 'RECEIVED' CHECK (status IN ('RECEIVED', 'APPLIED', 'NOT_APPLIED')),
  applied_step_index integer CHECK (applied_step_index IS NULL OR applied_step_index >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  PRIMARY KEY (tenant_id, task_id, request_id),
  CHECK ((status = 'APPLIED') = (applied_step_index IS NOT NULL)),
  CHECK ((status = 'RECEIVED') = (resolved_at IS NULL))
);
CREATE INDEX task_instructions_pending ON task_instructions (tenant_id, task_id) WHERE status = 'RECEIVED';
ALTER TABLE task_instructions ENABLE ROW LEVEL SECURITY;
ALTER TABLE task_instructions FORCE ROW LEVEL SECURITY;
CREATE POLICY task_instructions_tenant ON task_instructions
  USING (tenant_id = astra_current_tenant()) WITH CHECK (tenant_id = astra_current_tenant());
-- migrate:down
DROP TABLE task_instructions;
