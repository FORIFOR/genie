-- migrate:up
-- グループは招かれた時点で使い始める（本人の設計 2026-10-28 改:「招待＝即利用開始、会話理解＝透明性のある設定、発言＝呼ばれたときだけ」）。
--
-- 一時停止を、会話の覚え方（context_mode）と分ける。止めて「再開」したら、止める前の覚え方に戻す。
-- 招かれた直後は mentions（呼ばれた発言だけを使い、会話は覚えない）。覚えるのは、グループで
-- 「@Genie 会話の文脈を使う」と決めて、そのことを全員に知らせてから。
ALTER TABLE households ADD COLUMN context_paused boolean NOT NULL DEFAULT false;
UPDATE households SET context_paused = true, context_mode = 'mentions' WHERE context_mode = 'paused';
ALTER TABLE households DROP CONSTRAINT IF EXISTS households_context_mode_check;
ALTER TABLE households ADD CONSTRAINT households_context_mode_check CHECK (context_mode IN ('context', 'mentions'));

-- migrate:down
ALTER TABLE households DROP CONSTRAINT IF EXISTS households_context_mode_check;
ALTER TABLE households ADD CONSTRAINT households_context_mode_check CHECK (context_mode IN ('context', 'mentions', 'paused'));
ALTER TABLE households DROP COLUMN context_paused;
