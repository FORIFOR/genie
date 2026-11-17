-- migrate:up
-- 議事録・貼った文・通話のまとめから拾った、予定とやることの候補（本人の設計 2026-11-05
-- 「Genie Schedule Intelligence」: 抽出は自動、登録は承認制、抽出元の証拠を必ず残す）。
--
-- 1 回の提案（batch）に番号つきで最大 8 件。本人が「1 と 2 を入れて」「全部入れて」と答えたものだけ、
-- やること（todos）か予定（カレンダーの確かめ）へ回す。答えなかった候補は pending のまま残り、提案から
-- 1 日たったら読まない（古い提案に「全部入れて」が効かないように）。
CREATE TABLE schedule_candidates (
  id              uuid PRIMARY KEY,
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  user_id         uuid NOT NULL REFERENCES users(id),
  conversation_id uuid NOT NULL REFERENCES conversations(id),
  batch_id        uuid NOT NULL,
  -- 提案の中の番号（1 から）
  position        integer NOT NULL CHECK (position BETWEEN 1 AND 20),
  kind            text NOT NULL CHECK (kind IN ('event', 'todo')),
  title           text NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  -- 予定: 始まり・終わり。やること: 締切の日
  start_at        timestamptz,
  end_at          timestamptz,
  due_date        date,
  -- どこから拾ったか（text: 本人が送った文 / call_minutes: 通話の議事録）
  source          text NOT NULL CHECK (source IN ('text', 'call_minutes')),
  -- 抽出元の文（そのまま）
  excerpt         text NOT NULL CHECK (length(excerpt) BETWEEN 1 AND 400),
  -- pending: まだ / added: 入れた（予定はカレンダーの確かめへ回した） / dismissed: いらない
  status          text NOT NULL CHECK (status IN ('pending', 'added', 'dismissed')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  decided_at      timestamptz,
  CHECK ((kind = 'event' AND start_at IS NOT NULL) OR (kind = 'todo' AND due_date IS NOT NULL)),
  UNIQUE (batch_id, position)
);
CREATE INDEX schedule_candidates_recent ON schedule_candidates (tenant_id, conversation_id, created_at DESC);
ALTER TABLE schedule_candidates ENABLE ROW LEVEL SECURITY;
ALTER TABLE schedule_candidates FORCE ROW LEVEL SECURITY;
CREATE POLICY schedule_candidates_tenant_isolation ON schedule_candidates
  USING (tenant_id = astra_current_tenant()) WITH CHECK (tenant_id = astra_current_tenant());

-- migrate:down
DROP TABLE IF EXISTS schedule_candidates;
