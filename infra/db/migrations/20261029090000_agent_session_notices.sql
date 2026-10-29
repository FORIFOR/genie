-- migrate:up
-- ほかの AI に頼んだ仕事の知らせ（Agent Orchestration の第 3 段、2026-10-29）。
--
--   返事が要る（承認・質問・失敗）状態が 1 分続いた / 作業中のまま 15 分届かない
--   → Mac の通知（user_notices）と、つないでいればチャットへ 1 回だけ知らせる
--
-- 見回りは check_after が来た行だけを見る（出来事が届くたびに gateway が決め直す）。
-- 同じ待ちを二度知らせないよう、知らせた待ちの印（notified_key）を残す。本人が止めたセッションは知らせない。

-- いまの state（と待ちの理由）になった時刻。同じ待ちに出来事が重ねて届いても動かさない
ALTER TABLE agent_sessions ADD COLUMN state_since timestamptz NOT NULL DEFAULT now();
-- 見回りが次に見る時刻。null は見なくてよい（待機・終わり・止めた）
ALTER TABLE agent_sessions ADD COLUMN check_after timestamptz;
-- 最後に知らせた待ちの印（attention と、その待ちが始まった時刻）
ALTER TABLE agent_sessions ADD COLUMN notified_key text CHECK (length(notified_key) <= 80);
CREATE INDEX agent_sessions_due ON agent_sessions (check_after) WHERE check_after IS NOT NULL;

ALTER TABLE user_notices DROP CONSTRAINT user_notices_kind_check;
ALTER TABLE user_notices ADD CONSTRAINT user_notices_kind_check
  CHECK (kind IN ('reminder', 'scheduled_task', 'schedule_problem', 'agent_session'));

-- migrate:down
DELETE FROM user_notices WHERE kind = 'agent_session';
ALTER TABLE user_notices DROP CONSTRAINT user_notices_kind_check;
ALTER TABLE user_notices ADD CONSTRAINT user_notices_kind_check
  CHECK (kind IN ('reminder', 'scheduled_task', 'schedule_problem'));
DROP INDEX IF EXISTS agent_sessions_due;
ALTER TABLE agent_sessions DROP COLUMN IF EXISTS notified_key;
ALTER TABLE agent_sessions DROP COLUMN IF EXISTS check_after;
ALTER TABLE agent_sessions DROP COLUMN IF EXISTS state_since;
