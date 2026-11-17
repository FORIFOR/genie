-- migrate:up
-- Genie 自身の改善（本人の方針 2026-10-31）。別の作業コピーと枝で直し、取り込むかは本人が決める。
--
--   agent_jobs.improve_*  … 改善の仕事の枝・元の枝・元のコミット・取り込んだコミット
--   genie_improvement_proposals … Genie が自分の止まり方から見つけた改善の提案。進めるかは本人が決める
--                                  残すのは止まった理由の種類と回数だけ（出力の本文は残さない）

ALTER TABLE agent_jobs ADD COLUMN improve_branch text CHECK (length(improve_branch) <= 200);
ALTER TABLE agent_jobs ADD COLUMN improve_base_branch text CHECK (length(improve_base_branch) <= 200);
ALTER TABLE agent_jobs ADD COLUMN improve_base_sha text CHECK (length(improve_base_sha) <= 64);
ALTER TABLE agent_jobs ADD COLUMN improve_commit text CHECK (length(improve_commit) <= 64);
CREATE INDEX agent_jobs_improve ON agent_jobs (tenant_id, user_id) WHERE improve_branch IS NOT NULL;

CREATE TABLE genie_improvement_proposals (
  id          uuid PRIMARY KEY,
  tenant_id   uuid NOT NULL REFERENCES tenants(id),
  user_id     uuid NOT NULL REFERENCES users(id),
  -- 同じ週に同じ理由で重ねて提案しない
  signature   text NOT NULL CHECK (length(signature) <= 120),
  text        text NOT NULL CHECK (length(text) BETWEEN 1 AND 500),
  status      text NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed', 'started', 'dismissed')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  decided_at  timestamptz
);
CREATE UNIQUE INDEX genie_improvement_proposals_signature
  ON genie_improvement_proposals (tenant_id, user_id, signature);
ALTER TABLE genie_improvement_proposals ENABLE ROW LEVEL SECURITY;
ALTER TABLE genie_improvement_proposals FORCE ROW LEVEL SECURITY;
CREATE POLICY genie_improvement_proposals_tenant_isolation ON genie_improvement_proposals
  USING (tenant_id = astra_current_tenant()) WITH CHECK (tenant_id = astra_current_tenant());

-- migrate:down
DROP TABLE IF EXISTS genie_improvement_proposals;
DROP INDEX IF EXISTS agent_jobs_improve;
ALTER TABLE agent_jobs DROP COLUMN improve_commit;
ALTER TABLE agent_jobs DROP COLUMN improve_base_sha;
ALTER TABLE agent_jobs DROP COLUMN improve_base_branch;
ALTER TABLE agent_jobs DROP COLUMN improve_branch;
