-- migrate:up
-- 仕事の台帳（本人の方針 2026-10-29: 依頼・完了条件・経過・判断・確かめ・次に要ることを 1 つの仕事にまとめる）。
--
--   agent_session_marks … Claude Code のセッションで何が起きたか（依頼・追加の指示・承認待ち・変更・テスト・終わり）。
--                         **種類と時刻だけ。**頼みの文・コマンド・ファイルの名前は残さない（agent_sessions の方針どおり）
--   work_criteria       … 本人が言った完了条件。Genie の仕事か Claude Code のセッションのどちらか 1 つに付く
--
-- Genie の仕事の依頼・途中の指示・承認・成果物は、すでに tasks・task_instructions・approvals・artifacts にある。
-- 台帳はそれらを読んで並べるだけで、写しは作らない。

CREATE TABLE agent_session_marks (
  id          uuid PRIMARY KEY,
  tenant_id   uuid NOT NULL REFERENCES tenants(id),
  session_id  uuid NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
  kind        text NOT NULL CHECK (kind IN (
                'request',            -- 最初の頼み
                'instruction',        -- そのあとの頼み（追加の指示・直し）
                'waiting_permission', -- 承認を待ち始めた
                'waiting_input',      -- 返事を待ち始めた
                'changed',            -- ファイルを変え始めた（確かめ済みから変更ありに移ったとき）
                'test_passed',
                'test_failed',
                'turn_ended',         -- 応答を終えた（仕事が終わったとは限らない）
                'error',
                'ended')),
  at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX agent_session_marks_session ON agent_session_marks (session_id, at);
ALTER TABLE agent_session_marks ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_session_marks FORCE ROW LEVEL SECURITY;
CREATE POLICY agent_session_marks_tenant_isolation ON agent_session_marks
  USING (tenant_id = astra_current_tenant()) WITH CHECK (tenant_id = astra_current_tenant());

CREATE TABLE work_criteria (
  id                uuid PRIMARY KEY,
  tenant_id         uuid NOT NULL REFERENCES tenants(id),
  user_id           uuid NOT NULL REFERENCES users(id),
  task_id           uuid REFERENCES tasks(id) ON DELETE CASCADE,
  agent_session_id  uuid REFERENCES agent_sessions(id) ON DELETE CASCADE,
  -- 本人の言葉のまま（「テストが通る」「LINE に届く」）
  text              text NOT NULL CHECK (length(text) BETWEEN 1 AND 200),
  -- tests … Claude Code のテストの結果で確かめる（check_state を読む。ここには結果を書かない）
  -- manual … 自動では確かめられない。本人が「確かめた」と言ったときだけ met
  kind              text NOT NULL CHECK (kind IN ('tests', 'manual')),
  met_at            timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  CHECK (num_nonnulls(task_id, agent_session_id) = 1),
  CHECK (kind = 'manual' OR met_at IS NULL)
);
CREATE INDEX work_criteria_task ON work_criteria (task_id) WHERE task_id IS NOT NULL;
CREATE INDEX work_criteria_session ON work_criteria (agent_session_id)
  WHERE agent_session_id IS NOT NULL;
ALTER TABLE work_criteria ENABLE ROW LEVEL SECURITY;
ALTER TABLE work_criteria FORCE ROW LEVEL SECURITY;
CREATE POLICY work_criteria_tenant_isolation ON work_criteria
  USING (tenant_id = astra_current_tenant()) WITH CHECK (tenant_id = astra_current_tenant());

-- migrate:down
DROP TABLE IF EXISTS work_criteria;
DROP TABLE IF EXISTS agent_session_marks;
