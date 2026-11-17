-- migrate:up
-- Oathra 経由の電話の接続。**利用者ごとに 1 つ。**
--
-- 接続は Oathra の所有者が発行した委任（grant）で、相手・回数・金額・期限は Oathra 側が決める。
-- Genie が持つのはその資格情報だけで、トークンは暗号化して置く（GENIE_SECRET_KEY）。
CREATE TABLE phone_connections (
  id               uuid PRIMARY KEY,
  tenant_id        uuid NOT NULL REFERENCES tenants(id),
  user_id          uuid NOT NULL REFERENCES users(id),
  -- Oathra Gateway の origin（https、開発時だけ loopback の http）
  base_url         text NOT NULL CHECK (length(base_url) BETWEEN 1 AND 512),
  grant_id         text NOT NULL CHECK (length(grant_id) BETWEEN 1 AND 128),
  -- 版つきの封筒（`v1:<key id>:<iv>:<tag>:<ciphertext>`）。平文のトークンは置かない
  token_ciphertext text NOT NULL CHECK (length(token_ciphertext) BETWEEN 1 AND 4096),
  created_at       timestamptz NOT NULL DEFAULT now(),
  revoked_at       timestamptz
);
-- 有効な接続は 1 人に 1 つ。繋ぎ直すときは古いものを切ってから作る
CREATE UNIQUE INDEX phone_connections_active_user
  ON phone_connections (tenant_id, user_id) WHERE revoked_at IS NULL;
ALTER TABLE phone_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE phone_connections FORCE ROW LEVEL SECURITY;
CREATE POLICY phone_connections_tenant_isolation ON phone_connections
  USING (tenant_id = astra_current_tenant()) WITH CHECK (tenant_id = astra_current_tenant());
COMMENT ON TABLE phone_connections IS
  '着信の取り込みは「だれが繋いでいるか」だけを astra_identity で引く（bootstrap.sql で列を限って SELECT）。トークンは withTenant でしか読まない';

-- migrate:down
DROP TABLE IF EXISTS phone_connections;
