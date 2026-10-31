-- migrate:up
-- エージェントの仕事（本人の方針 2026-10-30: Genie が Claude Code・Codex・ブラウザ担当の仕事を引き受けて進める）。
--
--   agent_jobs      … 1 つの仕事。元の依頼・プロジェクト・完了条件（work_criteria）・依存・上限・経過
--                     control = managed  … Genie が起動して進める（再開・停止・追加の指示ができる）
--                     control = observed … 本人が直接始めたセッションを見つけて取り込んだもの。**読むだけ**
--   agent_job_runs  … 実行の履歴（1 回起動するごとに 1 行）。結果・費用（取れたときだけ）・手数・時間
--   agent_sessions  … どの仕事のセッションか（1 つの仕事に複数のセッションが付いてよい）
--   work_criteria   … 完了条件に「コマンドが通る」「成果物がある」を足す（Genie が自分で確かめる）
--
-- 残すのは本人の依頼の文・プロジェクトの場所・条件・結果の種類と数だけ。エージェントの出力の本文は残さない。

ALTER TABLE agent_connections DROP CONSTRAINT agent_connections_source_check;
ALTER TABLE agent_connections ADD CONSTRAINT agent_connections_source_check
  CHECK (source IN ('claude_code', 'codex', 'opencode'));
ALTER TABLE agent_sessions DROP CONSTRAINT agent_sessions_source_check;
ALTER TABLE agent_sessions ADD CONSTRAINT agent_sessions_source_check
  CHECK (source IN ('claude_code', 'codex', 'opencode'));

CREATE TABLE agent_jobs (
  id                   uuid PRIMARY KEY,
  tenant_id            uuid NOT NULL REFERENCES tenants(id),
  user_id              uuid NOT NULL REFERENCES users(id),
  -- 本人が呼ぶ番号（「仕事 3 を保留」）。本人ごとに 1 から
  number               integer NOT NULL CHECK (number > 0),
  agent                text NOT NULL CHECK (agent IN ('claude_code', 'codex', 'opencode', 'browser')),
  control              text NOT NULL CHECK (control IN ('managed', 'observed')),
  -- git の根（分からなければ作業フォルダ）。プロジェクトごとにまとめるため
  project_root         text NOT NULL CHECK (length(project_root) BETWEEN 1 AND 1024),
  project              text NOT NULL CHECK (length(project) BETWEEN 1 AND 120),
  -- 元の依頼（observed は頼みの頭だけ。取れなければ null）
  request              text CHECK (length(request) <= 8000),
  title                text NOT NULL CHECK (length(title) BETWEEN 1 AND 120),
  status               text NOT NULL CHECK (status IN (
                         'queued',       -- 始めるのを待っている（依存・順番・再試行の時刻）
                         'running',
                         'waiting_user', -- 本人の答えが要る（承認が得られなかった・質問）
                         'verifying',    -- 完了条件を確かめている
                         'needs_review', -- 自動の条件は通った。本人の確認（成果物・レビュー）を待つ
                         'done',
                         'stopped',      -- 上限・同じ失敗・依存の失敗で止めた（理由は stop_reason）
                         'held',         -- 本人が保留にした。勝手に再開しない
                         'cancelled',
                         'idle',         -- observed: 応答を終えて次の頼みを待っている
                         'ended')),      -- observed: セッションが終わった
  stop_reason          text CHECK (length(stop_reason) <= 60),
  -- 本人に見せる短い理由（失敗した条件の名前など。出力の本文は入れない）
  last_failure         text CHECK (length(last_failure) <= 300),
  depends_on           uuid[] NOT NULL DEFAULT '{}',
  -- 上限（どれかを超えたら止める）
  max_attempts         integer NOT NULL DEFAULT 3 CHECK (max_attempts BETWEEN 1 AND 3),
  max_minutes          integer NOT NULL DEFAULT 30 CHECK (max_minutes BETWEEN 1 AND 240),
  max_turns            integer NOT NULL DEFAULT 40 CHECK (max_turns BETWEEN 1 AND 200),
  max_cost_usd         numeric(8, 2) NOT NULL DEFAULT 2 CHECK (max_cost_usd > 0 AND max_cost_usd <= 50),
  -- 経過
  attempts             integer NOT NULL DEFAULT 0,
  turns                integer NOT NULL DEFAULT 0,
  elapsed_ms           bigint NOT NULL DEFAULT 0,
  -- 取れた費用の合計。cost_known = false なら、どこかの実行で費用が取れなかった（推した値は入れない）
  cost_usd             numeric(10, 4) NOT NULL DEFAULT 0,
  cost_known           boolean NOT NULL DEFAULT true,
  -- 同じ失敗が続いたかを見るための印（失敗した条件と、その最初の行のハッシュ）
  failure_signature    text CHECK (length(failure_signature) <= 64),
  same_failure_count   integer NOT NULL DEFAULT 0,
  -- エージェントのセッション（再開に使う）
  external_session_id  text CHECK (length(external_session_id) <= 128),
  -- 本人の追加の指示（次の実行で渡す）
  pending_instruction  text CHECK (length(pending_instruction) <= 2000),
  next_run_at          timestamptz,
  started_at           timestamptz,
  finished_at          timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  CHECK (control = 'managed' OR status IN ('running', 'waiting_user', 'idle', 'ended', 'held')),
  CHECK (control = 'observed' OR request IS NOT NULL)
);
CREATE UNIQUE INDEX agent_jobs_number ON agent_jobs (tenant_id, user_id, number);
CREATE INDEX agent_jobs_queue ON agent_jobs (status, next_run_at) WHERE control = 'managed';
CREATE INDEX agent_jobs_session ON agent_jobs (tenant_id, user_id, external_session_id)
  WHERE external_session_id IS NOT NULL;
ALTER TABLE agent_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_jobs FORCE ROW LEVEL SECURITY;
CREATE POLICY agent_jobs_tenant_isolation ON agent_jobs
  USING (tenant_id = astra_current_tenant()) WITH CHECK (tenant_id = astra_current_tenant());

CREATE TABLE agent_job_runs (
  id           uuid PRIMARY KEY,
  tenant_id    uuid NOT NULL REFERENCES tenants(id),
  job_id       uuid NOT NULL REFERENCES agent_jobs(id) ON DELETE CASCADE,
  attempt      integer NOT NULL CHECK (attempt > 0),
  -- work … 依頼どおりに進める / fix … 確かめで落ちた条件を直す / resume … 本人が再開した
  kind         text NOT NULL CHECK (kind IN ('work', 'fix', 'resume')),
  outcome      text CHECK (outcome IN (
                 'success', 'error', 'transient', 'crashed', 'denied',
                 'limit_turns', 'limit_cost', 'limit_time', 'unavailable')),
  -- 取れなかったら null（推した値は入れない）
  cost_usd     numeric(10, 4),
  turns        integer,
  exit_code    integer,
  note         text CHECK (length(note) <= 300),
  started_at   timestamptz NOT NULL,
  ended_at     timestamptz
);
CREATE INDEX agent_job_runs_job ON agent_job_runs (job_id, started_at);
CREATE INDEX agent_job_runs_recent ON agent_job_runs (tenant_id, started_at);
ALTER TABLE agent_job_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_job_runs FORCE ROW LEVEL SECURITY;
CREATE POLICY agent_job_runs_tenant_isolation ON agent_job_runs
  USING (tenant_id = astra_current_tenant()) WITH CHECK (tenant_id = astra_current_tenant());

ALTER TABLE agent_sessions ADD COLUMN agent_job_id uuid REFERENCES agent_jobs(id) ON DELETE SET NULL;
CREATE INDEX agent_sessions_job ON agent_sessions (agent_job_id) WHERE agent_job_id IS NOT NULL;

-- 完了条件: command（Genie がプロジェクトで走らせて通るか）・artifact（成果物のファイルがあるか）
ALTER TABLE work_criteria ADD COLUMN agent_job_id uuid REFERENCES agent_jobs(id) ON DELETE CASCADE;
-- command ならコマンド、artifact ならプロジェクトからの道
ALTER TABLE work_criteria ADD COLUMN spec text CHECK (length(spec) <= 1000);
ALTER TABLE work_criteria DROP CONSTRAINT work_criteria_check;
ALTER TABLE work_criteria ADD CONSTRAINT work_criteria_check
  CHECK (num_nonnulls(task_id, agent_session_id, agent_job_id) = 1);
ALTER TABLE work_criteria DROP CONSTRAINT work_criteria_check1;
ALTER TABLE work_criteria ADD CONSTRAINT work_criteria_check1
  CHECK (kind <> 'tests' OR met_at IS NULL);
ALTER TABLE work_criteria DROP CONSTRAINT work_criteria_kind_check;
ALTER TABLE work_criteria ADD CONSTRAINT work_criteria_kind_check
  CHECK (kind IN ('tests', 'manual', 'command', 'artifact'));
ALTER TABLE work_criteria ADD CONSTRAINT work_criteria_spec
  CHECK ((kind IN ('command', 'artifact')) = (spec IS NOT NULL));
CREATE INDEX work_criteria_job ON work_criteria (agent_job_id) WHERE agent_job_id IS NOT NULL;

ALTER TABLE user_notices DROP CONSTRAINT user_notices_kind_check;
ALTER TABLE user_notices ADD CONSTRAINT user_notices_kind_check
  CHECK (kind IN ('reminder', 'scheduled_task', 'schedule_problem', 'agent_session', 'work_hold',
                  'task_followup', 'agent_job'));

-- migrate:down
DELETE FROM user_notices WHERE kind = 'agent_job';
ALTER TABLE user_notices DROP CONSTRAINT user_notices_kind_check;
ALTER TABLE user_notices ADD CONSTRAINT user_notices_kind_check
  CHECK (kind IN ('reminder', 'scheduled_task', 'schedule_problem', 'agent_session', 'work_hold',
                  'task_followup'));
DELETE FROM work_criteria WHERE agent_job_id IS NOT NULL;
DROP INDEX IF EXISTS work_criteria_job;
ALTER TABLE work_criteria DROP CONSTRAINT work_criteria_spec;
ALTER TABLE work_criteria DROP CONSTRAINT work_criteria_kind_check;
ALTER TABLE work_criteria ADD CONSTRAINT work_criteria_kind_check CHECK (kind IN ('tests', 'manual'));
ALTER TABLE work_criteria DROP CONSTRAINT work_criteria_check1;
ALTER TABLE work_criteria ADD CONSTRAINT work_criteria_check1 CHECK (kind = 'manual' OR met_at IS NULL);
ALTER TABLE work_criteria DROP CONSTRAINT work_criteria_check;
ALTER TABLE work_criteria ADD CONSTRAINT work_criteria_check
  CHECK (num_nonnulls(task_id, agent_session_id) = 1);
ALTER TABLE work_criteria DROP COLUMN spec;
ALTER TABLE work_criteria DROP COLUMN agent_job_id;
DROP INDEX IF EXISTS agent_sessions_job;
ALTER TABLE agent_sessions DROP COLUMN agent_job_id;
DROP TABLE IF EXISTS agent_job_runs;
DROP TABLE IF EXISTS agent_jobs;
DELETE FROM agent_sessions WHERE source <> 'claude_code';
DELETE FROM agent_connections WHERE source <> 'claude_code';
ALTER TABLE agent_sessions DROP CONSTRAINT agent_sessions_source_check;
ALTER TABLE agent_sessions ADD CONSTRAINT agent_sessions_source_check CHECK (source IN ('claude_code'));
ALTER TABLE agent_connections DROP CONSTRAINT agent_connections_source_check;
ALTER TABLE agent_connections ADD CONSTRAINT agent_connections_source_check
  CHECK (source IN ('claude_code'));
