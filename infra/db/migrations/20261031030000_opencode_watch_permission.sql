-- migrate:up
-- opencode の承認に LINE から答える（本人の方針 2026-10-31）。
-- 本人に見せた承認の id。答えはこの id にだけ送る（見せていない別の承認を通さないため）。
ALTER TABLE opencode_watches ADD COLUMN waiting_permission_id text CHECK (length(waiting_permission_id) <= 128);

-- migrate:down
ALTER TABLE opencode_watches DROP COLUMN waiting_permission_id;
