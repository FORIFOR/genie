-- migrate:up
-- 別のエージェントによるレビューを完了条件にする（Genie Supervisor の Verifier）。
--   work_criteria.kind = agent_review … spec はレビュー担当のエージェント（'claude_code' / 'codex'）。
--                                       コマンド・成果物の確かめが通ったあとに、読むだけで差分を見させる
--   agent_job_runs.kind = review     … レビューの実行（費用・手数・結果だけ。本文は残さない）
--   agent_jobs.base_sha               … 仕事を作ったときの HEAD。レビューはここからの差分を見る
ALTER TABLE work_criteria DROP CONSTRAINT work_criteria_kind_check;
ALTER TABLE work_criteria ADD CONSTRAINT work_criteria_kind_check
  CHECK (kind IN ('tests', 'manual', 'command', 'artifact', 'agent_review'));
ALTER TABLE work_criteria DROP CONSTRAINT work_criteria_spec;
ALTER TABLE work_criteria ADD CONSTRAINT work_criteria_spec
  CHECK ((kind IN ('command', 'artifact', 'agent_review')) = (spec IS NOT NULL));
ALTER TABLE work_criteria ADD CONSTRAINT work_criteria_review_agent
  CHECK (kind <> 'agent_review' OR spec IN ('claude_code', 'codex'));

ALTER TABLE agent_job_runs DROP CONSTRAINT agent_job_runs_kind_check;
ALTER TABLE agent_job_runs ADD CONSTRAINT agent_job_runs_kind_check
  CHECK (kind IN ('work', 'fix', 'resume', 'review'));

ALTER TABLE agent_jobs ADD COLUMN base_sha text CHECK (base_sha ~ '^[0-9a-f]{7,64}$');

-- migrate:down
ALTER TABLE agent_jobs DROP COLUMN base_sha;
DELETE FROM agent_job_runs WHERE kind = 'review';
ALTER TABLE agent_job_runs DROP CONSTRAINT agent_job_runs_kind_check;
ALTER TABLE agent_job_runs ADD CONSTRAINT agent_job_runs_kind_check
  CHECK (kind IN ('work', 'fix', 'resume'));
DELETE FROM work_criteria WHERE kind = 'agent_review';
ALTER TABLE work_criteria DROP CONSTRAINT work_criteria_review_agent;
ALTER TABLE work_criteria DROP CONSTRAINT work_criteria_spec;
ALTER TABLE work_criteria ADD CONSTRAINT work_criteria_spec
  CHECK ((kind IN ('command', 'artifact')) = (spec IS NOT NULL));
ALTER TABLE work_criteria DROP CONSTRAINT work_criteria_kind_check;
ALTER TABLE work_criteria ADD CONSTRAINT work_criteria_kind_check
  CHECK (kind IN ('tests', 'manual', 'command', 'artifact'));
