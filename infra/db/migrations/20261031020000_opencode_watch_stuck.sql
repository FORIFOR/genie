-- migrate:up
-- opencode の見守り: 「作業中」のまま進まないセッションを見分ける（本人の方針 2026-10-31、pip install で 19 時間止まっていた）。
-- last_activity は最後の返答の id・部品の数・最後の部品の状態だけ。本文は残さない。
ALTER TABLE opencode_watches ADD COLUMN last_activity text CHECK (length(last_activity) <= 200);
ALTER TABLE opencode_watches ADD COLUMN last_activity_at timestamptz;
ALTER TABLE opencode_watches ADD COLUMN stuck_notified boolean NOT NULL DEFAULT false;
ALTER TABLE opencode_watches ADD COLUMN stuck_aborts integer NOT NULL DEFAULT 0;

-- migrate:down
ALTER TABLE opencode_watches DROP COLUMN stuck_aborts;
ALTER TABLE opencode_watches DROP COLUMN stuck_notified;
ALTER TABLE opencode_watches DROP COLUMN last_activity_at;
ALTER TABLE opencode_watches DROP COLUMN last_activity;
