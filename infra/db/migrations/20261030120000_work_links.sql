-- migrate:up
-- 仕事のホーム（LINE から開くページ、services/api-gateway/src/work-home.ts）を開くリンク。
-- 計画ボード（group_board_links）と同じく、サインインの代わりに 24 バイトの乱数で守る。残すのはハッシュだけ。
-- 本人 1 人のもの（グループのボードと違い、本人の仕事を映す）。30 日で切れる。

CREATE TABLE work_links (
  token_hash  text PRIMARY KEY,
  tenant_id   uuid NOT NULL REFERENCES tenants(id),
  user_id     uuid NOT NULL REFERENCES users(id),
  expires_at  timestamptz NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX work_links_user ON work_links (tenant_id, user_id);
ALTER TABLE work_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE work_links FORCE ROW LEVEL SECURITY;
CREATE POLICY work_links_tenant_isolation ON work_links
  USING (tenant_id = astra_current_tenant()) WITH CHECK (tenant_id = astra_current_tenant());

-- migrate:down
DROP TABLE IF EXISTS work_links;
