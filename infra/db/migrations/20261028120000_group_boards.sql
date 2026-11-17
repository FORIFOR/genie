-- migrate:up
-- Action Board（本人の戦略 2026-10-28「話すだけで、みんなの用事が片づく」の 02）。
-- LINE のグループの会話から作る、話題ごとの計画（いまは「お出かけ」= 場所探しと日程調整）。
--
--   group_boards        … グループに開いている計画は 1 つ。条件・候補・決まったことを state に持つ
--   group_board_links   … ボードを見るページのリンク（読むだけ。30 日。平文は返すだけ、残すのはハッシュ）
--   group_board_events  … 何が起きたか（Action Timeline の始まり）。誰がを残さない（LINE の名前・ID は入れない）
--
-- ページに出すのは、計画の名前・条件・候補（Google マップの公開情報）・決まったこと・人数の数だけ。
-- 発言の本文、参加者の名前、持ち主の個人の予定・メール・家計簿は出さない。
CREATE TABLE group_boards (
  id            uuid PRIMARY KEY,
  tenant_id     uuid NOT NULL REFERENCES tenants(id),
  household_id  uuid NOT NULL REFERENCES households(id),
  kind          text NOT NULL CHECK (kind IN ('outing')),
  title         text NOT NULL CHECK (length(title) BETWEEN 1 AND 80),
  status        text NOT NULL DEFAULT 'planning' CHECK (status IN ('planning', 'decided', 'closed')),
  state         jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX group_boards_open ON group_boards (tenant_id, household_id) WHERE status <> 'closed';
ALTER TABLE group_boards ENABLE ROW LEVEL SECURITY;
ALTER TABLE group_boards FORCE ROW LEVEL SECURITY;
CREATE POLICY group_boards_tenant_isolation ON group_boards
  USING (tenant_id = astra_current_tenant()) WITH CHECK (tenant_id = astra_current_tenant());

CREATE TABLE group_board_links (
  token_hash  text PRIMARY KEY,
  tenant_id   uuid NOT NULL REFERENCES tenants(id),
  board_id    uuid NOT NULL REFERENCES group_boards(id) ON DELETE CASCADE,
  expires_at  timestamptz NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE group_board_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE group_board_links FORCE ROW LEVEL SECURITY;
CREATE POLICY group_board_links_tenant_isolation ON group_board_links
  USING (tenant_id = astra_current_tenant()) WITH CHECK (tenant_id = astra_current_tenant());

CREATE TABLE group_board_events (
  id          uuid PRIMARY KEY,
  tenant_id   uuid NOT NULL REFERENCES tenants(id),
  board_id    uuid NOT NULL REFERENCES group_boards(id) ON DELETE CASCADE,
  kind        text NOT NULL CHECK (kind IN ('searched', 'chosen', 'decided', 'condition', 'opened', 'closed')),
  text        text NOT NULL CHECK (length(text) BETWEEN 1 AND 200),
  at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX group_board_events_board ON group_board_events (tenant_id, board_id, at);
ALTER TABLE group_board_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE group_board_events FORCE ROW LEVEL SECURITY;
CREATE POLICY group_board_events_tenant_isolation ON group_board_events
  USING (tenant_id = astra_current_tenant()) WITH CHECK (tenant_id = astra_current_tenant());

-- migrate:down
DROP TABLE IF EXISTS group_board_events;
DROP TABLE IF EXISTS group_board_links;
DROP TABLE IF EXISTS group_boards;
