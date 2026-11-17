-- migrate:up
-- 本人を待つことは失敗ではない（本人の方針 2026-10-30）。
--
--   waiting_human      … 本人の答えが要るので、作業を安全に止めて待っている。期限なく戻れる（仕事の寿命の範囲で）
--   waiting_dependency … 先の仕事を待っている。先の仕事が正常に終わったら自動で始まる（止まっても失敗にしない）
--
-- 時間は 3 つに分ける: 実際に動いた時間（elapsed_ms・上限 max_minutes）/ 本人を待った時間（human_wait_ms・上限なし）
-- / 仕事を作ってからの時間（created_at から・上限 max_lifetime_hours）

ALTER TABLE agent_jobs DROP CONSTRAINT agent_jobs_status_check;
ALTER TABLE agent_jobs ADD CONSTRAINT agent_jobs_status_check CHECK (status IN (
  'queued', 'running', 'waiting_user', 'waiting_human', 'waiting_dependency', 'verifying',
  'needs_review', 'done', 'stopped', 'held', 'cancelled', 'idle', 'ended'));
ALTER TABLE agent_jobs ADD COLUMN human_wait_ms bigint NOT NULL DEFAULT 0;
ALTER TABLE agent_jobs ADD COLUMN waiting_since timestamptz;
-- 止めたときに待っていた操作（秘密を伏せた写し。再開のときに、改めて聞く）
ALTER TABLE agent_jobs ADD COLUMN pending_approval text CHECK (length(pending_approval) <= 500);
ALTER TABLE agent_jobs ADD COLUMN max_lifetime_hours integer NOT NULL DEFAULT 168
  CHECK (max_lifetime_hours BETWEEN 1 AND 2160);

-- 先の仕事が止まっただけで止めていたものは、待ちに戻す
UPDATE agent_jobs SET status = 'waiting_dependency', stop_reason = NULL, finished_at = NULL
  WHERE status = 'stopped' AND stop_reason = 'dependency_stopped';

-- migrate:down
UPDATE agent_jobs SET status = 'queued' WHERE status IN ('waiting_human', 'waiting_dependency');
ALTER TABLE agent_jobs DROP COLUMN max_lifetime_hours;
ALTER TABLE agent_jobs DROP COLUMN pending_approval;
ALTER TABLE agent_jobs DROP COLUMN waiting_since;
ALTER TABLE agent_jobs DROP COLUMN human_wait_ms;
ALTER TABLE agent_jobs DROP CONSTRAINT agent_jobs_status_check;
ALTER TABLE agent_jobs ADD CONSTRAINT agent_jobs_status_check CHECK (status IN (
  'queued', 'running', 'waiting_user', 'verifying', 'needs_review', 'done', 'stopped', 'held',
  'cancelled', 'idle', 'ended'));
