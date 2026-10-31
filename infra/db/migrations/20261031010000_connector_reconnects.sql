-- migrate:up
-- メール・予定の接続が切れたときの知らせと、LINE からのつなぎ直し（本人の方針 2026-10-31）。
-- トークンも認可コードも残さない。鍵は Mac のキーチェーンから出ない（認可コードもメモリで取り次ぐだけ）。
--
--   notified  … 提供者が更新を断ったことを本人に知らせた（同じ接続の指紋では 1 回だけ）
--   requested → ready → code → done / failed … 本人が頼んだつなぎ直しの段階
CREATE TABLE connector_reconnects (
  id            uuid PRIMARY KEY,
  tenant_id     uuid NOT NULL REFERENCES tenants(id),
  user_id       uuid NOT NULL REFERENCES users(id),
  provider      text NOT NULL CHECK (provider IN ('google', 'microsoft')),
  state         text NOT NULL CHECK (state IN ('notified', 'requested', 'ready', 'code', 'done', 'failed')),
  fingerprint   text CHECK (length(fingerprint) <= 128),
  token_hash    text CHECK (length(token_hash) = 64),
  -- Mac が作る認可の URL（PKCE の verifier は Mac から出ない）。終わったら消す
  authorize_url text CHECK (length(authorize_url) <= 4000),
  expires_at    timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX connector_reconnects_fingerprint
  ON connector_reconnects (tenant_id, user_id, provider, fingerprint) WHERE fingerprint IS NOT NULL;
CREATE UNIQUE INDEX connector_reconnects_token
  ON connector_reconnects (token_hash) WHERE token_hash IS NOT NULL;
CREATE INDEX connector_reconnects_open
  ON connector_reconnects (tenant_id, user_id) WHERE state IN ('requested', 'ready', 'code');
ALTER TABLE connector_reconnects ENABLE ROW LEVEL SECURITY;
ALTER TABLE connector_reconnects FORCE ROW LEVEL SECURITY;
CREATE POLICY connector_reconnects_tenant_isolation ON connector_reconnects
  USING (tenant_id = astra_current_tenant()) WITH CHECK (tenant_id = astra_current_tenant());

-- migrate:down
DROP TABLE IF EXISTS connector_reconnects;
