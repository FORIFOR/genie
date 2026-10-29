-- migrate:up
-- 家族のグループで、何人かと Genie が一緒に話す（「@Genie みんなで話そう」）。
-- グループの通話は、同じリンクで何人でも（6 人まで）入れる。頼みは共有スペース（買い物・TODO・家計簿・日程）だけに使い、
-- 使い始めた人の個人のもの（メール・予定・ファイル）には触れない。
ALTER TABLE call_sessions ADD COLUMN household_id uuid REFERENCES households(id);
ALTER TABLE call_sessions ADD COLUMN group_id text CHECK (group_id IS NULL OR length(group_id) BETWEEN 1 AND 128);

-- migrate:down
ALTER TABLE call_sessions DROP COLUMN IF EXISTS group_id;
ALTER TABLE call_sessions DROP COLUMN IF EXISTS household_id;
