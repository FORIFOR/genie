-- migrate:up
-- opencode の承認をすべて自動で許可し、LINE へ記録としてまとめて送る（本人の方針 2026-10-31）。
-- 本人が LINE で頼んだ見守りだけ。approval_log は送るまでの間だけ持ち、送ったら空にする。
ALTER TABLE opencode_watches ADD COLUMN auto_approve boolean NOT NULL DEFAULT false;
ALTER TABLE opencode_watches ADD COLUMN approval_log text[] NOT NULL DEFAULT '{}';

-- migrate:down
ALTER TABLE opencode_watches DROP COLUMN approval_log;
ALTER TABLE opencode_watches DROP COLUMN auto_approve;
