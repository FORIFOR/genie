-- migrate:up
-- 仕事の見通し（Agent Orchestration の受け入れ項目書 2026-10-29: 保留・確かめ・終わったら次へ）。
--
--   work_holds      … 本人が「〇〇は来週まで保留」と決めたもの。勝手に再開しない。日が来たら再開するかを聞く
--   task_followups  … 「これが終わったら〇〇して」。前の仕事が終わった（COMPLETED）ときだけ始める
--   agent_sessions  … 応答を終えただけのセッションを「完了」と言わないため、変更とテストの結果を覚える
--
-- 残すのは、本人が付けた名前・理由・日付と、頼みの文だけ。

CREATE TABLE work_holds (
  id                   uuid PRIMARY KEY,
  tenant_id            uuid NOT NULL REFERENCES tenants(id),
  user_id              uuid NOT NULL REFERENCES users(id),
  -- 本人が呼んだ名前（「デザイン」「genie」）。セッションのフォルダ名・頼みの頭・予約の名前と照らす
  subject              text NOT NULL CHECK (length(subject) BETWEEN 1 AND 80),
  reason               text CHECK (length(reason) <= 200),
  -- この日まで保留（本人のタイムゾーンの日付）。null は解除するまで
  until_date           date,
  status               text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'released')),
  -- 保留で止めた予約（解除したら、まだ止まっているものだけ戻す）
  paused_schedule_ids  uuid[] NOT NULL DEFAULT '{}',
  -- 保留の日が来たと知らせた時刻（1 回だけ。解除はしない）
  due_noticed_at       timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  released_at          timestamptz
);
CREATE UNIQUE INDEX work_holds_one_active
  ON work_holds (tenant_id, user_id, lower(subject)) WHERE status = 'active';
CREATE INDEX work_holds_due ON work_holds (until_date)
  WHERE status = 'active' AND due_noticed_at IS NULL AND until_date IS NOT NULL;
ALTER TABLE work_holds ENABLE ROW LEVEL SECURITY;
ALTER TABLE work_holds FORCE ROW LEVEL SECURITY;
CREATE POLICY work_holds_tenant_isolation ON work_holds
  USING (tenant_id = astra_current_tenant()) WITH CHECK (tenant_id = astra_current_tenant());

-- 保留で静かにしているセッション（本人が止めたものとは分ける。解除で戻すのはこちらだけ）
ALTER TABLE agent_sessions ADD COLUMN held_by uuid REFERENCES work_holds(id);
-- 応答を終えたあとの確かめ: none（変更なし）/ changed（変えたが、そのあとテストを走らせていない）
-- / passed（変えたあとにテストが通った）/ failed（最後のテストが失敗した）
ALTER TABLE agent_sessions ADD COLUMN check_state text NOT NULL DEFAULT 'none'
  CHECK (check_state IN ('none', 'changed', 'passed', 'failed'));
ALTER TABLE agent_sessions ADD COLUMN checked_at timestamptz;

CREATE TABLE task_followups (
  id               uuid PRIMARY KEY,
  tenant_id        uuid NOT NULL REFERENCES tenants(id),
  user_id          uuid NOT NULL REFERENCES users(id),
  conversation_id  uuid NOT NULL REFERENCES conversations(id),
  after_task_id    uuid NOT NULL REFERENCES tasks(id),
  request          text NOT NULL CHECK (length(request) BETWEEN 1 AND 2000),
  -- waiting（前の仕事を待っている）/ started / skipped（前の仕事が終わらなかった）
  -- / held（保留中のものに触れる頼みだった）/ cancelled（本人が取り消した）
  status           text NOT NULL DEFAULT 'waiting'
                   CHECK (status IN ('waiting', 'started', 'skipped', 'held', 'cancelled')),
  started_task_id  uuid REFERENCES tasks(id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  decided_at       timestamptz
);
CREATE INDEX task_followups_waiting ON task_followups (tenant_id, after_task_id)
  WHERE status = 'waiting';
ALTER TABLE task_followups ENABLE ROW LEVEL SECURITY;
ALTER TABLE task_followups FORCE ROW LEVEL SECURITY;
CREATE POLICY task_followups_tenant_isolation ON task_followups
  USING (tenant_id = astra_current_tenant()) WITH CHECK (tenant_id = astra_current_tenant());

ALTER TABLE user_notices DROP CONSTRAINT user_notices_kind_check;
ALTER TABLE user_notices ADD CONSTRAINT user_notices_kind_check
  CHECK (kind IN ('reminder', 'scheduled_task', 'schedule_problem', 'agent_session', 'work_hold',
                  'task_followup'));

-- migrate:down
DELETE FROM user_notices WHERE kind IN ('work_hold', 'task_followup');
ALTER TABLE user_notices DROP CONSTRAINT user_notices_kind_check;
ALTER TABLE user_notices ADD CONSTRAINT user_notices_kind_check
  CHECK (kind IN ('reminder', 'scheduled_task', 'schedule_problem', 'agent_session'));
DROP TABLE IF EXISTS task_followups;
ALTER TABLE agent_sessions DROP COLUMN IF EXISTS checked_at;
ALTER TABLE agent_sessions DROP COLUMN IF EXISTS check_state;
ALTER TABLE agent_sessions DROP COLUMN IF EXISTS held_by;
DROP TABLE IF EXISTS work_holds;
