-- migrate:up
-- Genie から電話する（予約の「電話で起こして」）。出たら最初に Genie が話す用件。
ALTER TABLE call_sessions ADD COLUMN opening text CHECK (opening IS NULL OR length(opening) <= 1000);

-- migrate:down
ALTER TABLE call_sessions DROP COLUMN IF EXISTS opening;
