-- migrate:up
-- チャネル連携（Slack / LINE）の Phase 1。連携コードと、受信時に要る最小の権限。
--
-- 連携は本人が Genie の中で発行したコードを、チャットで Bot に送ったときだけ結ぶ（推測で結ばない）。
-- コードは 10 分・1 回だけ。平文は持たず、ハッシュだけを置く。

CREATE TABLE channel_link_codes (
  code_hash  text PRIMARY KEY CHECK (length(code_hash) = 64),
  tenant_id  uuid NOT NULL REFERENCES tenants(id),
  user_id    uuid NOT NULL REFERENCES users(id),
  provider   text NOT NULL CHECK (provider IN ('slack','line')),
  expires_at timestamptz NOT NULL,
  used_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX channel_link_codes_by_user ON channel_link_codes (tenant_id, user_id);
ALTER TABLE channel_link_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE channel_link_codes FORCE ROW LEVEL SECURITY;
CREATE POLICY channel_link_codes_tenant_isolation ON channel_link_codes
  USING (tenant_id = astra_current_tenant()) WITH CHECK (tenant_id = astra_current_tenant());
COMMENT ON TABLE channel_link_codes IS
  'コードを受けた時点ではテナントが分からないので、引き換えは astra_identity（bootstrap.sql で SELECT/UPDATE のみ）で行う';

-- migrate:down
DROP TABLE IF EXISTS channel_link_codes;
